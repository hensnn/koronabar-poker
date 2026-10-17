import { randomBytes } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { accounts, LedgerError, type Ledger } from '@kb/ledger';
import type { PermissionChecker, SettingValues } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';

export type LiveErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'CLOSED' | 'INSUFFICIENT_FUNDS' | 'UNSETTLED' | 'DISABLED' | 'PLAYER_PLAYING';

export class LiveError extends Error {
  constructor(
    public code: LiveErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export interface LivePlayer {
  userId: string;
  name: string;
  buyIns: number;
  /** Poplatek za čas, který hráč zaplatil (jde domu). */
  fee: number;
  cashOut: number;
  /** Hráč sedí u stolu (po cash-outu už ne, dokud znovu nekoupí žetony). */
  seated: boolean;
}

export interface LiveCashState {
  players: LivePlayer[];
  /** Pořadové číslo posledního pohybu (klíče v účetní knize se nikdy neopakují). */
  seq: number;
  log: { at: number; actorId: string; userId: string; kind: 'buyin' | 'topup' | 'fee' | 'cashout'; amount: number }[];
  closedAt: number | null;
}

type Meta = { ip?: string | null };

const emptyState = (): LiveCashState => ({ players: [], seq: 0, log: [], closedAt: null });

/**
 * Živý cash game (skutečné karty a žetony u stolu): aplikace jen eviduje buy-iny, top-upy, poplatek za čas a cash-outy.
 * Peníze leží na účtu stolu, takže při uzavření musí být součet cash-outů přesně roven součtu buy-inů bez poplatků.
 */
export class LiveCashService {
  constructor(
    private deps: {
      db: Db;
      ledger: Ledger;
      perms: PermissionChecker;
      audit: AuditService;
      settings: () => SettingValues;
      now: () => number;
      nickOf: (userId: string) => Promise<string>;
      onWallet?: (userId: string) => void;
      onChanged?: (id: string) => void;
      /** Nová živá cash hra (přiřazení k večeru). */
      onCreated?: (id: string) => void;
      /** Hra uzavřena: hráči a čas (XP). */
      onClosed?: (id: string, userIds: string[], at: number) => void;
      /** Buy-in nebo cash-out (hlasatel). */
      onMove?: (id: string, kind: 'buyin' | 'topup' | 'cashout', userId: string, nick: string, amount: number) => void;
    },
  ) {}

  private director(userId: string): void {
    if (!this.deps.settings()['live.enabled']) throw new LiveError('DISABLED');
    if (!this.deps.perms.can(userId, 'zivahra.rizeni').allowed) throw new LiveError('FORBIDDEN');
  }

  private async load(id: string): Promise<{ row: typeof schema.liveCashGames.$inferSelect; st: LiveCashState }> {
    const [row] = await this.deps.db.select().from(schema.liveCashGames).where(eq(schema.liveCashGames.id, id));
    if (!row) throw new LiveError('NOT_FOUND');
    return { row, st: (row.state as LiveCashState | null) ?? emptyState() };
  }

  private async save(id: string, st: LiveCashState, status?: string): Promise<void> {
    await this.deps.db.update(schema.liveCashGames).set({ state: st, ...(status ? { status } : {}) }).where(eq(schema.liveCashGames.id, id));
    this.deps.onChanged?.(id);
  }

  private open(row: { status: string }): void {
    if (row.status !== 'open') throw new LiveError('CLOSED');
  }

  async create(actorId: string, name: string, meta: Meta = {}): Promise<{ id: string }> {
    this.director(actorId);
    const clean = name.trim();
    if (clean.length < 2 || clean.length > 60) throw new LiveError('INVALID', { field: 'name' });
    const id = `lc-${randomBytes(4).toString('hex')}`;
    await this.deps.db.insert(schema.liveCashGames).values({ id, name: clean, ownerId: actorId, status: 'open', state: emptyState() });
    await this.deps.audit.log({ actorId, action: 'zivahra.cash_zalozit', targetType: 'live_cash', targetId: id, after: { name: clean }, ...meta });
    this.deps.onCreated?.(id);
    return { id };
  }

  private amount(n: unknown, min = 1): number {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > 1_000_000_000) throw new LiveError('INVALID', { field: 'amount' });
    return n;
  }

  private async player(st: LiveCashState, userId: string, create: boolean): Promise<LivePlayer | undefined> {
    let p = st.players.find((x) => x.userId === userId);
    if (!p && create) {
      p = { userId, name: await this.deps.nickOf(userId), buyIns: 0, fee: 0, cashOut: 0, seated: false };
      st.players.push(p);
    }
    return p;
  }

  /** Buy-in nebo top-up: peníze jdou z peněženky hráče na účet stolu. */
  async buyIn(actorId: string, id: string, userId: string, amount: number, meta: Meta = {}): Promise<void> {
    this.director(actorId);
    const a = this.amount(amount);
    const { row, st } = await this.load(id);
    this.open(row);
    if (!this.deps.perms.can(userId, 'turnaj.hrat').allowed && !this.deps.perms.can(userId, 'stul.hrat').allowed) throw new LiveError('FORBIDDEN');
    const p = (await this.player(st, userId, true))!;
    const kind = p.buyIns > 0 ? 'topup' : 'buyin';
    st.seq++;
    try {
      this.deps.ledger.post({ kind: kind === 'topup' ? 'cash_topup' : 'cash_buyin', idempotencyKey: `lc:${id}:${st.seq}`, gameId: id, createdBy: actorId, entries: [{ account: accounts.wallet(userId), amount: -a }, { account: accounts.table(id), amount: a }], note: 'živý cash' });
    } catch (e) {
      if (e instanceof LedgerError && e.code === 'INSUFFICIENT_FUNDS') throw new LiveError('INSUFFICIENT_FUNDS');
      throw e;
    }
    p.buyIns += a;
    p.seated = true;
    st.log.push({ at: this.deps.now(), actorId, userId, kind, amount: a });
    await this.save(id, st);
    this.deps.onWallet?.(userId);
    await this.deps.audit.log({ actorId, action: 'zivahra.cash_' + kind, targetType: 'live_cash', targetId: id, after: { userId, amount: a }, ...meta });
    this.deps.onMove?.(id, kind, userId, p.name, a);
  }

  /** Poplatek za čas: hráč ho platí z peněženky přímo domu (stůl se jím nezatěžuje). */
  async timeFee(actorId: string, id: string, userId: string, amount: number, meta: Meta = {}): Promise<void> {
    this.director(actorId);
    const a = this.amount(amount);
    const { row, st } = await this.load(id);
    this.open(row);
    const p = await this.player(st, userId, false);
    if (!p) throw new LiveError('INVALID', { field: 'userId' });
    st.seq++;
    try {
      this.deps.ledger.post({ kind: 'time_charge', idempotencyKey: `lc:${id}:${st.seq}`, gameId: id, createdBy: actorId, entries: [{ account: accounts.wallet(userId), amount: -a }, { account: accounts.house(), amount: a }], note: 'poplatek za čas, živý cash' });
    } catch (e) {
      if (e instanceof LedgerError && e.code === 'INSUFFICIENT_FUNDS') throw new LiveError('INSUFFICIENT_FUNDS');
      throw e;
    }
    p.fee += a;
    st.log.push({ at: this.deps.now(), actorId, userId, kind: 'fee', amount: a });
    await this.save(id, st);
    this.deps.onWallet?.(userId);
    await this.deps.audit.log({ actorId, action: 'zivahra.cash_poplatek', targetType: 'live_cash', targetId: id, after: { userId, amount: a }, ...meta });
  }

  /** Cash-out: hráč odchází od stolu a dostane částku za své žetony. Nesmí být víc, než je na účtu stolu. */
  async cashOut(actorId: string, id: string, userId: string, amount: number, meta: Meta = {}): Promise<void> {
    this.director(actorId);
    const a = this.amount(amount, 0);
    const { row, st } = await this.load(id);
    this.open(row);
    const p = await this.player(st, userId, false);
    if (!p || !p.seated) throw new LiveError('INVALID', { field: 'userId' });
    const pot = this.deps.ledger.balance(accounts.table(id));
    if (a > pot) throw new LiveError('INVALID', { field: 'amount', max: pot });
    st.seq++;
    if (a > 0) this.deps.ledger.post({ kind: 'cash_cashout', idempotencyKey: `lc:${id}:${st.seq}`, gameId: id, createdBy: actorId, entries: [{ account: accounts.table(id), amount: -a }, { account: accounts.wallet(userId), amount: a }], note: 'živý cash' });
    p.cashOut += a;
    p.seated = false;
    st.log.push({ at: this.deps.now(), actorId, userId, kind: 'cashout', amount: a });
    await this.save(id, st);
    this.deps.onWallet?.(userId);
    await this.deps.audit.log({ actorId, action: 'zivahra.cash_cashout', targetType: 'live_cash', targetId: id, after: { userId, amount: a }, ...meta });
    this.deps.onMove?.(id, 'cashout', userId, p.name, a);
  }

  /** Vyúčtování: hra se uzavře, až jsou všichni hráči po cash-outu a na účtu stolu nezbyla ani koruna. */
  async close(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    this.director(actorId);
    const { row, st } = await this.load(id);
    this.open(row);
    if (st.players.some((p) => p.seated)) throw new LiveError('PLAYER_PLAYING');
    const left = this.deps.ledger.balance(accounts.table(id));
    if (left !== 0) throw new LiveError('UNSETTLED', { left });
    st.closedAt = this.deps.now();
    const ranked = [...st.players].sort((a, b) => b.cashOut - b.buyIns - b.fee - (a.cashOut - a.buyIns - a.fee));
    const finishedAt = new Date(st.closedAt);
    if (ranked.length > 0) {
      await this.deps.db
        .insert(schema.gameResults)
        .values(ranked.map((p, i) => ({ kind: 'live_cash', ref: id, userId: p.userId, finishedAt, place: i + 1, field: ranked.length, spent: p.buyIns + p.fee, payout: p.cashOut, live: true })))
        .onConflictDoNothing();
    }
    await this.save(id, st, 'closed');
    await this.deps.audit.log({ actorId, action: 'zivahra.cash_uzavrit', targetType: 'live_cash', targetId: id, ...meta });
    this.deps.onClosed?.(id, ranked.map((p) => p.userId), st.closedAt);
  }

  async list(): Promise<{ id: string; name: string; status: string; players: number; createdAt: number }[]> {
    const rows = await this.deps.db.select().from(schema.liveCashGames).orderBy(desc(schema.liveCashGames.createdAt)).limit(50);
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, players: ((r.state as LiveCashState | null)?.players ?? []).length, createdAt: r.createdAt.getTime() }));
  }

  async view(id: string, viewerId: string) {
    const { row, st } = await this.load(id);
    const pot = this.deps.ledger.balance(accounts.table(id));
    return {
      id,
      name: row.name,
      status: row.status,
      pot,
      buyIns: st.players.reduce((a, p) => a + p.buyIns, 0),
      fees: st.players.reduce((a, p) => a + p.fee, 0),
      closedAt: st.closedAt,
      timeFeePerHour: Number(this.deps.settings()['live.cashTimeFeePerHour']),
      players: st.players.map((p) => ({ ...p, net: p.cashOut - p.buyIns - p.fee })),
      log: st.log.slice(-50).reverse(),
      director: this.deps.perms.can(viewerId, 'zivahra.rizeni').allowed,
    };
  }
}
