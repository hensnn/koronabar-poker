import { and, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  dayKey,
  weekKey,
  displayRating,
  divisionFor,
  fieldFactor,
  fromLocal,
  inactiveSkill,
  lengthFactor,
  newSkill,
  rateCashSession,
  rateTournament,
  softReset,
  type PermissionChecker,
  type RatingChange,
  type RatingParams,
  type SettingValues,
  type Skill,
} from '@kb/shared';
import { schema, type Db } from './db/index.js';

export type Scope = 'tournament' | 'cash';

export class RatingError extends Error {
  constructor(public code: 'FORBIDDEN' | 'DISABLED') {
    super(code);
  }
}

export interface TournamentInput {
  rated: boolean;
  targetMinutes: number;
  finishedAt: number | null;
  results: { userId: string; place: number }[];
  rebuys: Record<string, number>;
  /** Živá hra: váha v ratingu určuje nastavení „live.ratingWeightPercent“. */
  live?: boolean;
}

export interface RatingRecomputeReport {
  tournaments: number;
  cashDays: number;
  resets: number;
  /** Počet změněných ratingů (hráč × druh). */
  changed: number;
  rows: { nickname: string; scope: Scope; before: number; after: number }[];
}

class PreviewRollback extends Error {}

export interface RatingDto {
  scope: Scope;
  /** Zobrazovaný rating; null, pokud správce číslo skryl. */
  rating: number | null;
  /** Nejistota v bodech ratingu (±). */
  uncertainty: number | null;
  provisional: boolean;
  games: number;
  peak: number | null;
  division: string;
}

const DAY = 86_400_000;
const num = (s: SettingValues, k: string) => Number(s[k] ?? 0);

/**
 * Herní rating z turnajů a cash sezení (OpenSkill + výměna bodů za vyřazení). Každá změna se ukládá do
 * `rating_events` s rozpisem, takže je vidět, proč se rating změnil, a zpracování téže hry se nezdvojí.
 */
export class RatingService {
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** Při přepočtu z historie se pracuje uvnitř jedné transakce (pro náhled se na konci vrátí). */
  private override: Db | null = null;

  private get db(): Db {
    return this.override ?? this.deps.db;
  }

  constructor(
    private deps: {
      db: Db;
      perms: PermissionChecker;
      settings: () => SettingValues;
      now: () => number;
      onError?: (e: unknown) => void;
      /** Upozornění v aplikaci (zvonek). */
      notify?: (userId: string, kind: string, params: Record<string, unknown>, link: string | null) => Promise<void>;
    },
  ) {}

  stop(): void {
    this.stopped = true;
  }

  async idle(): Promise<void> {
    await this.queue;
  }

  private enqueue(fn: () => Promise<unknown>): Promise<void> {
    const next = this.queue.then(() => (this.stopped ? undefined : fn()));
    this.queue = next.catch((e) => this.deps.onError?.(e));
    return this.queue as Promise<void>;
  }

  private get s(): SettingValues {
    return this.deps.settings();
  }

  params(): RatingParams {
    const s = this.s;
    return { mu0: num(s, 'rating.mu0'), sigma0: num(s, 'rating.sigma0Hundredths') / 100, k: num(s, 'rating.k'), scale: num(s, 'rating.scale'), base: num(s, 'rating.base') };
  }

  // ---------- stav hráčů ----------

  private async loadStates(userIds: string[], scope: Scope, at: number): Promise<Map<string, { skill: Skill; games: number; peak: number; lastPlayedAt: number | null }>> {
    const p = this.params();
    const rows = userIds.length ? await this.db.select().from(schema.ratingState).where(and(eq(schema.ratingState.scope, scope), inArray(schema.ratingState.userId, userIds))) : [];
    const out = new Map<string, { skill: Skill; games: number; peak: number; lastPlayedAt: number | null }>();
    for (const id of userIds) {
      const r = rows.find((x) => x.userId === id);
      if (!r) {
        out.set(id, { skill: newSkill(p), games: 0, peak: p.base, lastPlayedAt: null });
        continue;
      }
      const last = r.lastPlayedAt?.getTime() ?? null;
      const days = last === null ? 0 : Math.max(0, (at - last) / DAY);
      out.set(id, { skill: inactiveSkill({ mu: r.mu, sigma: r.sigma }, days, num(this.s, 'rating.inactivityGraceDays'), num(this.s, 'rating.inactivitySigmaGrowthHundredths') / 100, p), games: r.games, peak: r.peak, lastPlayedAt: last });
    }
    return out;
  }

  private async save(scope: Scope, ref: string, at: number, changes: RatingChange[], states: Map<string, { games: number; peak: number }>, kind = 'game'): Promise<void> {
    const run = <T>(fn: (trx: Db) => Promise<T>): Promise<T> => (this.override ? fn(this.override) : (this.deps.db.transaction((trx) => fn(trx as unknown as Db)) as Promise<T>));
    await run(async (trx) => {
      for (const c of changes) {
        const st = states.get(c.userId)!;
        const inserted = await trx
          .insert(schema.ratingEvents)
          .values({ userId: c.userId, scope, ref, kind, at: new Date(at), muBefore: c.before.mu, sigmaBefore: c.before.sigma, muAfter: c.after.mu, sigmaAfter: c.after.sigma, displayBefore: c.displayBefore, displayAfter: c.displayAfter, breakdown: c.breakdown as unknown as Record<string, unknown> })
          .onConflictDoNothing()
          .returning({ id: schema.ratingEvents.id });
        if (inserted.length === 0) continue;
        const games = st.games + (kind === 'game' ? 1 : 0);
        const peak = Math.max(st.peak, c.displayAfter);
        await trx
          .insert(schema.ratingState)
          .values({ userId: c.userId, scope, mu: c.after.mu, sigma: c.after.sigma, games, peak, lastPlayedAt: kind === 'game' ? new Date(at) : null, updatedAt: new Date(at) })
          .onConflictDoUpdate({
            target: [schema.ratingState.userId, schema.ratingState.scope],
            set: { mu: c.after.mu, sigma: c.after.sigma, games, peak, ...(kind === 'game' ? { lastPlayedAt: new Date(at) } : {}), updatedAt: new Date(at) },
          });
      }
    });
  }

  // ---------- turnaj ----------

  /** Po skončení turnaje: upraví rating všech hráčů z konečného pořadí a vyřazení. */
  onTournamentFinished(tournamentId: string, t: TournamentInput): Promise<void> {
    return this.enqueue(() => this.processTournament(tournamentId, t));
  }

  private async processTournament(tournamentId: string, t: TournamentInput): Promise<void> {
    {
      const s = this.s;
      if (!s['rating.enabled'] || !s['rating.tournamentsEnabled'] || !t.rated || t.results.length < num(s, 'rating.minPlayers')) return;
      const liveFactor = t.live ? num(s, 'live.ratingWeightPercent') / 100 : 1;
      if (liveFactor <= 0) return;
      const ref = tournamentId;
      const [done] = await this.db.select({ id: schema.ratingEvents.id }).from(schema.ratingEvents).where(and(eq(schema.ratingEvents.scope, 'tournament'), eq(schema.ratingEvents.ref, ref))).limit(1);
      if (done) return;
      const at = t.finishedAt ?? this.deps.now();
      const ids = t.results.map((r) => r.userId);
      const known = new Set((await this.db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, ids))).map((u) => u.id));
      const results = t.results.filter((r) => known.has(r.userId));
      if (results.length < 2) return;
      const states = await this.loadStates(results.map((r) => r.userId), 'tournament', at);
      const elim = await this.db.select().from(schema.tournamentEliminations).where(eq(schema.tournamentEliminations.tournamentId, tournamentId));
      const pairInfo = results.length === 2 ? await this.pairFactor(results[0]!.userId, results[1]!.userId, tournamentId, at) : { factor: 1, prior: 0 };
      const pair = pairInfo.factor;
      if (results.length === 2 && pairInfo.prior + 1 >= num(s, 'rating.pairFlagCount')) await this.flag('heads_up_pair', results[0]!.userId, results[1]!.userId, weekKey(at), { count: pairInfo.prior + 1 });
      const weight = fieldFactor(results.length, num(s, 'rating.fullFieldPlayers')) * lengthFactor(t.targetMinutes, num(s, 'rating.lengthRefMinutes'), num(s, 'rating.lengthMinFactorPercent') / 100) * pair * liveFactor;
      const changes = rateTournament(
        results.map((r) => ({ userId: r.userId, place: r.place, skill: states.get(r.userId)!.skill, rebuys: t.rebuys[r.userId] ?? 0 })),
        elim.map((e) => ({ victimId: e.victimId, killers: e.killers })),
        { knockoutWeightPercent: num(s, 'rating.knockoutWeightPercent'), knockoutK: num(s, 'rating.knockoutK'), rebuyPenaltyPercent: num(s, 'rating.rebuyPenaltyPercent'), weight, evSharePercent: num(s, 'rating.evSharePercent') },
        this.params(),
      );
      await this.save('tournament', ref, at, changes, states);
    }
  }

  /** Klesající váha opakovaných heads-upů téže dvojice v okně. */
  private async pairFactor(a: string, b: string, currentRef: string, at: number): Promise<{ factor: number; prior: number }> {
    const since = new Date(at - num(this.s, 'rating.pairWindowDays') * DAY);
    const A = schema.gameResults;
    const mine = await this.db.select({ ref: A.ref }).from(A).where(and(eq(A.userId, a), eq(A.kind, 'tournament'), gte(A.finishedAt, since), lt(A.finishedAt, new Date(at))));
    const refs = mine.map((r) => r.ref).filter((r) => r !== currentRef);
    if (refs.length === 0) return { factor: 1, prior: 0 };
    const theirs = new Set((await this.db.select({ ref: A.ref }).from(A).where(and(eq(A.userId, b), inArray(A.ref, refs)))).map((r) => r.ref));
    let prior = 0;
    for (const ref of theirs) {
      const [c] = await this.db.select({ n: sql<number>`count(*)::int` }).from(A).where(and(eq(A.ref, ref), eq(A.kind, 'tournament')));
      if ((c?.n ?? 0) === 2) prior++;
    }
    return { factor: Math.pow(num(this.s, 'rating.pairDecayPercent') / 100, prior), prior };
  }

  // ---------- podezření na zneužití ----------

  private async flag(kind: string, userA: string, userB: string, windowKey: string, detail: Record<string, unknown>): Promise<void> {
    // u dvojic bez směru (heads-upy) záleží na pořadí jen kvůli jedinečnosti
    const [a, b] = kind === 'heads_up_pair' && userA > userB ? [userB, userA] : [userA, userB];
    await this.db.insert(schema.ratingFlags).values({ kind, userA: a, userB: b, windowKey, detail }).onConflictDoNothing();
  }

  /**
   * Hledá jednosměrný tok žetonů mezi dvojicemi hráčů u cash stolů za poslední dny. Každý prohraný pot se
   * rozdělí mezi vítěze poměrně; dvojice se označí, když jeden hráč druhému převedl hodně big blindů a skoro
   * vše šlo jedním směrem. Označení je jen upozornění pro správce.
   */
  scanChipFlow(): Promise<number> {
    let created = 0;
    return this.enqueue(async () => {
      const s = this.s;
      if (!s['rating.enabled']) return;
      const now = this.deps.now();
      const since = new Date(now - num(s, 'rating.dumpWindowDays') * DAY);
      const rows = await this.db
        .select({ handId: schema.handPlayers.handId, userId: schema.handPlayers.userId, won: schema.handPlayers.won, invested: schema.handPlayers.invested, blinds: schema.hands.blinds })
        .from(schema.handPlayers)
        .innerJoin(schema.hands, eq(schema.hands.id, schema.handPlayers.handId))
        .where(and(eq(schema.hands.kind, 'cash'), gte(schema.hands.playedAt, since)));
      const byHand = new Map<string, typeof rows>();
      for (const r of rows) (byHand.get(r.handId) ?? byHand.set(r.handId, []).get(r.handId)!).push(r);
      const flow = new Map<string, { ab: number; ba: number; hands: number }>();
      const add = (from: string, to: string, bb: number) => {
        const [a, b] = from < to ? [from, to] : [to, from];
        const k = `${a}|${b}`;
        const cur = flow.get(k) ?? { ab: 0, ba: 0, hands: 0 };
        if (from === a) cur.ab += bb;
        else cur.ba += bb;
        flow.set(k, cur);
      };
      for (const players of byHand.values()) {
        const bb = players[0]!.blinds.bb;
        if (!bb) continue;
        const winners = players.filter((p) => p.won - p.invested > 0);
        const losers = players.filter((p) => p.won - p.invested < 0);
        const gain = winners.reduce((n, p) => n + (p.won - p.invested), 0);
        if (gain <= 0) continue;
        for (const l of losers) {
          for (const w of winners) {
            add(l.userId, w.userId, ((l.invested - l.won) * ((w.won - w.invested) / gain)) / bb);
            const [a, b] = l.userId < w.userId ? [l.userId, w.userId] : [w.userId, l.userId];
            flow.get(`${a}|${b}`)!.hands++;
          }
        }
      }
      const key = weekKey(now);
      for (const [k, f] of flow) {
        const [a, b] = k.split('|') as [string, string];
        const net = f.ab - f.ba;
        const [from, to] = net >= 0 ? [a, b] : [b, a];
        const sent = Math.max(f.ab, f.ba);
        const total = f.ab + f.ba;
        if (Math.abs(net) < num(s, 'rating.dumpMinBb') || f.hands < num(s, 'rating.dumpMinHands')) continue;
        const ratio = total > 0 ? (sent / total) * 100 : 0;
        if (ratio < num(s, 'rating.dumpRatioPercent')) continue;
        await this.flag('chip_flow', from, to, key, { bb: Math.round(Math.abs(net)), ratio: Math.round(ratio), hands: f.hands });
        created++;
      }
    }).then(() => created);
  }

  async flags(actorId: string) {
    if (!this.deps.perms.can(actorId, 'statistiky.sezony').allowed) throw new RatingError('FORBIDDEN');
    const rows = await this.db.select().from(schema.ratingFlags).orderBy(desc(schema.ratingFlags.id)).limit(100);
    const ids = [...new Set(rows.flatMap((r) => [r.userA, r.userB]))];
    const nicks = new Map(ids.length ? (await this.db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, ids))).map((u) => [u.id, u.n]) : []);
    return rows.map((r) => ({ id: r.id, kind: r.kind, from: nicks.get(r.userA) ?? '?', to: nicks.get(r.userB) ?? '?', detail: r.detail, status: r.status, note: r.note, createdAt: r.createdAt.getTime() }));
  }

  async resolveFlag(actorId: string, id: number, status: 'dismissed' | 'confirmed', note?: string): Promise<void> {
    if (!this.deps.perms.can(actorId, 'statistiky.sezony').allowed) throw new RatingError('FORBIDDEN');
    const [row] = await this.db.update(schema.ratingFlags).set({ status, note: note?.slice(0, 300) ?? null, resolvedBy: actorId, resolvedAt: new Date(this.deps.now()) }).where(eq(schema.ratingFlags.id, id)).returning();
    // Reakce na potvrzené podezření: jen upozornění (o ratingu nerozhoduje automat, ten zůstává na správci).
    if (status === 'confirmed' && row && this.deps.notify) {
      const s = this.s;
      const nicks = new Map((await this.db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, [row.userA, row.userB]))).map((u) => [u.id, u.n]));
      const a = nicks.get(row.userA) ?? '?';
      const b = nicks.get(row.userB) ?? '?';
      if (s['rating.flagNotifyAdmins']) {
        const ids = (await this.db.select({ id: schema.users.id }).from(schema.users).where(ne(schema.users.status, 'blocked'))).map((u) => u.id);
        for (const u of ids) if (u !== actorId && this.deps.perms.can(u, 'statistiky.sezony').allowed) await this.deps.notify(u, 'ratingFlag', { players: `${a} a ${b}` }, '/postup').catch(() => undefined);
      }
      if (s['rating.flagNotifyPlayers']) {
        await this.deps.notify(row.userA, 'ratingFlagPlayer', { other: b }, null).catch(() => undefined);
        await this.deps.notify(row.userB, 'ratingFlagPlayer', { other: a }, null).catch(() => undefined);
      }
    }
  }

  // ---------- cash ----------

  /**
   * Zpracuje dokončené dny cash her (do včerejška podle času v Praze): sezení = hráč u jednoho stolu za den
   * s dostatkem hand. Výsledek v BB na 100 hand se porovná mezi hráči u téhož stolu.
   */
  rateCash(): Promise<number> {
    let rated = 0;
    return this.enqueue(async () => {
      const s = this.s;
      if (!s['rating.enabled'] || !s['rating.cashEnabled']) return;
      const today = dayKey(this.deps.now());
      const [meta] = await this.db.select().from(schema.systemMeta).where(eq(schema.systemMeta.key, 'rating:cashDay'));
      let from: string | null = meta ? String(meta.value) : null;
      if (!from) {
        const [first] = await this.db.select({ at: schema.hands.playedAt }).from(schema.hands).where(eq(schema.hands.kind, 'cash')).orderBy(schema.hands.playedAt).limit(1);
        if (!first) return;
        from = dayKey(first.at.getTime());
      }
      let day = from;
      for (let i = 0; i < 90 && day < today; i++) {
        rated += await this.rateCashDay(day);
        day = nextDay(day);
        await this.db.insert(schema.systemMeta).values({ key: 'rating:cashDay', value: day }).onConflictDoUpdate({ target: schema.systemMeta.key, set: { value: day } });
      }
    }).then(() => rated);
  }

  private async rateCashDay(day: string): Promise<number> {
    const s = this.s;
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    const start = new Date(fromLocal(y, m, d, 0, 0));
    const end = new Date(fromLocal(y, m, d + 1, 0, 0));
    const rows = await this.db
      .select({ tableId: schema.hands.tableId, userId: schema.handPlayers.userId, won: schema.handPlayers.won, invested: schema.handPlayers.invested, blinds: schema.hands.blinds, equity: schema.handPlayers.allInEquity, pot: schema.hands.pot })
      .from(schema.handPlayers)
      .innerJoin(schema.hands, eq(schema.hands.id, schema.handPlayers.handId))
      .where(and(eq(schema.hands.kind, 'cash'), gte(schema.hands.playedAt, start), lt(schema.hands.playedAt, end)));
    const sessions = new Map<string, Map<string, { hands: number; bb: number }>>();
    for (const r of rows) {
      const bb = r.blinds.bb;
      if (!bb) continue;
      const table = sessions.get(r.tableId) ?? sessions.set(r.tableId, new Map()).get(r.tableId)!;
      const cur = table.get(r.userId) ?? { hands: 0, bb: 0 };
      cur.hands++;
      // EV korekce heads-up all-inů: část výsledku se počítá podle šancí místo skutečného výsledku
      const actual = r.won - r.invested;
      const ev = num(s, 'rating.evSharePercent') / 100;
      const net = r.equity == null ? actual : (1 - ev) * actual + ev * (r.equity * r.pot - r.invested);
      cur.bb += net / bb;
      table.set(r.userId, cur);
    }
    const at = end.getTime() - 1;
    const weight = num(s, 'rating.cashWeightPercent') / 100;
    let count = 0;
    for (const [tableId, players] of sessions) {
      const eligible = [...players].filter(([, v]) => v.hands >= num(s, 'rating.cashMinHands'));
      if (eligible.length < 2) continue;
      const ref = `cash:${tableId}:${day}`;
      const [done] = await this.db.select({ id: schema.ratingEvents.id }).from(schema.ratingEvents).where(and(eq(schema.ratingEvents.scope, 'cash'), eq(schema.ratingEvents.ref, ref))).limit(1);
      if (done) continue;
      const states = await this.loadStates(eligible.map(([id]) => id), 'cash', at);
      const changes = rateCashSession(
        eligible.map(([id, v]) => ({ userId: id, bbPer100: Math.round((v.bb / v.hands) * 10_000) / 100, skill: states.get(id)!.skill })),
        weight,
        this.params(),
      );
      await this.save('cash', ref, at, changes, states);
      count += changes.length;
    }
    return count;
  }

  // ---------- reset sezóny ----------

  /** Měkký reset sezóny: síla se přiblíží k průměru a nejistota vzroste. Historie zůstává v `rating_events`. */
  softResetAll(actorId: string): Promise<number> {
    if (!this.deps.perms.can(actorId, 'statistiky.sezony').allowed) throw new RatingError('FORBIDDEN');
    let n = 0;
    return this.enqueue(async () => {
      n = await this.applyReset(this.deps.now());
    }).then(() => n);
  }

  private async applyReset(at: number): Promise<number> {
    const p = this.params();
    const rows = await this.db.select().from(schema.ratingState);
    for (const r of rows) {
      const before = { mu: r.mu, sigma: r.sigma };
      const after = softReset(before, num(this.s, 'rating.seasonResetMuPercent'), num(this.s, 'rating.seasonResetSigmaPercent'), p);
      const change: RatingChange = {
        userId: r.userId,
        before,
        after,
        displayBefore: displayRating(before, p),
        displayAfter: displayRating(after, p),
        breakdown: { placement: 0, knockouts: [], knockedOutBy: [], weight: 1, rebuyPenalty: false },
      };
      await this.save(r.scope as Scope, `reset:${at}`, at, [change], new Map([[r.userId, { games: r.games, peak: r.peak }]]), 'reset');
    }
    return rows.length;
  }

  // ---------- zpětný přepočet ----------

  /**
   * Přepočítá rating všech hráčů z uložené historie (turnaje, vyřazení, cash sezení, resety sezón) podle
   * aktuálního nastavení. Celé běží v jedné transakci: pro náhled se na konci vrátí zpět, jinak se potvrdí.
   */
  recompute(actorId: string, preview: boolean): Promise<RatingRecomputeReport> {
    if (!this.deps.perms.can(actorId, 'statistiky.sezony').allowed) throw new RatingError('FORBIDDEN');
    let report: RatingRecomputeReport = { tournaments: 0, cashDays: 0, resets: 0, changed: 0, rows: [] };
    return this.enqueue(async () => {
      try {
        await this.deps.db.transaction(async (trx) => {
          this.override = trx as unknown as Db;
          try {
            report = await this.replay();
          } finally {
            this.override = null;
          }
          if (preview) throw new PreviewRollback();
        });
      } catch (e) {
        if (!(e instanceof PreviewRollback)) throw e;
      }
    }).then(() => report);
  }

  private async snapshot(): Promise<Map<string, number>> {
    const p = this.params();
    const rows = await this.db.select().from(schema.ratingState);
    return new Map(rows.map((r) => [`${r.userId}|${r.scope}`, displayRating({ mu: r.mu, sigma: r.sigma }, p)]));
  }

  private async replay(): Promise<RatingRecomputeReport> {
    const before = await this.snapshot();
    const resets = [...new Set((await this.db.select({ at: schema.ratingEvents.at }).from(schema.ratingEvents).where(eq(schema.ratingEvents.kind, 'reset'))).map((r) => r.at.getTime()))];
    await this.db.delete(schema.ratingEvents);
    await this.db.delete(schema.ratingState);

    type Item = { at: number; order: number; run: () => Promise<void> };
    const items: Item[] = [];
    const GR = schema.gameResults;
    const rows = await this.db.select().from(GR).where(eq(GR.kind, 'tournament'));
    const byRef = new Map<string, typeof rows>();
    for (const r of rows) (byRef.get(r.ref) ?? byRef.set(r.ref, []).get(r.ref)!).push(r);
    for (const [ref, rs] of byRef) {
      const at = rs[0]!.finishedAt.getTime();
      const rebuys: Record<string, number> = {};
      for (const r of rs) rebuys[r.userId] = r.rebuys;
      items.push({
        at,
        order: 1,
        run: () => this.processTournament(ref, { rated: rs[0]!.rated, live: rs[0]!.live, targetMinutes: rs[0]!.targetMinutes ?? 0, finishedAt: at, results: rs.map((r) => ({ userId: r.userId, place: r.place })), rebuys }),
      });
    }
    const [first] = await this.db.select({ at: schema.hands.playedAt }).from(schema.hands).where(eq(schema.hands.kind, 'cash')).orderBy(schema.hands.playedAt).limit(1);
    const today = dayKey(this.deps.now());
    let cashDays = 0;
    if (first) {
      for (let day = dayKey(first.at.getTime()); day < today; day = nextDay(day)) {
        const [y, m, d] = day.split('-').map(Number) as [number, number, number];
        items.push({ at: fromLocal(y, m, d + 1, 0, 0) - 1, order: 1, run: async () => void (await this.rateCashDay(day)) });
        cashDays++;
      }
    }
    for (const at of resets) items.push({ at, order: 2, run: async () => void (await this.applyReset(at)) });
    items.sort((a, b) => a.at - b.at || a.order - b.order);
    for (const it of items) await it.run();
    await this.db.insert(schema.systemMeta).values({ key: 'rating:cashDay', value: today }).onConflictDoUpdate({ target: schema.systemMeta.key, set: { value: today } });

    const after = await this.snapshot();
    const keys = new Set([...before.keys(), ...after.keys()]);
    const p = this.params();
    const diffs = [...keys]
      .map((k) => ({ k, before: before.get(k) ?? p.base, after: after.get(k) ?? p.base }))
      .filter((d) => d.before !== d.after)
      .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
    const ids = [...new Set(diffs.map((d) => d.k.split('|')[0]!))];
    const nicks = new Map(ids.length ? (await this.db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, ids))).map((u) => [u.id, u.n]) : []);
    return {
      tournaments: byRef.size,
      cashDays,
      resets: resets.length,
      changed: diffs.length,
      rows: diffs.slice(0, 50).map((d) => ({ nickname: nicks.get(d.k.split('|')[0]!) ?? '?', scope: d.k.split('|')[1] as Scope, before: d.before, after: d.after })),
    };
  }

  // ---------- čtení ----------

  private dto(scope: Scope, st: { mu: number; sigma: number; games: number; peak: number } | undefined): RatingDto {
    const p = this.params();
    const skill = st ? { mu: st.mu, sigma: st.sigma } : newSkill(p);
    const display = displayRating(skill, p);
    const show = !!this.s['rating.showNumbers'];
    const need = num(this.s, scope === 'cash' ? 'rating.cashProvisionalGames' : 'rating.provisionalGames');
    return {
      scope,
      rating: show ? display : null,
      uncertainty: show ? Math.round(p.scale * p.k * skill.sigma) : null,
      provisional: (st?.games ?? 0) < need,
      games: st?.games ?? 0,
      peak: show && st ? st.peak : null,
      division: divisionFor(display, String(this.s['rating.divisions'])).name,
    };
  }

  async ratingOf(userId: string): Promise<{ tournament: RatingDto; cash: RatingDto }> {
    const at = this.deps.now();
    const out = {} as { tournament: RatingDto; cash: RatingDto };
    for (const scope of ['tournament', 'cash'] as const) {
      const states = await this.loadStates([userId], scope, at);
      const st = states.get(userId)!;
      out[scope] = this.dto(scope, { mu: st.skill.mu, sigma: st.skill.sigma, games: st.games, peak: st.peak });
    }
    return out;
  }

  /** Čísla ratingu pro podmínky anket (nezávisle na tom, zda je správce hráčům skrývá). */
  async numeric(userId: string): Promise<{ tournament: { value: number; provisional: boolean } | null; cash: { value: number; provisional: boolean } | null; division: string }> {
    const p = this.params();
    const at = this.deps.now();
    const one = async (scope: Scope) => {
      const st = (await this.loadStates([userId], scope, at)).get(userId)!;
      if (st.games === 0) return null;
      const need = num(this.s, scope === 'cash' ? 'rating.cashProvisionalGames' : 'rating.provisionalGames');
      return { value: displayRating(st.skill, p), provisional: st.games < need };
    };
    const tournament = await one('tournament');
    const cash = await one('cash');
    return { tournament, cash, division: divisionFor(tournament?.value ?? p.base, String(this.s['rating.divisions'])).name };
  }

  /** Historie změn (nejnovější první) s rozpisem; ID hráčů v rozpisu se nahradí přezdívkami. */
  async history(userId: string, scope: Scope, limit = 30) {
    const rows = await this.db
      .select()
      .from(schema.ratingEvents)
      .where(and(eq(schema.ratingEvents.userId, userId), eq(schema.ratingEvents.scope, scope)))
      .orderBy(desc(schema.ratingEvents.at), desc(schema.ratingEvents.id))
      .limit(Math.min(limit, 200));
    const show = !!this.s['rating.showNumbers'];
    const ids = new Set<string>();
    for (const r of rows) {
      const b = r.breakdown as { knockouts?: { userId: string }[]; knockedOutBy?: { userId: string }[] };
      for (const k of [...(b.knockouts ?? []), ...(b.knockedOutBy ?? [])]) ids.add(k.userId);
    }
    const nicks = new Map(ids.size ? (await this.db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, [...ids]))).map((u) => [u.id, u.n]) : []);
    return rows.map((r) => {
      const b = r.breakdown as { placement: number; knockouts?: { userId: string; points: number }[]; knockedOutBy?: { userId: string; points: number }[]; weight: number; rebuyPenalty: boolean };
      return {
        ref: r.ref,
        kind: r.kind,
        at: r.at.getTime(),
        before: show ? r.displayBefore : null,
        after: show ? r.displayAfter : null,
        change: show ? r.displayAfter - r.displayBefore : null,
        placement: b.placement,
        knockouts: (b.knockouts ?? []).map((k) => ({ nickname: nicks.get(k.userId) ?? '?', points: k.points })),
        knockedOutBy: (b.knockedOutBy ?? []).map((k) => ({ nickname: nicks.get(k.userId) ?? '?', points: k.points })),
        weight: b.weight,
        rebuyPenalty: b.rebuyPenalty,
      };
    });
  }

  /** Žebříček ratingu: jen hráči, kteří už nejsou provizorní. */
  async leaderboard(scope: Scope) {
    const rows = await this.db
      .select({ s: schema.ratingState, nickname: schema.users.nickname })
      .from(schema.ratingState)
      .innerJoin(schema.users, eq(schema.users.id, schema.ratingState.userId))
      .where(eq(schema.ratingState.scope, scope));
    const at = this.deps.now();
    const p = this.params();
    const show = !!this.s['rating.showNumbers'];
    const need = num(this.s, scope === 'cash' ? 'rating.cashProvisionalGames' : 'rating.provisionalGames');
    return rows
      .filter((r) => r.s.games >= need)
      .map((r) => {
        const days = r.s.lastPlayedAt ? Math.max(0, (at - r.s.lastPlayedAt.getTime()) / DAY) : 0;
        const skill = inactiveSkill({ mu: r.s.mu, sigma: r.s.sigma }, days, num(this.s, 'rating.inactivityGraceDays'), num(this.s, 'rating.inactivitySigmaGrowthHundredths') / 100, p);
        const display = displayRating(skill, p);
        return { userId: r.s.userId, nickname: r.nickname, rating: show ? display : null, division: divisionFor(display, String(this.s['rating.divisions'])).name, games: r.s.games, order: display };
      })
      .sort((a, b) => b.order - a.order)
      .map(({ order: _o, ...rest }, i) => ({ rank: i + 1, ...rest }));
  }

  /**
   * Sezónní žebříček: hráči, kteří v daném období odehráli hru, podle ratingu po poslední hře sezóny, s posunem
   * od začátku sezóny a počtem her. Provizorní hráči (málo her celkem) se nezobrazují stejně jako v celkovém žebříčku.
   */
  async seasonLeaderboard(scope: Scope, from: Date, to: Date | null) {
    const A = schema.ratingEvents;
    const events = await this.db
      .select({ userId: A.userId, at: A.at, before: A.displayBefore, after: A.displayAfter, nickname: schema.users.nickname })
      .from(A)
      .innerJoin(schema.users, eq(schema.users.id, A.userId))
      .where(and(eq(A.scope, scope), eq(A.kind, 'game'), gte(A.at, from), to ? lt(A.at, to) : undefined))
      .orderBy(A.at);
    const states = new Map((await this.db.select().from(schema.ratingState).where(eq(schema.ratingState.scope, scope))).map((r) => [r.userId, r]));
    const need = num(this.s, scope === 'cash' ? 'rating.cashProvisionalGames' : 'rating.provisionalGames');
    const show = !!this.s['rating.showNumbers'];
    const by = new Map<string, { nickname: string; first: number; last: number; games: number }>();
    for (const e of events) {
      const cur = by.get(e.userId);
      if (cur) {
        cur.last = e.after;
        cur.games++;
      } else by.set(e.userId, { nickname: e.nickname, first: e.before, last: e.after, games: 1 });
    }
    return [...by]
      .filter(([id]) => (states.get(id)?.games ?? 0) >= need)
      .map(([userId, v]) => ({ userId, nickname: v.nickname, rating: show ? v.last : null, delta: show ? v.last - v.first : null, games: v.games, division: divisionFor(v.last, String(this.s['rating.divisions'])).name, order: v.last }))
      .sort((a, b) => b.order - a.order)
      .map(({ order: _o, ...r }, i) => ({ rank: i + 1, ...r }));
  }

  /** Vzájemná bilance dvou hráčů: kolikrát kdo koho vyřadil. */
  async duel(a: string, b: string): Promise<{ aKnockedB: number; bKnockedA: number }> {
    const te = schema.tournamentEliminations;
    const count = async (killer: string, victim: string) => {
      const [r] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(te)
        .where(and(eq(te.victimId, victim), sql`${te.killers} @> ${JSON.stringify([{ userId: killer }])}::jsonb`));
      return r?.n ?? 0;
    };
    return { aKnockedB: await count(a, b), bKnockedA: await count(b, a) };
  }
}

function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
