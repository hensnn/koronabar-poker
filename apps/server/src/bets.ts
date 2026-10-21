import { and, desc, eq, inArray } from 'drizzle-orm';
import { accounts, LedgerError, type Ledger } from '@kb/ledger';
import { distribute, favors, outcomeFor, settlePool, subjectsOf, validateBetParams, BET_SUBJECTS, type BetOutcome, type BetParams, type BetSide, type BetSubject, type PermissionChecker, type SettingValues, type TournamentFacts } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';

export type BetErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'DISABLED' | 'CLOSED' | 'LIMIT' | 'INSUFFICIENT_FUNDS' | 'SELF' | 'AGAINST_SELF' | 'BOTH_SIDES' | 'FULL' | 'DECIDED' | 'STATE' | 'NOT_ELIGIBLE';

export class BetError extends Error {
  constructor(
    public code: BetErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** Stav turnaje, který sázky a odměny potřebují (poskytuje správce turnajů). */
export interface BetFacts extends TournamentFacts {
  name: string;
  /** Hráči, kteří jsou přihlášení nebo ještě hrají. */
  participants: string[];
  /** Je ještě otevřené rebuy období (před startem také)? */
  rebuyOpen: boolean;
  winnerId: string | null;
  /** Povolil turnaj odměny na hlavu (nastavení turnaje)? */
  headBounty: boolean;
}

interface Deps {
  db: Db;
  ledger: Ledger;
  perms: PermissionChecker;
  audit: AuditService;
  settings: () => SettingValues;
  now: () => number;
  nickOf: (userId: string) => Promise<string>;
  facts: (tournamentId: string) => BetFacts | null;
  onWallet?: (userId: string) => void;
  onChanged?: (tournamentId: string) => void;
  notify?: (userId: string, kind: string, params: Record<string, unknown>, link: string | null) => Promise<void>;
}

type Meta = { ip?: string | null };
type Bet = typeof schema.bets.$inferSelect;
type Stake = typeof schema.betStakes.$inferSelect;
const LIVE = ['open', 'locked', 'proposed', 'disputed'];

/** Fronta, která drží operace s penězi za sebou (žádné souběžné dvojí vyplacení). */
class Serial {
  private q: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.q.then(fn, fn);
    this.q = next.catch(() => undefined);
    return next;
  }
}

function pay(ledger: Ledger, post: () => void): void {
  try {
    post();
  } catch (e) {
    if (e instanceof LedgerError && e.code === 'INSUFFICIENT_FUNDS') throw new BetError('INSUFFICIENT_FUNDS');
    throw e;
  }
}

/**
 * Sázky vedle hry: vklady se hned zamknou na účtu stavy escrow, po vyhodnocení se vyplatí poměrně mezi výherce
 * (poplatek domu volitelný). Herní výsledky vyhodnocuje systém, vlastní tvrzení zakladatel s možností sporu.
 */
export class BetService {
  private serial = new Serial();

  constructor(private deps: Deps) {}

  /** Počká, až doběhnou všechny rozpracované operace (testy, vypnutí serveru). */
  idle(): Promise<void> {
    return this.serial.run(async () => undefined);
  }

  private s() {
    return this.deps.settings();
  }

  private enabled(): void {
    if (!this.s()['bets.enabled']) throw new BetError('DISABLED');
  }

  private can(userId: string, key: string): boolean {
    return this.deps.perms.can(userId, key).allowed;
  }

  private async load(id: string): Promise<Bet> {
    const [b] = await this.deps.db.select().from(schema.bets).where(eq(schema.bets.id, id));
    if (!b) throw new BetError('NOT_FOUND');
    return b;
  }

  private stakesOf(betId: string): Promise<Stake[]> {
    return this.deps.db.select().from(schema.betStakes).where(eq(schema.betStakes.betId, betId));
  }

  private isClosedFor(bet: Bet, f: BetFacts): boolean {
    if (f.status === 'finished' || f.status === 'cancelled') return true;
    if (bet.closeRule === 'start') return f.status !== 'registering';
    if (bet.closeRule === 'rebuyEnd') return !f.rebuyOpen;
    return false;
  }

  // ---------- zakládání a vkládání ----------

  /** Nová sázka. Zakladatel může rovnou vložit první vklad (u přímé sázky je povinný). */
  create(userId: string, input: { tournamentId: string; subject: string; params?: BetParams; title?: string; direct?: boolean; close?: string; side?: string; amount?: number }, meta: Meta = {}): Promise<{ id: string }> {
    return this.serial.run(async () => {
      this.enabled();
      if (!this.can(userId, 'sazky.zalozit')) throw new BetError('FORBIDDEN');
      const s = this.s();
      const f = this.deps.facts(input.tournamentId);
      if (!f) throw new BetError('NOT_FOUND');
      if (f.status !== 'registering' && f.status !== 'running') throw new BetError('CLOSED');
      if (!(BET_SUBJECTS as readonly string[]).includes(input.subject)) throw new BetError('INVALID', { field: 'subject' });
      const subject = input.subject as BetSubject;
      if (subject === 'custom' && !s['bets.customEnabled']) throw new BetError('DISABLED');
      const v = validateBetParams(subject, input.params ?? {});
      if (!v.ok) throw new BetError('INVALID', { field: 'params', issue: v.issue });
      for (const u of subjectsOf(subject, v.params)) if (!f.participants.includes(u)) throw new BetError('INVALID', { field: 'params', issue: 'participant' });
      if (outcomeFor(subject, v.params, f) !== null) throw new BetError('DECIDED');
      const close = input.close ?? String(s['bets.defaultClose']);
      if (!['start', 'rebuyEnd', 'manual'].includes(close)) throw new BetError('INVALID', { field: 'close' });
      if (close === 'start' && f.status !== 'registering') throw new BetError('CLOSED');
      if (close === 'rebuyEnd' && !f.rebuyOpen) throw new BetError('CLOSED');
      const mine = await this.deps.db.select({ id: schema.bets.id }).from(schema.bets).where(and(eq(schema.bets.creatorId, userId), inArray(schema.bets.status, LIVE)));
      if (mine.length >= Number(s['bets.maxOpenPerUser'])) throw new BetError('LIMIT', { max: Number(s['bets.maxOpenPerUser']) });
      const direct = !!input.direct;
      if (direct && (input.side === undefined || input.amount === undefined)) throw new BetError('INVALID', { field: 'amount' });
      const title = (input.title ?? '').trim().slice(0, 120);
      const [row] = await this.deps.db
        .insert(schema.bets)
        .values({ tournamentId: input.tournamentId, kind: direct ? 'direct' : 'pool', subject, params: v.params as Record<string, unknown>, title, creatorId: userId, status: 'open', closeRule: close, feePercent: Number(s['bets.feePercent']) })
        .returning();
      await this.deps.audit.log({ actorId: userId, action: 'sazka.zalozit', targetType: 'bet', targetId: row!.id, after: { tournamentId: input.tournamentId, subject, direct }, ...meta });
      if (input.side !== undefined && input.amount !== undefined) {
        try {
          await this.stakeInternal(userId, row!.id, input.side as BetSide, input.amount, meta);
        } catch (e) {
          await this.deps.db.delete(schema.bets).where(eq(schema.bets.id, row!.id));
          throw e;
        }
      }
      this.deps.onChanged?.(input.tournamentId);
      return { id: row!.id };
    });
  }

  stake(userId: string, betId: string, side: string, amount: number, meta: Meta = {}): Promise<void> {
    return this.serial.run(async () => {
      await this.stakeInternal(userId, betId, side as BetSide, amount, meta);
    });
  }

  private async stakeInternal(userId: string, betId: string, side: BetSide, amount: number, meta: Meta): Promise<void> {
    this.enabled();
    if (!this.can(userId, 'sazky.sazet')) throw new BetError('FORBIDDEN');
    if (side !== 'yes' && side !== 'no') throw new BetError('INVALID', { field: 'side' });
    const s = this.s();
    if (!Number.isInteger(amount) || amount < Number(s['bets.minStake']) || amount > Number(s['bets.maxStake'])) throw new BetError('INVALID', { field: 'amount', min: Number(s['bets.minStake']), max: Number(s['bets.maxStake']) });
    const bet = await this.load(betId);
    const f = this.deps.facts(bet.tournamentId);
    if (bet.status !== 'open') throw new BetError('CLOSED');
    if (!f || this.isClosedFor(bet, f)) {
      await this.lockBet(bet);
      throw new BetError('CLOSED');
    }
    const params = bet.params as BetParams;
    const rel = favors(bet.subject as BetSubject, params, userId, side);
    if (subjectsOf(bet.subject as BetSubject, params).includes(userId)) {
      if (!s['bets.allowSelfBet']) throw new BetError('SELF');
      if (rel === 'against') throw new BetError('AGAINST_SELF');
    }
    const stakes = await this.stakesOf(betId);
    if (stakes.some((x) => x.userId === userId && x.side !== side)) throw new BetError('BOTH_SIDES');
    let matched = false;
    if (bet.kind === 'direct') {
      if (stakes.length === 0) {
        if (bet.creatorId !== userId) throw new BetError('INVALID', { field: 'creator' });
      } else if (stakes.length === 1) {
        const first = stakes[0]!;
        if (first.userId === userId || first.side === side || first.amount !== amount) throw new BetError('INVALID', { field: 'counter', amount: first.amount, side: first.side === 'yes' ? 'no' : 'yes' });
        matched = true;
      } else throw new BetError('FULL');
    }
    const id = crypto.randomUUID();
    pay(this.deps.ledger, () =>
      this.deps.ledger.post({ kind: 'bet_stake', idempotencyKey: `bet:${betId}:stake:${id}`, gameId: bet.tournamentId, createdBy: userId, entries: [{ account: accounts.wallet(userId), amount: -amount }, { account: accounts.escrow(`bet:${betId}`), amount }], note: 'vklad do sázky' }),
    );
    await this.deps.db.insert(schema.betStakes).values({ id, betId, userId, side, amount });
    if (matched) await this.deps.db.update(schema.bets).set({ status: 'locked' }).where(eq(schema.bets.id, betId));
    await this.deps.audit.log({ actorId: userId, action: 'sazka.vklad', targetType: 'bet', targetId: betId, after: { side, amount }, ...meta });
    this.deps.onWallet?.(userId);
    this.deps.onChanged?.(bet.tournamentId);
  }

  // ---------- uzavření, zrušení ----------

  /** Uzavře příjem vkladů (ručně, nebo když nastalo uzavírací pravidlo). Sázka bez protistrany se zruší a vklady se vrátí. */
  private async lockBet(bet: Bet): Promise<void> {
    if (bet.status !== 'open') return;
    const stakes = await this.stakesOf(bet.id);
    const yes = stakes.some((x) => x.side === 'yes');
    const no = stakes.some((x) => x.side === 'no');
    if (!yes || !no) {
      await this.settle(bet, 'void', 'bez protistrany');
      return;
    }
    await this.deps.db.update(schema.bets).set({ status: 'locked' }).where(eq(schema.bets.id, bet.id));
  }

  close(userId: string, betId: string, meta: Meta = {}): Promise<void> {
    return this.serial.run(async () => {
      const bet = await this.load(betId);
      if (bet.creatorId !== userId && !this.can(userId, 'sazky.rozhodnout')) throw new BetError('FORBIDDEN');
      if (bet.status !== 'open') throw new BetError('STATE');
      await this.lockBet(bet);
      await this.deps.audit.log({ actorId: userId, action: 'sazka.uzavrit', targetType: 'bet', targetId: betId, ...meta });
      this.deps.onChanged?.(bet.tournamentId);
    });
  }

  /** Zakladatel zruší sázku, dokud do ní nevložil nikdo jiný; vklad se vrátí. */
  cancel(userId: string, betId: string, meta: Meta = {}): Promise<void> {
    return this.serial.run(async () => {
      const bet = await this.load(betId);
      if (bet.creatorId !== userId && !this.can(userId, 'sazky.rozhodnout')) throw new BetError('FORBIDDEN');
      if (bet.status !== 'open') throw new BetError('STATE');
      const stakes = await this.stakesOf(betId);
      if (stakes.some((x) => x.userId !== bet.creatorId) && !this.can(userId, 'sazky.rozhodnout')) throw new BetError('STATE');
      await this.settle(bet, 'void', 'zrušeno');
      await this.deps.audit.log({ actorId: userId, action: 'sazka.zrusit', targetType: 'bet', targetId: betId, ...meta });
    });
  }

  // ---------- vypořádání ----------

  /** Vypoří sázku: vyplatí výherce (nebo vrátí vklady) z účtu escrow jednou transakcí. */
  private async settle(bet: Bet, outcome: BetOutcome, note?: string): Promise<void> {
    if (bet.status === 'settled' || bet.status === 'void') return;
    const stakes = await this.stakesOf(bet.id);
    const result = settlePool(stakes.map((x) => ({ userId: x.userId, side: x.side as BetSide, amount: x.amount })), outcome, bet.feePercent);
    const total = stakes.reduce((n, x) => n + x.amount, 0);
    if (total > 0) {
      const entries = [{ account: accounts.escrow(`bet:${bet.id}`), amount: -total }, ...result.payouts.map((p) => ({ account: accounts.wallet(p.userId), amount: p.amount }))];
      if (result.fee > 0) entries.push({ account: accounts.house(), amount: result.fee });
      this.deps.ledger.post({ kind: result.refunded ? 'bet_refund' : 'bet_payout', idempotencyKey: `bet:${bet.id}:settle`, gameId: bet.tournamentId, entries, note: result.refunded ? 'vrácení vkladů sázky' : 'výplata sázky' });
    }
    const paidBy = new Map(result.payouts.map((p) => [p.userId, p.amount]));
    const given = new Set<string>();
    for (const st of stakes) {
      const first = !given.has(st.userId);
      given.add(st.userId);
      const status = result.refunded ? 'refunded' : st.side === outcome ? 'paid' : 'lost';
      await this.deps.db.update(schema.betStakes).set({ status, payout: first ? (paidBy.get(st.userId) ?? 0) : 0 }).where(eq(schema.betStakes.id, st.id));
    }
    const final = result.refunded ? 'void' : 'settled';
    await this.deps.db.update(schema.bets).set({ status: final, outcome: result.refunded && outcome !== 'void' ? 'void' : outcome, settledAt: new Date(this.deps.now()), note: note ?? bet.note }).where(eq(schema.bets.id, bet.id));
    await this.deps.audit.log({ action: 'sazka.vyporadat', targetType: 'bet', targetId: bet.id, after: { outcome, refunded: result.refunded, fee: result.fee } });
    for (const u of new Set(stakes.map((x) => x.userId))) {
      this.deps.onWallet?.(u);
      void this.deps.notify?.(u, 'betSettled', { title: bet.title || bet.subject, amount: paidBy.get(u) ?? 0, refunded: result.refunded }, `/turnaj/${bet.tournamentId}`);
    }
    this.deps.onChanged?.(bet.tournamentId);
  }

  // ---------- vlastní tvrzení ----------

  /** Zakladatel navrhne výsledek vlastního tvrzení; ostatní mají dobu na zpochybnění, jinak se výsledek potvrdí sám. */
  propose(userId: string, betId: string, outcome: string, meta: Meta = {}): Promise<void> {
    return this.serial.run(async () => {
      const bet = await this.load(betId);
      if (bet.subject !== 'custom') throw new BetError('INVALID', { field: 'subject' });
      if (bet.creatorId !== userId && !this.can(userId, 'sazky.rozhodnout')) throw new BetError('FORBIDDEN');
      if (outcome !== 'yes' && outcome !== 'no') throw new BetError('INVALID', { field: 'outcome' });
      if (bet.status === 'open') await this.lockBet(bet);
      const fresh = await this.load(betId);
      if (fresh.status !== 'locked') throw new BetError('STATE');
      await this.deps.db.update(schema.bets).set({ status: 'proposed', proposedOutcome: outcome, proposedBy: userId, proposedAt: new Date(this.deps.now()) }).where(eq(schema.bets.id, betId));
      await this.deps.audit.log({ actorId: userId, action: 'sazka.navrhnout_vysledek', targetType: 'bet', targetId: betId, after: { outcome }, ...meta });
      for (const st of await this.stakesOf(betId)) if (st.userId !== userId) void this.deps.notify?.(st.userId, 'betProposed', { title: bet.title || bet.subject }, `/turnaj/${bet.tournamentId}`);
      this.deps.onChanged?.(bet.tournamentId);
    });
  }

  /** Strana, které navržený výsledek škodí, ho potvrdí (vypořádá se hned), nebo zpochybní (rozhodne rozhodčí). */
  respond(userId: string, betId: string, accept: boolean, meta: Meta = {}): Promise<void> {
    return this.serial.run(async () => {
      const bet = await this.load(betId);
      if (bet.status !== 'proposed' || !bet.proposedOutcome) throw new BetError('STATE');
      const stakes = await this.stakesOf(betId);
      const loses = stakes.some((x) => x.userId === userId && x.side !== bet.proposedOutcome);
      if (!loses) throw new BetError('NOT_ELIGIBLE');
      if (accept) await this.settle(bet, bet.proposedOutcome as BetOutcome, 'potvrzeno protistranou');
      else {
        await this.deps.db.update(schema.bets).set({ status: 'disputed' }).where(eq(schema.bets.id, betId));
        this.deps.onChanged?.(bet.tournamentId);
      }
      await this.deps.audit.log({ actorId: userId, action: accept ? 'sazka.potvrdit' : 'sazka.zpochybnit', targetType: 'bet', targetId: betId, ...meta });
    });
  }

  /** Rozhodčí (nikdy sázející) rozhodne spor; „void“ vrátí vklady. */
  decide(userId: string, betId: string, outcome: string, meta: Meta = {}): Promise<void> {
    return this.serial.run(async () => {
      if (!this.can(userId, 'sazky.rozhodnout')) throw new BetError('FORBIDDEN');
      if (outcome !== 'yes' && outcome !== 'no' && outcome !== 'void') throw new BetError('INVALID', { field: 'outcome' });
      const bet = await this.load(betId);
      if (bet.status !== 'disputed' && bet.status !== 'proposed' && bet.status !== 'locked') throw new BetError('STATE');
      if (bet.subject !== 'custom') throw new BetError('INVALID', { field: 'subject' });
      if ((await this.stakesOf(betId)).some((x) => x.userId === userId)) throw new BetError('FORBIDDEN', { reason: 'staker' });
      await this.settle(bet, outcome, 'rozhodl rozhodčí');
      await this.deps.audit.log({ actorId: userId, action: 'sazka.rozhodnout', targetType: 'bet', targetId: betId, after: { outcome }, ...meta });
    });
  }

  /** Volá plánovač: navržené výsledky bez sporu se po uplynutí doby potvrdí. */
  tick(): Promise<number> {
    return this.serial.run(async () => {
      const proposed = await this.deps.db.select().from(schema.bets).where(eq(schema.bets.status, 'proposed'));
      const wait = Number(this.s()['bets.disputeHours']) * 3600_000;
      let n = 0;
      for (const b of proposed) {
        if (!b.proposedAt || !b.proposedOutcome || this.deps.now() - b.proposedAt.getTime() < wait) continue;
        await this.settle(b, b.proposedOutcome as BetOutcome, 'potvrzeno uplynutím doby');
        n++;
      }
      return n;
    });
  }

  // ---------- události turnaje ----------

  /** Vyhodnotí a uzavře sázky podle aktuálního stavu turnaje (start, nový level, první vyřazený, konec, zrušení). */
  syncTournament(tournamentId: string): Promise<void> {
    return this.serial.run(async () => {
      const f = this.deps.facts(tournamentId);
      if (!f) return;
      const bets = await this.deps.db.select().from(schema.bets).where(and(eq(schema.bets.tournamentId, tournamentId), inArray(schema.bets.status, ['open', 'locked'])));
      for (const bet of bets) {
        const o = outcomeFor(bet.subject as BetSubject, bet.params as BetParams, f);
        if (o !== null) {
          await this.settle(bet, o);
          continue;
        }
        if (bet.status === 'open' && this.isClosedFor(bet, f)) await this.lockBet(bet);
        // vlastní tvrzení v zrušeném nebo skončeném turnaji bez návrhu zůstává čekat na zakladatele
      }
    });
  }

  // ---------- čtení ----------

  async list(viewerId: string, tournamentId: string) {
    const bets = await this.deps.db.select().from(schema.bets).where(eq(schema.bets.tournamentId, tournamentId)).orderBy(desc(schema.bets.createdAt));
    const stakes = bets.length ? await this.deps.db.select().from(schema.betStakes).where(inArray(schema.betStakes.betId, bets.map((b) => b.id))) : [];
    const f = this.deps.facts(tournamentId);
    // Přezdívky potřebuje i každý účastník turnaje (výběr hráče u odměn na hlavu a sázek), ne jen ti, kdo už jsou v nějaké sázce.
    const ids = [...new Set([...bets.flatMap((b) => [b.creatorId, ...subjectsOf(b.subject as BetSubject, b.params as BetParams)]), ...stakes.map((x) => x.userId), ...(f?.participants ?? [])])].filter((x): x is string => !!x);
    const nicks = ids.length ? new Map((await this.deps.db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, ids))).map((u) => [u.id, u.n])) : new Map<string, string>();
    const referee = this.can(viewerId, 'sazky.rozhodnout');
    const s = this.s();
    return {
      enabled: !!s['bets.enabled'],
      limits: { min: Number(s['bets.minStake']), max: Number(s['bets.maxStake']), feePercent: Number(s['bets.feePercent']), customEnabled: !!s['bets.customEnabled'], defaultClose: String(s['bets.defaultClose']), disputeHours: Number(s['bets.disputeHours']) },
      canCreate: this.can(viewerId, 'sazky.zalozit') && !!f && (f.status === 'registering' || f.status === 'running'),
      canStake: this.can(viewerId, 'sazky.sazet'),
      referee,
      players: f ? f.participants.map((u) => ({ userId: u, nickname: nicks.get(u) ?? '' })) : [],
      bets: bets.map((b) => {
        const mine = stakes.filter((x) => x.betId === b.id);
        const params = b.params as BetParams;
        return {
          id: b.id,
          kind: b.kind,
          subject: b.subject,
          params,
          title: b.title,
          status: b.status,
          closeRule: b.closeRule,
          outcome: b.outcome,
          proposedOutcome: b.proposedOutcome,
          proposedAt: b.proposedAt?.getTime() ?? null,
          creator: b.creatorId ? { userId: b.creatorId, nickname: nicks.get(b.creatorId) ?? '' } : null,
          subjects: subjectsOf(b.subject as BetSubject, params).map((u) => ({ userId: u, nickname: nicks.get(u) ?? '' })),
          totals: { yes: mine.filter((x) => x.side === 'yes').reduce((n, x) => n + x.amount, 0), no: mine.filter((x) => x.side === 'no').reduce((n, x) => n + x.amount, 0) },
          stakes: mine.map((x) => ({ userId: x.userId, nickname: nicks.get(x.userId) ?? '', side: x.side, amount: x.amount, status: x.status, payout: x.payout })),
          mine: mine.filter((x) => x.userId === viewerId).map((x) => ({ side: x.side, amount: x.amount, status: x.status, payout: x.payout })),
          feePercent: b.feePercent,
        };
      }),
    };
  }
}

// ---------- odměna na hlavu ----------

type Bounty = typeof schema.headBounties.$inferSelect;

/**
 * Odměna na hlavu: hráč ze svých peněz vypíše odměnu za vyřazení hráče v turnaji. Částka je zablokovaná na účtu
 * escrow; vyplatí se tomu, kdo hráče vyřadí (víc vyřazujících dělí podle váhy). Když ho nikdo nevyřadí, rozhodne nastavení.
 */
export class HeadBountyService {
  private serial = new Serial();
  /** Součet otevřených odměn podle turnaje a hráče (čtení bez databáze pro pohled stolu). */
  private wanted = new Map<string, Map<string, number>>();

  constructor(private deps: Deps) {}

  /** Počká, až doběhnou všechny rozpracované operace (testy, vypnutí serveru). */
  idle(): Promise<void> {
    return this.serial.run(async () => undefined);
  }

  private s() {
    return this.deps.settings();
  }

  post(userId: string, tournamentId: string, targetId: string, amount: number, meta: Meta = {}): Promise<{ id: string }> {
    return this.serial.run(async () => {
      const s = this.s();
      if (!s['headBounty.enabled']) throw new BetError('DISABLED');
      if (!this.deps.perms.can(userId, 'sazky.hlava').allowed) throw new BetError('FORBIDDEN');
      const f = this.deps.facts(tournamentId);
      if (!f) throw new BetError('NOT_FOUND');
      if (!f.headBounty) throw new BetError('DISABLED');
      if (f.status !== 'registering' && f.status !== 'running') throw new BetError('CLOSED');
      if (targetId === userId) throw new BetError('SELF');
      if (!f.participants.includes(targetId)) throw new BetError('NOT_ELIGIBLE');
      if (!Number.isInteger(amount) || amount < Number(s['headBounty.min']) || amount > Number(s['headBounty.max'])) throw new BetError('INVALID', { field: 'amount', min: Number(s['headBounty.min']), max: Number(s['headBounty.max']) });
      const mine = await this.deps.db.select({ id: schema.headBounties.id }).from(schema.headBounties).where(and(eq(schema.headBounties.tournamentId, tournamentId), eq(schema.headBounties.posterId, userId), inArray(schema.headBounties.status, ['open', 'pendingWinner'])));
      if (mine.length >= Number(s['headBounty.maxPerPoster'])) throw new BetError('LIMIT', { max: Number(s['headBounty.maxPerPoster']) });
      const id = crypto.randomUUID();
      pay(this.deps.ledger, () =>
        this.deps.ledger.post({ kind: 'head_bounty_post', idempotencyKey: `hb:${id}:post`, gameId: tournamentId, createdBy: userId, entries: [{ account: accounts.wallet(userId), amount: -amount }, { account: accounts.escrow(`hb:${id}`), amount }], note: 'odměna na hlavu' }),
      );
      await this.deps.db.insert(schema.headBounties).values({ id, tournamentId, targetId, posterId: userId, amount });
      await this.deps.audit.log({ actorId: userId, action: 'hlava.vypsat', targetType: 'head_bounty', targetId: id, after: { tournamentId, targetId, amount }, ...meta });
      this.addWanted(tournamentId, targetId, amount);
      this.deps.onWallet?.(userId);
      this.deps.onChanged?.(tournamentId);
      return { id };
    });
  }

  private move(b: Bounty, to: { account: string; userId?: string; amount: number }[], kind: 'head_bounty_payout' | 'head_bounty_return' | 'head_bounty_house', status: string, paidTo: { userId: string; amount: number }[] | null): Promise<void> {
    this.deps.ledger.post({ kind, idempotencyKey: `hb:${b.id}:settle`, gameId: b.tournamentId, entries: [{ account: accounts.escrow(`hb:${b.id}`), amount: -b.amount }, ...to.map((x) => ({ account: x.account, amount: x.amount }))], note: 'odměna na hlavu' });
    for (const x of to) if (x.userId) this.deps.onWallet?.(x.userId);
    return this.deps.db.update(schema.headBounties).set({ status, paidTo, settledAt: new Date(this.deps.now()) }).where(eq(schema.headBounties.id, b.id)).then(() => undefined);
  }

  private async open(tournamentId: string, statuses: string[], targetId?: string): Promise<Bounty[]> {
    return this.deps.db
      .select()
      .from(schema.headBounties)
      .where(and(eq(schema.headBounties.tournamentId, tournamentId), inArray(schema.headBounties.status, statuses), targetId ? eq(schema.headBounties.targetId, targetId) : undefined));
  }

  private async toPoster(b: Bounty): Promise<void> {
    await this.move(b, [{ account: accounts.wallet(b.posterId), userId: b.posterId, amount: b.amount }], 'head_bounty_return', 'returned', [{ userId: b.posterId, amount: b.amount }]);
    void this.deps.notify?.(b.posterId, 'headBountyReturned', { amount: b.amount }, `/turnaj/${b.tournamentId}`);
  }

  private async toHouse(b: Bounty): Promise<void> {
    await this.move(b, [{ account: accounts.house(), amount: b.amount }], 'head_bounty_house', 'forfeited', null);
  }

  /** Hráč vypadl: odměny na jeho hlavu dostane ten, kdo ho vyřadil. */
  onEliminated(tournamentId: string, victimId: string, killers: { userId: string; weight: number }[]): Promise<void> {
    return this.serial.run(async () => {
      const list = await this.open(tournamentId, ['open'], victimId);
      const valid = killers.filter((k) => k.userId !== victimId);
      for (const b of list) {
        if (valid.length > 0) {
          const shares = distribute(b.amount, valid.map((k) => k.weight));
          const paid = valid.map((k, i) => ({ userId: k.userId, amount: shares[i]! })).filter((x) => x.amount > 0);
          await this.move(b, paid.map((x) => ({ account: accounts.wallet(x.userId), userId: x.userId, amount: x.amount })), 'head_bounty_payout', 'paid', paid);
          for (const x of paid) void this.deps.notify?.(x.userId, 'headBountyPaid', { amount: x.amount }, `/turnaj/${tournamentId}`);
        } else {
          const rule = String(this.s()['headBounty.noKiller']);
          if (rule === 'house') await this.toHouse(b);
          else if (rule === 'winner') await this.deps.db.update(schema.headBounties).set({ status: 'pendingWinner' }).where(eq(schema.headBounties.id, b.id));
          else await this.toPoster(b);
        }
      }
      if (list.length) {
        await this.refreshWanted(tournamentId);
        this.deps.onChanged?.(tournamentId);
      }
    });
  }

  /** Turnaj skončil: nevyplacené odměny (hráč přežil, nebo vyřazení nikdo nezpůsobil) podle nastavení. */
  onFinished(tournamentId: string, winnerId: string | null): Promise<void> {
    return this.serial.run(async () => {
      const rule = String(this.s()['headBounty.survived']);
      for (const b of await this.open(tournamentId, ['open', 'pendingWinner'])) {
        const toWinner = b.status === 'pendingWinner' || rule === 'winner';
        if (toWinner && winnerId && winnerId !== b.targetId) {
          await this.move(b, [{ account: accounts.wallet(winnerId), userId: winnerId, amount: b.amount }], 'head_bounty_payout', 'paid', [{ userId: winnerId, amount: b.amount }]);
          void this.deps.notify?.(winnerId, 'headBountyPaid', { amount: b.amount }, `/turnaj/${tournamentId}`);
        } else if (rule === 'house' && b.status === 'open') await this.toHouse(b);
        else await this.toPoster(b);
      }
      await this.refreshWanted(tournamentId);
      this.deps.onChanged?.(tournamentId);
    });
  }

  /** Turnaj se zrušil: všechny odměny se vrací zadavatelům. */
  onCancelled(tournamentId: string): Promise<void> {
    return this.serial.run(async () => {
      for (const b of await this.open(tournamentId, ['open', 'pendingWinner'])) await this.toPoster(b);
      await this.refreshWanted(tournamentId);
      this.deps.onChanged?.(tournamentId);
    });
  }

  /** Odměny v turnaji: součet na hlavu hráče a kdo je vypsal. */
  async list(tournamentId: string) {
    const rows = await this.deps.db.select().from(schema.headBounties).where(eq(schema.headBounties.tournamentId, tournamentId)).orderBy(desc(schema.headBounties.createdAt));
    const ids = [...new Set(rows.flatMap((r) => [r.targetId, r.posterId]))];
    const nicks = ids.length ? new Map((await this.deps.db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, ids))).map((u) => [u.id, u.n])) : new Map<string, string>();
    const s = this.s();
    return {
      enabled: !!s['headBounty.enabled'] && (this.deps.facts(tournamentId)?.headBounty ?? true),
      limits: { min: Number(s['headBounty.min']), max: Number(s['headBounty.max']), maxPerPoster: Number(s['headBounty.maxPerPoster']) },
      bounties: rows.map((r) => ({ id: r.id, target: { userId: r.targetId, nickname: nicks.get(r.targetId) ?? '' }, poster: { userId: r.posterId, nickname: nicks.get(r.posterId) ?? '' }, amount: r.amount, status: r.status, paidTo: r.paidTo })),
    };
  }

  /** Načte otevřené odměny po startu serveru. */
  async init(): Promise<void> {
    const rows = await this.deps.db.select().from(schema.headBounties).where(inArray(schema.headBounties.status, ['open', 'pendingWinner']));
    this.wanted.clear();
    for (const r of rows) this.addWanted(r.tournamentId, r.targetId, r.amount);
  }

  private addWanted(tournamentId: string, userId: string, amount: number): void {
    const m = this.wanted.get(tournamentId) ?? new Map<string, number>();
    m.set(userId, (m.get(userId) ?? 0) + amount);
    this.wanted.set(tournamentId, m);
  }

  /** Okamžitý součet odměn na hlavu hráče (pro pohled stolu). */
  wantedSync(tournamentId: string, userId: string): number {
    return this.wanted.get(tournamentId)?.get(userId) ?? 0;
  }

  private async refreshWanted(tournamentId: string): Promise<void> {
    const rows = await this.open(tournamentId, ['open', 'pendingWinner']);
    this.wanted.delete(tournamentId);
    for (const r of rows) this.addWanted(tournamentId, r.targetId, r.amount);
  }

  /** Součet otevřených odměn na hlavu hráče (štítek „hledaný“ u avataru). */
  async wantedOf(tournamentId: string): Promise<Record<string, number>> {
    const rows = await this.open(tournamentId, ['open', 'pendingWinner']);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.targetId] = (out[r.targetId] ?? 0) + r.amount;
    return out;
  }
}
