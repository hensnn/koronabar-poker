import { randomInt } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  DEFAULT_POLL_CONFIG,
  EVERYONE,
  matches,
  resolveTie,
  t,
  tally,
  validateAnswer,
  validateConfig,
  validatePollCondition,
  validatePollAction,
  weightOf,
  type PollAction,
  type PollActionKind,
  type Answer,
  type Ballot,
  type PermissionChecker,
  type PlayerProfile,
  type PollCondition,
  type PollConfig,
  type PollOption,
  type PollResult,
  type SettingValues,
  type Voter,
} from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';
import { collectDays, type ProfileBuilder } from './poll-profiles.js';

export type PollErrorCode = 'DISABLED' | 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'LIMIT' | 'CLOSED' | 'NOT_ELIGIBLE' | 'ALREADY_VOTED' | 'LOCKED' | 'BAD_ANSWER' | 'NOT_TIED';

export class PollError extends Error {
  constructor(
    public code: PollErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export interface PollInput {
  title: string;
  description?: string;
  config: Omit<Partial<PollConfig>, 'options'> & { type: PollConfig['type']; options?: { id?: string; label: string; emoji?: string; image?: string; at?: number; value?: string }[] };
  condition?: unknown;
  eligibility?: 'fixed' | 'live';
  target?: { kind: 'global' | 'channel' | 'table'; id?: string };
  durationMinutes?: number;
  results?: 'always' | 'afterVote' | 'afterClose';
  pinned?: boolean;
  action?: { kind: PollActionKind; requireConfirm?: boolean; params?: Record<string, unknown> } | null;
}

type Row = typeof schema.polls.$inferSelect;
const DAY_MS = 86_400_000;
const num = (s: SettingValues, k: string) => Number(s[k] ?? 0);

/**
 * Ankety a hlasování. Okruh hlasujících se zafixuje při spuštění, nebo se vyhodnocuje průběžně; tajné ankety
 * ukládají jen, že hráč hlasoval, a anonymní lístky bez odkazu na hráče. Pravidla nejdou po prvním hlasu měnit.
 */
export class PollService {
  constructor(
    private deps: {
      db: Db;
      perms: PermissionChecker;
      audit: AuditService;
      settings: () => SettingValues;
      now: () => number;
      profiles: ProfileBuilder;
      nickOf: (userId: string) => Promise<string>;
      notify: (userId: string, kind: string, params: Record<string, unknown>, link: string) => Promise<void>;
      push: (userIds: string[], title: string, body: string, url: string, tag: string) => Promise<void>;
      /** Zpráva do chatu kanálu ankety (karta s odkazem). */
      announce: (target: { kind: string; id: string | null }, text: string) => Promise<void>;
      /** Smí uživatel psát do cílového kanálu / stolu. */
      canTarget: (userId: string, target: { kind: string; id: string | null }) => Promise<boolean>;
      emit: (id: string) => void;
      /** Nová anketa (napojení ven). */
      onCreated?: (title: string) => void;
      /** Provede akci navázanou na anketu jménem zakladatele (v rozsahu jeho oprávnění). Vrací id vytvořeného objektu. */
      runAction?: (kind: PollActionKind, actorId: string, params: Record<string, unknown>, winner: PollOption | null) => Promise<{ createdId?: string }>;
      rng?: () => number;
      /** Stav turnaje pro hlasování o pauze (hráči, kteří ještě hrají); null = turnaj neexistuje. */
      tournamentInfo?: (id: string) => { name: string; status: string; paused: boolean; alive: string[] } | null;
    },
  ) {}

  private get s(): SettingValues {
    return this.deps.settings();
  }

  private can(userId: string, key: string): boolean {
    return this.deps.perms.can(userId, key).allowed;
  }

  private enabled(): void {
    if (!this.s['poll.enabled']) throw new PollError('DISABLED');
  }

  // ---------- okruh hlasujících ----------

  private async computeVoters(condition: PollCondition): Promise<{ voters: Voter[]; profiles: PlayerProfile[] }> {
    const ids = await this.deps.profiles.activeUserIds();
    const profiles = await this.deps.profiles.build(ids, [...collectDays(condition)]);
    const ok = profiles.filter((p) => matches(condition, p));
    return { voters: [], profiles: ok };
  }

  private weightFor(config: PollConfig, p: PlayerProfile): number {
    const w = config.weights;
    const roleWeights = p.roleKeys.length ? p.roleKeys.map((k) => weightOf(w, { roleKey: k, level: p.level, rating: p.ratingTournament?.value ?? null, stack: null })) : [weightOf(w, { level: p.level, rating: p.ratingTournament?.value ?? null, stack: null })];
    const best = Math.max(...roleWeights);
    // žeton u stolu neznáme mimo hru: váha podle stacku se pak chová jako rovná
    return w.mode === 'byStack' ? Math.min(w.cap ?? 1, 1) : best;
  }

  private toVoters(config: PollConfig, profiles: PlayerProfile[]): Voter[] {
    return profiles.map((p) => ({ userId: p.userId, weight: this.weightFor(config, p), power: p.maxPower }));
  }

  private async eligibleOf(poll: Row): Promise<Voter[]> {
    if (poll.eligibility === 'fixed' && poll.voters) return poll.voters;
    const { profiles } = await this.computeVoters(poll.condition as unknown as PollCondition);
    return this.toVoters(poll.config as unknown as PollConfig, profiles);
  }

  /** Živý náhled v editoru: kteří hráči teď podmínky splňují. */
  async preview(userId: string, condition: unknown): Promise<{ count: number; players: { userId: string; nickname: string }[] }> {
    this.enabled();
    if (!this.can(userId, 'anketa.vytvorit')) throw new PollError('FORBIDDEN');
    const v = validatePollCondition(condition ?? EVERYONE);
    if (!v.ok) throw new PollError('INVALID', { field: 'condition' });
    const { profiles } = await this.computeVoters(v.condition);
    const nicks = new Map(profiles.length ? (await this.deps.db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, profiles.map((p) => p.userId)))).map((u) => [u.id, u.n]) : []);
    return { count: profiles.length, players: profiles.slice(0, 100).map((p) => ({ userId: p.userId, nickname: nicks.get(p.userId) ?? '?' })) };
  }

  // ---------- zakládání ----------

  /**
   * `trusted`: anketu vytváří server sám (hlasování o pauze). Obejde oprávnění k akcím a kontrolu cíle, protože
   * o akci rozhodují hlasující. Z veřejného rozhraní se nikdy nenastavuje.
   */
  async create(userId: string, input: PollInput, opts: { trusted?: boolean } = {}): Promise<string> {
    this.enabled();
    if (!opts.trusted && !this.can(userId, 'anketa.vytvorit')) throw new PollError('FORBIDDEN');
    if (!opts.trusted && input.action && !this.can(userId, 'anketa.akce')) throw new PollError('FORBIDDEN');
    if (!opts.trusted && input.action?.params && 'byVote' in input.action.params) throw new PollError('INVALID', { field: 'action' });
    const s = this.s;
    const title = (input.title ?? '').trim();
    if (!title || title.length > 120) throw new PollError('INVALID', { field: 'title' });
    const description = (input.description ?? '').trim();
    if (description.length > 1000) throw new PollError('INVALID', { field: 'description' });

    const open = (await this.deps.db.select({ id: schema.polls.id }).from(schema.polls).where(and(eq(schema.polls.founderId, userId), inArray(schema.polls.status, ['open', 'tie'])))).length;
    if (open >= num(s, 'poll.maxOpenPerUser')) throw new PollError('LIMIT', { max: num(s, 'poll.maxOpenPerUser') });

    const options: PollOption[] = (input.config.options ?? []).map((o, i) => ({ id: o.id?.trim() || `o${i + 1}`, label: (o.label ?? '').trim(), ...(o.emoji ? { emoji: o.emoji.slice(0, 8) } : {}), ...(o.image ? { image: o.image.slice(0, 300) } : {}), ...(typeof o.at === 'number' ? { at: o.at } : {}), ...(o.value ? { value: o.value.slice(0, 200) } : {}) }));
    const config: PollConfig = {
      ...DEFAULT_POLL_CONFIG,
      threshold: { kind: String(s['poll.defaultThreshold']) as PollConfig['threshold']['kind'] },
      anonymity: String(s['poll.defaultAnonymity']) as PollConfig['anonymity'],
      nonVoters: String(s['poll.defaultNonVoters']) as PollConfig['nonVoters'],
      tie: String(s['poll.defaultTie']) as PollConfig['tie'],
      allowChange: !!s['poll.defaultAllowChange'],
      ...input.config,
      options,
    };
    if (config.anonymity === 'secret') config.allowChange = false; // u tajné ankety se hlas nedá dohledat, tedy ani změnit
    const issue = validateConfig(config);
    if (issue) throw new PollError('INVALID', { field: issue });

    const cond = validatePollCondition(input.condition ?? EVERYONE);
    if (!cond.ok) throw new PollError('INVALID', { field: 'condition' });
    let action: PollAction | null = null;
    if (input.action) {
      const v = validatePollAction(input.action, config);
      if (!v.ok) throw new PollError('INVALID', { field: 'action', issue: v.issue });
      action = v.action;
    }
    const minutes = Math.round(input.durationMinutes ?? num(s, 'poll.defaultDurationMinutes'));
    if (!Number.isFinite(minutes) || minutes < (opts.trusted ? 1 : num(s, 'poll.minDurationMinutes')) || minutes > num(s, 'poll.maxDurationDays') * 1440) throw new PollError('INVALID', { field: 'duration' });
    const eligibility = input.eligibility ?? (String(s['poll.defaultEligibility']) as 'fixed' | 'live');
    const results = input.results ?? (String(s['poll.defaultResults']) as 'always' | 'afterVote' | 'afterClose');
    const target = input.target ?? { kind: 'global' };
    if (target.kind !== 'global' && (!target.id || (!opts.trusted && !(await this.deps.canTarget(userId, { kind: target.kind, id: target.id }))))) throw new PollError('FORBIDDEN');

    const { profiles } = await this.computeVoters(cond.condition);
    if (profiles.length === 0) throw new PollError('INVALID', { field: 'condition' });
    const voters = this.toVoters(config, profiles);
    const now = this.deps.now();
    const [row] = await this.deps.db
      .insert(schema.polls)
      .values({
        founderId: userId,
        title,
        description,
        config: config as unknown as Record<string, unknown>,
        condition: cond.condition as unknown as Record<string, unknown>,
        eligibility,
        voters: eligibility === 'fixed' ? voters : null,
        targetKind: target.kind,
        targetId: target.id ?? null,
        results,
        pinned: !!input.pinned,
        startsAt: new Date(now),
        endsAt: new Date(now + minutes * 60_000),
        action: action as unknown as Record<string, unknown> | null,
      })
      .returning({ id: schema.polls.id });
    const id = row!.id;
    await this.deps.audit.log({ actorId: userId, action: 'anketa.vytvorena', targetType: 'poll', targetId: id, after: { title, type: config.type, eligibility, voters: voters.length } });
    void this.announceOpen(id, title, userId, target, voters).catch(() => undefined);
    this.deps.emit(id);
    if (!opts.trusted) this.deps.onCreated?.(title);
    return id;
  }

  /**
   * Hráč, který v běžícím turnaji ještě hraje, navrhne pauzu: vznikne krátká ano/ne anketa jen pro tyto hráče
   * a při souhlasu se turnaj sám pozastaví. Je omezená nastavením (zapnutí, délka, práh, pauza mezi návrhy).
   */
  async startPauseVote(userId: string, tournamentId: string): Promise<string> {
    this.enabled();
    const s = this.s;
    if (!s['poll.pauseVoteEnabled']) throw new PollError('DISABLED');
    const info = this.deps.tournamentInfo?.(tournamentId);
    if (!info) throw new PollError('NOT_FOUND');
    if (info.status !== 'running' || info.paused || !info.alive.includes(userId)) throw new PollError('NOT_ELIGIBLE');
    const recent = await this.deps.db
      .select({ status: schema.polls.status, createdAt: schema.polls.createdAt })
      .from(schema.polls)
      .where(and(eq(schema.polls.targetKind, 'table'), eq(schema.polls.targetId, tournamentId), sql`${schema.polls.action}->>'kind' = 'pauseGame'`))
      .orderBy(desc(schema.polls.createdAt))
      .limit(1);
    const last = recent[0];
    if (last && (last.status === 'open' || last.status === 'tie')) throw new PollError('LIMIT', { reason: 'running' });
    const cooldown = num(s, 'poll.pauseVoteCooldownMinutes') * 60_000;
    if (last && cooldown > 0 && this.deps.now() - last.createdAt.getTime() < cooldown) throw new PollError('LIMIT', { reason: 'cooldown' });
    return this.create(
      userId,
      {
        title: t('polls.pauseVoteTitle', { name: info.name }),
        description: t('polls.pauseVoteDescription'),
        config: { type: 'yesno', threshold: { kind: String(s['poll.pauseVoteThreshold']) as PollConfig['threshold']['kind'] }, tie: 'random', anonymity: 'public', nonVoters: 'ignore', allowChange: true, earlyClose: true },
        condition: { type: 'inTournament', id: tournamentId, aliveOnly: true },
        eligibility: 'fixed',
        target: { kind: 'table', id: tournamentId },
        durationMinutes: num(s, 'poll.pauseVoteMinutes'),
        results: 'always',
        action: { kind: 'pauseGame', requireConfirm: false, params: { tournamentId, byVote: true } },
      },
      { trusted: true },
    );
  }

  private async announceOpen(id: string, title: string, founder: string, target: { kind: string; id?: string }, voters: Voter[]): Promise<void> {
    await this.deps.announce({ kind: target.kind, id: target.id ?? null }, t('chat.sys.pollOpen', { name: title, card: `{{anketa:${id}}}` }));
    if (!this.s['poll.notify']) return;
    const targets = voters.map((v) => v.userId).filter((u) => u !== founder).slice(0, num(this.s, 'poll.maxNotified'));
    for (const u of targets) await this.deps.notify(u, 'poll', { name: title }, `/ankety/${id}`);
    if (this.s['poll.pushNotify']) await this.deps.push(targets, t('notice.poll.event'), t('notice.poll.text', { name: title }), `/ankety/${id}`, `poll-${id}`);
  }

  // ---------- načtení a hlasy ----------

  private async load(id: string): Promise<Row> {
    const [r] = await this.deps.db.select().from(schema.polls).where(eq(schema.polls.id, id));
    if (!r) throw new PollError('NOT_FOUND');
    return r;
  }

  private isManager(userId: string, poll: Row): boolean {
    return poll.founderId === userId || this.can(userId, 'anketa.spravovat');
  }

  private cfg(poll: Row): PollConfig {
    return poll.config as unknown as PollConfig;
  }

  private async votesOf(poll: Row) {
    return this.deps.db.select().from(schema.pollVotes).where(eq(schema.pollVotes.pollId, poll.id));
  }

  /** Spočítá aktuální výsledek. U tajných anket se hlasy berou z anonymních lístků bez vazby na hráče. */
  private async compute(poll: Row, closed: boolean): Promise<{ result: PollResult; eligible: Voter[]; ballots: Ballot[]; votedIds: Set<string> }> {
    const config = this.cfg(poll);
    const eligible = await this.eligibleOf(poll);
    const votes = await this.votesOf(poll);
    const votedIds = new Set(votes.map((v) => v.userId));
    let ballots: Ballot[];
    let voters = eligible;
    if (config.anonymity === 'secret') {
      const bag = await this.deps.db.select().from(schema.pollSecretBallots).where(eq(schema.pollSecretBallots.pollId, poll.id));
      const synthetic = bag.map((b) => ({ userId: `s${b.id}`, weight: b.weight }));
      voters = [...eligible.filter((v) => !votedIds.has(v.userId)), ...synthetic];
      ballots = bag.map((b) => ({ userId: `s${b.id}`, answer: b.answer as unknown as Answer }));
    } else {
      ballots = votes.filter((v) => v.answer).map((v) => ({ userId: v.userId, answer: v.answer as unknown as Answer }));
    }
    return { result: tally(config, voters, ballots, closed), eligible, ballots, votedIds };
  }

  async vote(userId: string, pollId: string, answer: Answer): Promise<void> {
    this.enabled();
    const poll = await this.load(pollId);
    if (poll.status !== 'open') throw new PollError('CLOSED');
    if (this.deps.now() >= poll.endsAt.getTime()) {
      await this.closeInternal(poll);
      throw new PollError('CLOSED');
    }
    const config = this.cfg(poll);
    const me = (await this.eligibleOf(poll)).find((v) => v.userId === userId);
    if (!me) throw new PollError('NOT_ELIGIBLE');
    if (validateAnswer(config, answer) !== null) throw new PollError('BAD_ANSWER');
    const [existing] = await this.deps.db.select().from(schema.pollVotes).where(and(eq(schema.pollVotes.pollId, pollId), eq(schema.pollVotes.userId, userId)));
    if (existing && (!config.allowChange || config.anonymity === 'secret')) throw new PollError('ALREADY_VOTED');
    const now = new Date(this.deps.now());
    const secret = config.anonymity === 'secret';
    await this.deps.db.transaction(async (trx) => {
      await trx
        .insert(schema.pollVotes)
        .values({ pollId, userId, answer: secret ? null : (answer as unknown as Record<string, unknown>), weight: me.weight, updatedAt: now })
        .onConflictDoUpdate({ target: [schema.pollVotes.pollId, schema.pollVotes.userId], set: { answer: secret ? null : (answer as unknown as Record<string, unknown>), weight: me.weight, updatedAt: now } });
      if (secret) await trx.insert(schema.pollSecretBallots).values({ pollId, answer: answer as unknown as Record<string, unknown>, weight: me.weight });
    });
    const { result } = await this.compute(poll, false);
    if (result.final) await this.closeInternal(poll);
    this.deps.emit(pollId);
  }

  async addOption(userId: string, pollId: string, label: string, emoji?: string): Promise<string> {
    this.enabled();
    const poll = await this.load(pollId);
    const config = this.cfg(poll);
    if (poll.status !== 'open') throw new PollError('CLOSED');
    if (!config.allowAddOptions) throw new PollError('FORBIDDEN');
    if (!(await this.eligibleOf(poll)).some((v) => v.userId === userId)) throw new PollError('NOT_ELIGIBLE');
    const text = label.trim();
    if (!text || text.length > 120 || config.options.length >= 30) throw new PollError('INVALID', { field: 'options' });
    const id = `u${config.options.length + 1}`;
    const next = { ...config, options: [...config.options, { id, label: text, ...(emoji ? { emoji: emoji.slice(0, 8) } : {}), addedBy: userId }] };
    await this.deps.db.update(schema.polls).set({ config: next as unknown as Record<string, unknown> }).where(eq(schema.polls.id, pollId));
    this.deps.emit(pollId);
    return id;
  }

  // ---------- zobrazení ----------

  private resultVisible(poll: Row, voted: boolean): boolean {
    if (poll.status === 'closed' || poll.status === 'tie') return true;
    if (poll.results === 'always') return true;
    return poll.results === 'afterVote' && voted;
  }

  async view(userId: string, pollId: string) {
    this.enabled();
    const poll = await this.load(pollId);
    const config = this.cfg(poll);
    const manager = this.isManager(userId, poll);
    const computed = await this.compute(poll, poll.status !== 'open');
    const { eligible, votedIds } = computed;
    // uzavřená anketa ukazuje uložený výsledek (včetně rozhodnutí remízy), ne nový výpočet
    const result = (poll.status === 'closed' && poll.result ? { ...computed.result, ...(poll.result as object) } : computed.result) as PollResult;
    const mine = eligible.find((v) => v.userId === userId);
    if (!mine && !manager && !votedIds.has(userId) && poll.targetKind === 'global' && poll.eligibility === 'fixed') throw new PollError('FORBIDDEN');
    const [myVote] = await this.deps.db.select().from(schema.pollVotes).where(and(eq(schema.pollVotes.pollId, pollId), eq(schema.pollVotes.userId, userId)));
    const voted = !!myVote;
    const visible = this.resultVisible(poll, voted);
    let voterList: { nickname: string; answer: unknown }[] | null = null;
    if (visible && config.anonymity === 'public') {
      const votes = (await this.votesOf(poll)).filter((v) => v.answer);
      const nicks = new Map(votes.length ? (await this.deps.db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, votes.map((v) => v.userId)))).map((u) => [u.id, u.n]) : []);
      voterList = votes.map((v) => ({ nickname: nicks.get(v.userId) ?? '?', answer: v.answer }));
    }
    const founderNick = poll.founderId ? await this.deps.nickOf(poll.founderId) : null;
    return {
      id: poll.id,
      title: poll.title,
      description: poll.description,
      type: config.type,
      options: config.options,
      minChoices: config.minChoices ?? null,
      maxChoices: config.maxChoices ?? null,
      ratingMax: config.ratingMax ?? null,
      allowAddOptions: !!config.allowAddOptions,
      allowChange: config.allowChange,
      anonymity: config.anonymity,
      threshold: config.threshold,
      quorum: config.quorum,
      nonVoters: config.nonVoters,
      tie: config.tie,
      weights: config.weights.mode,
      eligibility: poll.eligibility,
      status: poll.status,
      resultsMode: poll.results,
      pinned: poll.pinned,
      target: { kind: poll.targetKind, id: poll.targetId },
      startsAt: poll.startsAt.getTime(),
      endsAt: poll.endsAt.getTime(),
      founder: poll.founderId ? { id: poll.founderId, nickname: founderNick } : null,
      eligibleCount: eligible.length,
      votedCount: result.voted,
      canVote: poll.status === 'open' && !!mine && (!voted || (config.allowChange && config.anonymity !== 'secret')),
      voted,
      myAnswer: voted && config.anonymity !== 'secret' ? myVote!.answer : null,
      manager,
      tiePending: poll.status === 'tie' ? ((poll.result as { tied?: string[] } | null)?.tied ?? []) : [],
      condition: manager ? poll.condition : null,
      action: this.actionView(poll, manager),
      canConfirm: !!poll.action && (poll.action as unknown as PollAction).state === 'pendingConfirm' && this.can(userId, 'anketa.akce'),
      result: visible ? result : null,
      voters: voterList,
    };
  }

  /** Seznam anket, ke kterým má uživatel přístup: otevřené, jeho vlastní nebo archiv uzavřených. */
  async list(userId: string, scope: 'open' | 'closed' | 'mine') {
    this.enabled();
    const rows = await this.deps.db
      .select()
      .from(schema.polls)
      .where(scope === 'open' ? inArray(schema.polls.status, ['open', 'tie']) : scope === 'closed' ? inArray(schema.polls.status, ['closed', 'cancelled']) : eq(schema.polls.founderId, userId))
      .orderBy(desc(schema.polls.createdAt))
      .limit(60);
    const out = [];
    for (const poll of rows) {
      const manager = this.isManager(userId, poll);
      const eligible = await this.eligibleOf(poll);
      const mine = eligible.some((v) => v.userId === userId);
      const [myVote] = await this.deps.db.select().from(schema.pollVotes).where(and(eq(schema.pollVotes.pollId, poll.id), eq(schema.pollVotes.userId, userId)));
      if (!mine && !manager && !myVote) continue;
      const result = poll.result as { outcome?: string; summary?: string } | null;
      out.push({
        id: poll.id,
        title: poll.title,
        type: this.cfg(poll).type,
        status: poll.status,
        endsAt: poll.endsAt.getTime(),
        pinned: poll.pinned,
        target: { kind: poll.targetKind, id: poll.targetId },
        founderId: poll.founderId,
        voted: !!myVote,
        canVote: poll.status === 'open' && mine && !myVote,
        outcome: result?.outcome ?? null,
        summary: result?.summary ?? null,
      });
    }
    return out;
  }

  // ---------- správa ----------

  async close(userId: string, pollId: string): Promise<void> {
    const poll = await this.load(pollId);
    if (!this.isManager(userId, poll)) throw new PollError('FORBIDDEN');
    if (poll.status !== 'open') throw new PollError('CLOSED');
    await this.deps.audit.log({ actorId: userId, action: 'anketa.ukoncena_predcasne', targetType: 'poll', targetId: pollId });
    await this.closeInternal(poll);
  }

  async cancel(userId: string, pollId: string): Promise<void> {
    const poll = await this.load(pollId);
    if (!this.isManager(userId, poll)) throw new PollError('FORBIDDEN');
    if (poll.status !== 'open' && poll.status !== 'tie') throw new PollError('CLOSED');
    await this.deps.db.update(schema.polls).set({ status: 'cancelled', closedAt: new Date(this.deps.now()) }).where(eq(schema.polls.id, pollId));
    await this.deps.audit.log({ actorId: userId, action: 'anketa.zrusena', targetType: 'poll', targetId: pollId });
    this.deps.emit(pollId);
  }

  async extend(userId: string, pollId: string, minutes: number): Promise<void> {
    const poll = await this.load(pollId);
    if (!this.isManager(userId, poll)) throw new PollError('FORBIDDEN');
    if (poll.status !== 'open') throw new PollError('CLOSED');
    const max = poll.startsAt.getTime() + num(this.s, 'poll.maxDurationDays') * DAY_MS;
    const next = poll.endsAt.getTime() + Math.round(minutes) * 60_000;
    if (!Number.isFinite(minutes) || minutes < 1 || next > max) throw new PollError('INVALID', { field: 'duration' });
    await this.deps.db.update(schema.polls).set({ endsAt: new Date(next), reminded: false }).where(eq(schema.polls.id, pollId));
    await this.deps.audit.log({ actorId: userId, action: 'anketa.prodlouzena', targetType: 'poll', targetId: pollId, after: { minutes } });
    this.deps.emit(pollId);
  }

  /** Úprava pravidel je možná jen do prvního hlasu. */
  async update(userId: string, pollId: string, patch: { title?: string; description?: string; config?: Partial<PollConfig>; condition?: unknown }): Promise<void> {
    const poll = await this.load(pollId);
    if (!this.isManager(userId, poll)) throw new PollError('FORBIDDEN');
    if (poll.status !== 'open') throw new PollError('CLOSED');
    const [anyVote] = await this.deps.db.select({ n: sql<number>`count(*)::int` }).from(schema.pollVotes).where(eq(schema.pollVotes.pollId, pollId));
    if ((anyVote?.n ?? 0) > 0) throw new PollError('LOCKED');
    const set: Partial<typeof schema.polls.$inferInsert> = {};
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title || title.length > 120) throw new PollError('INVALID', { field: 'title' });
      set.title = title;
    }
    if (patch.description !== undefined) set.description = patch.description.trim().slice(0, 1000);
    let config = this.cfg(poll);
    if (patch.config) {
      config = { ...config, ...patch.config };
      if (config.anonymity === 'secret') config.allowChange = false;
      const issue = validateConfig(config);
      if (issue) throw new PollError('INVALID', { field: issue });
      set.config = config as unknown as Record<string, unknown>;
    }
    if (patch.condition !== undefined) {
      const v = validatePollCondition(patch.condition);
      if (!v.ok) throw new PollError('INVALID', { field: 'condition' });
      set.condition = v.condition as unknown as Record<string, unknown>;
    }
    if (patch.condition !== undefined || patch.config) {
      const cond = (set.condition ?? poll.condition) as unknown as PollCondition;
      const { profiles } = await this.computeVoters(cond);
      if (profiles.length === 0) throw new PollError('INVALID', { field: 'condition' });
      if (poll.eligibility === 'fixed') set.voters = this.toVoters(config, profiles);
    }
    await this.deps.db.update(schema.polls).set(set).where(eq(schema.polls.id, pollId));
    await this.deps.audit.log({ actorId: userId, action: 'anketa.upravena', targetType: 'poll', targetId: pollId, after: patch as Record<string, unknown> });
    this.deps.emit(pollId);
  }

  async pin(userId: string, pollId: string, on: boolean): Promise<void> {
    const poll = await this.load(pollId);
    if (!this.isManager(userId, poll)) throw new PollError('FORBIDDEN');
    await this.deps.db.update(schema.polls).set({ pinned: on }).where(eq(schema.polls.id, pollId));
    this.deps.emit(pollId);
  }

  /** Zakladatel rozhodne remízu, když ji nevyřešil los ani role. */
  async decideTie(userId: string, pollId: string, option: string): Promise<void> {
    const poll = await this.load(pollId);
    if (poll.founderId !== userId && !this.can(userId, 'anketa.spravovat')) throw new PollError('FORBIDDEN');
    if (poll.status !== 'tie') throw new PollError('NOT_TIED');
    const tied = (poll.result as { tied?: string[] } | null)?.tied ?? [];
    if (!tied.includes(option)) throw new PollError('BAD_ANSWER');
    await this.finish(poll, { ...(poll.result as Record<string, unknown>), outcome: 'passed', winners: [option], tied: [], tieResolvedBy: 'founder' } as unknown as PollResult & { tieResolvedBy: string });
    await this.deps.audit.log({ actorId: userId, action: 'anketa.remiza_rozhodnuta', targetType: 'poll', targetId: pollId, after: { option } });
  }

  // ---------- uzavření ----------

  private async closeInternal(poll: Row): Promise<void> {
    const { result, eligible, ballots } = await this.compute(poll, true);
    const config = this.cfg(poll);
    if (result.outcome === 'tie') {
      const res = resolveTie(config, result.tied, eligible, ballots, this.deps.rng ?? (() => randomInt(0, 1_000_000) / 1_000_000));
      if ('winner' in res) {
        await this.finish(poll, { ...result, outcome: 'passed', winners: [res.winner], tied: [], tieResolvedBy: config.tie } as PollResult & { tieResolvedBy: string });
        return;
      }
      if (res.needs === 'extend' && !poll.extended) {
        const ends = this.deps.now() + num(this.s, 'poll.tieExtendMinutes') * 60_000;
        await this.deps.db.update(schema.polls).set({ endsAt: new Date(ends), extended: true, reminded: false }).where(eq(schema.polls.id, poll.id));
        this.deps.emit(poll.id);
        return;
      }
      await this.deps.db.update(schema.polls).set({ status: 'tie', result: result as unknown as Record<string, unknown> }).where(eq(schema.polls.id, poll.id));
      if (poll.founderId) await this.deps.notify(poll.founderId, 'pollResult', { name: poll.title, result: t('poll.result.tie') }, `/ankety/${poll.id}`);
      this.deps.emit(poll.id);
      return;
    }
    await this.finish(poll, result);
  }

  private summary(poll: Row, result: PollResult): string {
    const config = this.cfg(poll);
    if (result.outcome === 'passed') {
      if (config.type === 'yesno') return t('poll.result.passed');
      const label = result.winners.map((w) => config.options.find((o) => o.id === w)?.label ?? w).join(', ');
      return label ? t('poll.result.winner', { winner: label }) : t('poll.result.passed');
    }
    return t(`poll.result.${result.outcome}`);
  }

  private async finish(poll: Row, result: PollResult & { tieResolvedBy?: string }): Promise<void> {
    const summary = this.summary(poll, result);
    await this.deps.db
      .update(schema.polls)
      .set({ status: 'closed', closedAt: new Date(this.deps.now()), result: { ...result, summary } as unknown as Record<string, unknown> })
      .where(eq(schema.polls.id, poll.id));
    await this.deps.audit.log({ actorId: null, action: 'anketa.uzavrena', targetType: 'poll', targetId: poll.id, after: { outcome: result.outcome, winners: result.winners } });
    await this.afterClose(poll, result);
    void this.deps.announce({ kind: poll.targetKind, id: poll.targetId }, t('chat.sys.pollClosed', { name: poll.title, result: summary, card: `{{anketa:${poll.id}}}` })).catch(() => undefined);
    if (this.s['poll.notify'] && poll.founderId) void this.deps.notify(poll.founderId, 'pollResult', { name: poll.title, result: summary }, `/ankety/${poll.id}`).catch(() => undefined);
    this.deps.emit(poll.id);
  }

  // ---------- akce po výsledku ----------

  private actionView(poll: Row, manager: boolean) {
    const a = poll.action as unknown as PollAction | null;
    if (!a) return null;
    return { kind: a.kind, requireConfirm: a.requireConfirm, state: a.state ?? 'waiting', message: a.message ?? null, createdId: a.createdId ?? null, params: manager ? a.params : null };
  }

  private async setAction(pollId: string, a: PollAction): Promise<void> {
    await this.deps.db.update(schema.polls).set({ action: a as unknown as Record<string, unknown> }).where(eq(schema.polls.id, pollId));
  }

  /** Po uzavření ankety: akci přeskočí, nebo ji pošle ke schválení, nebo rovnou provede. */
  private async afterClose(poll: Row, result: PollResult): Promise<void> {
    const a = poll.action as unknown as PollAction | null;
    if (!a || (a.state && a.state !== 'waiting')) return;
    if (result.outcome !== 'passed') {
      await this.setAction(poll.id, { ...a, state: 'skipped' });
      return;
    }
    if (a.requireConfirm) {
      await this.setAction(poll.id, { ...a, state: 'pendingConfirm' });
      const ids = await this.deps.profiles.activeUserIds();
      const approvers = [...new Set([...(poll.founderId ? [poll.founderId] : []), ...ids.filter((u) => this.can(u, 'anketa.akce'))])];
      if (this.s['poll.notify']) for (const u of approvers) await this.deps.notify(u, 'pollAction', { name: poll.title }, `/ankety/${poll.id}`);
      return;
    }
    await this.runAction(poll, a, result, null);
  }

  private async runAction(poll: Row, a: PollAction, result: PollResult, confirmedBy: string | null): Promise<void> {
    const config = this.cfg(poll);
    const winner = config.options.find((o) => o.id === result.winners[0]) ?? null;
    try {
      if (!poll.founderId || !this.deps.runAction) throw new PollError('FORBIDDEN');
      const out = await this.deps.runAction(a.kind, poll.founderId, a.params, winner);
      await this.setAction(poll.id, { ...a, state: 'done', createdId: out.createdId, confirmedBy, message: undefined });
      await this.deps.audit.log({ actorId: confirmedBy ?? poll.founderId, action: 'anketa.akce_provedena', targetType: 'poll', targetId: poll.id, after: { kind: a.kind, createdId: out.createdId } });
      void this.deps.announce({ kind: poll.targetKind, id: poll.targetId }, t('chat.sys.pollActionDone', { name: poll.title, action: t(`polls.action.${a.kind}`) })).catch(() => undefined);
    } catch (e) {
      const code = e instanceof Error ? ((e as { code?: string }).code ?? e.message) : 'UNKNOWN';
      await this.setAction(poll.id, { ...a, state: 'failed', message: String(code).slice(0, 80), confirmedBy });
      await this.deps.audit.log({ actorId: confirmedBy ?? poll.founderId, action: 'anketa.akce_selhala', targetType: 'poll', targetId: poll.id, after: { kind: a.kind, code } });
    }
    this.deps.emit(poll.id);
  }

  /** Oprávněná osoba potvrdí (nebo zamítne) provedení akce po schválené anketě. */
  async confirmAction(userId: string, pollId: string, approve: boolean): Promise<void> {
    if (!this.can(userId, 'anketa.akce')) throw new PollError('FORBIDDEN');
    const poll = await this.load(pollId);
    const a = poll.action as unknown as PollAction | null;
    if (!a || a.state !== 'pendingConfirm') throw new PollError('NOT_TIED');
    if (!approve) {
      await this.setAction(pollId, { ...a, state: 'rejected', confirmedBy: userId });
      await this.deps.audit.log({ actorId: userId, action: 'anketa.akce_zamitnuta', targetType: 'poll', targetId: pollId, after: { kind: a.kind } });
      this.deps.emit(pollId);
      return;
    }
    await this.runAction(poll, a, (poll.result ?? { winners: [] }) as unknown as PollResult, userId);
  }

  /** Plánovač: ukončí ankety po termínu a připomene hlasování těm, kdo ještě nehlasovali. */
  async tick(): Promise<void> {
    if (!this.s['poll.enabled']) return;
    const now = this.deps.now();
    const open = await this.deps.db.select().from(schema.polls).where(eq(schema.polls.status, 'open'));
    for (const poll of open) {
      if (poll.endsAt.getTime() <= now) {
        await this.closeInternal(poll);
        continue;
      }
      const lead = num(this.s, 'poll.reminderMinutes') * 60_000;
      if (lead > 0 && !poll.reminded && poll.endsAt.getTime() - now <= lead) {
        await this.deps.db.update(schema.polls).set({ reminded: true }).where(eq(schema.polls.id, poll.id));
        const eligible = await this.eligibleOf(poll);
        const voted = new Set((await this.votesOf(poll)).map((v) => v.userId));
        const todo = eligible.map((v) => v.userId).filter((u) => !voted.has(u)).slice(0, num(this.s, 'poll.maxNotified'));
        if (this.s['poll.notify']) for (const u of todo) await this.deps.notify(u, 'pollReminder', { name: poll.title }, `/ankety/${poll.id}`);
        if (this.s['poll.pushNotify']) await this.deps.push(todo, t('notice.pollReminder.event'), t('notice.pollReminder.text', { name: poll.title }), `/ankety/${poll.id}`, `poll-${poll.id}`);
      }
    }
  }

  // ---------- export a šablony ----------

  async exportCsv(userId: string, pollId: string): Promise<string> {
    const poll = await this.load(pollId);
    if (!this.isManager(userId, poll)) throw new PollError('FORBIDDEN');
    const config = this.cfg(poll);
    const { result } = await this.compute(poll, poll.status !== 'open');
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const label = (id: string) => config.options.find((o) => o.id === id)?.label ?? id;
    const lines = [[esc('Možnost'), esc('Skóre'), esc('Hlasů')].join(',')];
    for (const o of result.options) lines.push([esc(config.type === 'yesno' ? o.id : label(o.id)), o.score, o.voters].join(','));
    lines.push('', [esc('Výsledek'), esc(result.outcome)].join(','), [esc('Hlasovalo'), result.voted, esc(`z ${result.eligible}`)].join(','));
    if (config.anonymity === 'public') {
      const votes = (await this.votesOf(poll)).filter((v) => v.answer);
      const nicks = new Map(votes.length ? (await this.deps.db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, votes.map((v) => v.userId)))).map((u) => [u.id, u.n]) : []);
      lines.push('', [esc('Hráč'), esc('Odpověď')].join(','));
      for (const v of votes) lines.push([esc(nicks.get(v.userId) ?? '?'), esc(JSON.stringify(v.answer))].join(','));
    }
    await this.deps.audit.log({ actorId: userId, action: 'anketa.exportovana', targetType: 'poll', targetId: pollId });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  async saveTemplate(userId: string, name: string, data: Record<string, unknown>): Promise<string> {
    if (!this.can(userId, 'anketa.vytvorit')) throw new PollError('FORBIDDEN');
    const n = name.trim();
    if (!n || n.length > 60) throw new PollError('INVALID', { field: 'name' });
    const [row] = await this.deps.db.insert(schema.pollTemplates).values({ ownerId: userId, name: n, data }).returning({ id: schema.pollTemplates.id });
    return row!.id;
  }

  async templates(userId: string) {
    return (await this.deps.db.select().from(schema.pollTemplates).where(eq(schema.pollTemplates.ownerId, userId)).orderBy(desc(schema.pollTemplates.createdAt))).map((r) => ({ id: r.id, name: r.name, data: r.data }));
  }

  async deleteTemplate(userId: string, id: string): Promise<void> {
    await this.deps.db.delete(schema.pollTemplates).where(and(eq(schema.pollTemplates.id, id), eq(schema.pollTemplates.ownerId, userId)));
  }
}
