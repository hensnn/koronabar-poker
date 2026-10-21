import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, like, lte, or, sql } from 'drizzle-orm';
import { accounts, minimalTransfers, type Entry, type Ledger, type Transfer } from '@kb/ledger';
import type { SettingValues } from '@kb/shared';
import { PermissionError, type PermissionService } from '../auth/permissions.js';
import type { ApprovalService } from '../auth/approvals.js';
import type { AuditService, AuditSource } from '../auth/audit.js';
import { schema, type Db } from '../db/index.js';

export interface WalletMeta {
  ip?: string | null;
  source?: AuditSource;
}

/** Složky vyúčtování: cash (vklady a výběry), turnaje (buy-in, rebuy, add-on, výhra, bounty, vrácení) a ostatní pohyby. Vklady a náklady jsou záporné, výhry kladné. */
export const SETTLEMENT_PARTS = ['cashBuyIn', 'cashOut', 'buyIn', 'rebuy', 'addon', 'payout', 'bounty', 'refund', 'other'] as const;
export type SettlementPart = (typeof SETTLEMENT_PARTS)[number];
export type PartTotals = Partial<Record<SettlementPart, number>>;

/** Do které složky patří pohyb peněženky podle druhu transakce. */
export function settlementPartOf(kind: string): SettlementPart {
  switch (kind) {
    case 'cash_buyin':
    case 'cash_topup':
      return 'cashBuyIn';
    case 'cash_cashout':
    case 'cash_return':
      return 'cashOut';
    case 'turnaj_buyin':
    case 'turnaj_fee':
      return 'buyIn';
    case 'turnaj_rebuy':
      return 'rebuy';
    case 'turnaj_addon':
      return 'addon';
    case 'turnaj_vyplata':
      return 'payout';
    case 'bounty':
      return 'bounty';
    case 'turnaj_refund':
      return 'refund';
    default:
      return 'other';
  }
}

export interface PeriodSettlement {
  from: number;
  to: number;
  players: { userId: string; cash: number; tournament: number; total: number; parts: PartTotals }[];
  games: { id: string; name: string; kind: 'cash' | 'tournament'; results: Record<string, number>; parts: Record<string, PartTotals> }[];
  transfers: Transfer[];
  names: Record<string, string>;
  /** Kolik za období připadlo herně (rake, poplatky, odvody); jen pro oprávněné. */
  house: number | null;
}

/** Poznámka k ruční úpravě knihy, která je výdajem domu (zapíše se do přehledu výdajů). */
export interface HouseExpenseNote {
  category: string;
  amount: number;
  note: string;
}
/** Filtry knihy pro pokladníka. */
export interface LedgerFilters {
  kind?: string;
  account?: string;
  from?: number;
  to?: number;
  q?: string;
  gameId?: string;
  minAmount?: number;
  limit?: number;
  /** Řazení: čas (výchozí, podle čísla pohybu), druh, nebo největší částka na pohybu; směr `asc` nebo `desc` (výchozí). */
  sort?: 'time' | 'kind' | 'amount';
  dir?: 'asc' | 'desc';
}

/** Rozpad vydané měny: kolik se jí vydalo a kde je teď. */
export interface BalanceReconciliation {
  issued: number;
  wallets: number;
  house: number;
  funds: number;
  tables: number;
  tournaments: number;
  external: number;
  issuedBy: { id: number; at: number; kind: string; note: string; amount: number; to: string }[];
}
export type WalletResult = { done: true; txId: number } | { done: false; approvalId: string };

const AMOUNT = (n: unknown): number => {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new PermissionError('INVALID', { field: 'amount' });
  return n;
};

/**
 * Peněžní operace správců nad peněženkami hráčů. Každá jde přes oprávnění (limity za operaci a za den),
 * volitelně přes schválení druhou osobou, a vždy přes účetní knihu a audit. Měna je čistě virtuální.
 */
export class WalletService {
  constructor(
    private deps: {
      db: Db;
      ledger: Ledger;
      perms: PermissionService;
      audit: AuditService;
      approvals: ApprovalService;
      settings: () => SettingValues;
      notify?: (e: { kind: 'request_created' | 'request_decided'; requestId: string; userId: string; approved?: boolean }) => void;
    },
  ) {
    deps.approvals.register('mena.dobit', async (p, by) => (await this.execTopUp(by, p as never)).txId);
    deps.approvals.register('mena.strhnout', async (p, by) => (await this.execDebit(by, p as never)).txId);
    deps.approvals.register('mena.upravit_knihu', async (p, by) => (await this.execAdjust(by, p as never)).txId);
  }

  // ---------- dobití a strhnutí ----------

  async topUp(actorId: string, userId: string, amount: number, reason: string, meta: WalletMeta = {}): Promise<WalletResult> {
    AMOUNT(amount);
    if (!reason?.trim()) throw new PermissionError('INVALID', { field: 'reason' });
    await this.assertUser(userId);
    const d = this.deps.perms.can(actorId, 'mena.dobit', { amount });
    if (!d.allowed) throw new PermissionError(d.reasonKey === 'permission.limitExceeded' ? 'LIMIT_EXCEEDED' : 'FORBIDDEN', { limits: d.limits });
    if (d.needsApproval) return { done: false, approvalId: await this.deps.approvals.request(actorId, 'mena.dobit', { userId, amount, reason }, meta) };
    await this.deps.perms.consumeDaily(actorId, 'mena.dobit', amount);
    return { done: true, txId: (await this.execTopUp(actorId, { userId, amount, reason }, meta)).txId };
  }

  private async execTopUp(actorId: string, p: { userId: string; amount: number; reason: string }, meta: WalletMeta = {}) {
    const tx = this.deps.ledger.post({
      kind: 'mint',
      idempotencyKey: `topup:${randomUUID()}`,
      entries: [
        { account: accounts.mint(), amount: -p.amount },
        { account: accounts.wallet(p.userId), amount: p.amount },
      ],
      createdBy: actorId,
      note: p.reason,
    });
    await this.deps.audit.log({ actorId, action: 'mena.dobit', targetType: 'user', targetId: p.userId, after: { amount: p.amount, txId: tx.id }, reason: p.reason, ...meta });
    return { txId: tx.id };
  }

  async debit(actorId: string, userId: string, amount: number, reason: string, meta: WalletMeta = {}): Promise<WalletResult> {
    AMOUNT(amount);
    if (!reason?.trim()) throw new PermissionError('INVALID', { field: 'reason' });
    await this.assertUser(userId);
    const d = this.deps.perms.can(actorId, 'mena.strhnout', { amount });
    if (!d.allowed) throw new PermissionError(d.reasonKey === 'permission.limitExceeded' ? 'LIMIT_EXCEEDED' : 'FORBIDDEN', { limits: d.limits });
    if (d.needsApproval) return { done: false, approvalId: await this.deps.approvals.request(actorId, 'mena.strhnout', { userId, amount, reason }, meta) };
    await this.deps.perms.consumeDaily(actorId, 'mena.strhnout', amount);
    return { done: true, txId: (await this.execDebit(actorId, { userId, amount, reason }, meta)).txId };
  }

  private async execDebit(actorId: string, p: { userId: string; amount: number; reason: string }, meta: WalletMeta = {}) {
    // Strhnutá měna se nevytrácí: jde na účet domu (a ze zůstatku, který hráč opravdu má).
    const tx = this.deps.ledger.post({
      kind: 'manual_adjustment',
      idempotencyKey: `debit:${randomUUID()}`,
      entries: [
        { account: accounts.wallet(p.userId), amount: -p.amount },
        { account: accounts.house(), amount: p.amount },
      ],
      createdBy: actorId,
      note: p.reason,
    });
    await this.deps.audit.log({ actorId, action: 'mena.strhnout', targetType: 'user', targetId: p.userId, after: { amount: p.amount, txId: tx.id }, reason: p.reason, ...meta });
    return { txId: tx.id };
  }

  /** Ruční úprava knihy: libovolné vyvážené záznamy mezi účty, vždy s důvodem. */
  async adjust(actorId: string, entries: Entry[], reason: string, meta: WalletMeta = {}, houseExpense?: HouseExpenseNote): Promise<WalletResult> {
    if (!reason?.trim()) throw new PermissionError('INVALID', { field: 'reason' });
    if (entries.length < 2) throw new PermissionError('INVALID', { field: 'entries' });
    const d = this.deps.perms.can(actorId, 'mena.upravit_knihu');
    if (!d.allowed) throw new PermissionError('FORBIDDEN');
    if (d.needsApproval) return { done: false, approvalId: await this.deps.approvals.request(actorId, 'mena.upravit_knihu', { entries, reason, houseExpense }, meta) };
    return { done: true, txId: (await this.execAdjust(actorId, { entries, reason, houseExpense }, meta)).txId };
  }

  private async execAdjust(actorId: string, p: { entries: Entry[]; reason: string; houseExpense?: HouseExpenseNote }, meta: WalletMeta = {}) {
    const tx = this.deps.ledger.post({ kind: 'manual_adjustment', idempotencyKey: `adjust:${randomUUID()}`, entries: p.entries, createdBy: actorId, note: p.reason });
    // Výdaj domu se zapíše do přehledu až při provedení (i po schválení druhou osobou).
    if (p.houseExpense) await this.deps.db.insert(schema.houseExpenses).values({ category: p.houseExpense.category, amount: p.houseExpense.amount, note: p.houseExpense.note.slice(0, 300), createdBy: actorId, txId: tx.id, at: new Date(tx.at) });
    await this.deps.audit.log({ actorId, action: 'mena.upravit_knihu', targetType: 'ledger', targetId: String(tx.id), after: { entries: p.entries }, reason: p.reason, ...meta });
    return { txId: tx.id };
  }

  private async assertUser(userId: string) {
    const [u] = await this.deps.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId));
    if (!u) throw new PermissionError('NOT_FOUND', { what: 'user' });
  }

  // ---------- žádosti hráčů ----------

  async createRequest(userId: string, input: { kind: 'dobiti' | 'role' | 'schvaleni' | 'prevod'; amount?: number; message?: string; payload?: unknown }): Promise<string> {
    if (!this.deps.perms.can(userId, 'zadost.vytvorit').allowed) throw new PermissionError('FORBIDDEN');
    if (input.kind === 'dobiti') AMOUNT(input.amount);
    if (input.kind === 'prevod') this.checkTransfer(userId, input.amount, (input.payload as { target?: string } | null)?.target);
    const pending = await this.deps.db.select({ id: schema.userRequests.id }).from(schema.userRequests).where(and(eq(schema.userRequests.userId, userId), eq(schema.userRequests.kind, input.kind), eq(schema.userRequests.status, 'pending')));
    if (pending.length >= 3) throw new PermissionError('LIMIT_EXCEEDED', { what: 'pending_requests' });
    const [row] = await this.deps.db
      .insert(schema.userRequests)
      .values({ userId, kind: input.kind, amount: input.amount ?? null, message: input.message?.slice(0, 500) ?? null, payload: (input.payload ?? null) as never })
      .returning({ id: schema.userRequests.id });
    await this.deps.audit.log({ actorId: userId, action: 'zadost.vytvorit', targetType: 'request', targetId: row!.id, after: { kind: input.kind, amount: input.amount } });
    this.deps.notify?.({ kind: 'request_created', requestId: row!.id, userId });
    return row!.id;
  }

  /** Cílové aplikace převodů z nastavení. */
  transferTargets(): string[] {
    return [...new Set(String(this.deps.settings()['economy.transferTargets'] ?? '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean))];
  }

  /** Kontrola žádosti o převod do jiné aplikace: zapnuto, povolený cíl, částka v mezích a dostatek Koron (bez mínusu). */
  private checkTransfer(userId: string, amount: number | undefined, target: string | undefined): void {
    const s = this.deps.settings();
    if (!s['economy.transferEnabled']) throw new PermissionError('INVALID', { field: 'transfer_disabled' });
    AMOUNT(amount);
    if (!target || !this.transferTargets().includes(target)) throw new PermissionError('INVALID', { field: 'target' });
    if (amount! < Number(s['economy.transferMin']) || amount! > Number(s['economy.transferMax'])) throw new PermissionError('INVALID', { field: 'amount' });
    if (this.deps.ledger.balance(accounts.wallet(userId)) < amount!) throw new PermissionError('INVALID', { field: 'balance' });
  }

  async cancelRequest(userId: string, id: string): Promise<void> {
    const [r] = await this.deps.db.update(schema.userRequests).set({ status: 'cancelled', decidedAt: new Date() }).where(and(eq(schema.userRequests.id, id), eq(schema.userRequests.userId, userId), eq(schema.userRequests.status, 'pending'))).returning({ id: schema.userRequests.id });
    if (!r) throw new PermissionError('NOT_FOUND');
  }

  /** Vlastní žádosti; správci s oprávněním vidí všechny. */
  async listRequests(actorId: string, opts: { all?: boolean; status?: string } = {}) {
    const all = opts.all && this.deps.perms.can(actorId, 'mena.vyridit_zadost').allowed;
    const rows = await this.deps.db
      .select()
      .from(schema.userRequests)
      .where(and(all ? undefined : eq(schema.userRequests.userId, actorId), opts.status ? eq(schema.userRequests.status, opts.status) : undefined))
      .orderBy(desc(schema.userRequests.createdAt))
      .limit(200);
    return rows;
  }

  async decideRequest(actorId: string, id: string, approve: boolean, note: string | null = null, meta: WalletMeta = {}): Promise<{ status: string; txId?: number }> {
    const [r] = await this.deps.db.select().from(schema.userRequests).where(eq(schema.userRequests.id, id));
    if (!r) throw new PermissionError('NOT_FOUND');
    if (r.status !== 'pending') throw new PermissionError('INVALID', { field: 'status', status: r.status });
    if (r.userId === actorId) throw new PermissionError('FORBIDDEN', { reason: 'self_approval' });
    // Limit částky se týká jen schválení (zamítnout smí kdokoli s oprávněním).
    if (!this.deps.perms.can(actorId, 'mena.vyridit_zadost', approve ? { amount: r.amount ?? undefined } : {}).allowed) throw new PermissionError('FORBIDDEN');
    let txId: number | undefined;
    if (approve && r.kind === 'dobiti') {
      // Vyřízení žádosti je dobití z účtu „vydání měny“ v rámci limitů vyřizujícího.
      const d = this.deps.perms.can(actorId, 'mena.vyridit_zadost', { amount: r.amount ?? 0 });
      if (!d.allowed) throw new PermissionError('LIMIT_EXCEEDED', { limits: d.limits });
      txId = (await this.execTopUp(actorId, { userId: r.userId, amount: r.amount!, reason: `žádost ${id}${note ? `: ${note}` : ''}` }, meta)).txId;
    }
    if (approve && r.kind === 'prevod') {
      // Odepsání z peněženky na účet „převod ven“ (žádné peníze); znovu se ověří zůstatek i nastavení.
      const target = (r.payload as { target?: string } | null)?.target;
      this.checkTransfer(r.userId, r.amount ?? undefined, target);
      const tx = this.deps.ledger.post({
        kind: 'transfer_out',
        idempotencyKey: `transfer:${id}`,
        entries: [
          { account: accounts.wallet(r.userId), amount: -r.amount! },
          { account: accounts.external(target!), amount: r.amount! },
        ],
        createdBy: actorId,
        note: `převod do: ${target}${note ? ` (${note})` : ''}`,
      });
      txId = tx.id;
    }
    await this.deps.db.update(schema.userRequests).set({ status: approve ? 'approved' : 'rejected', decidedBy: actorId, decidedAt: new Date(), decisionNote: note }).where(eq(schema.userRequests.id, id));
    await this.deps.audit.log({ actorId, action: approve ? 'zadost.schvalit' : 'zadost.zamitnout', targetType: 'request', targetId: id, after: { kind: r.kind, txId }, reason: note, ...meta });
    this.deps.notify?.({ kind: 'request_decided', requestId: id, userId: r.userId, approved: approve });
    return { status: approve ? 'approved' : 'rejected', txId };
  }

  // ---------- přehledy ----------

  /** Pohyby vlastní peněženky. */
  async walletHistory(userId: string, limit = 100) {
    const acc = accounts.wallet(userId);
    const rows = await this.deps.db
      .select({ id: schema.ledgerTransactions.id, kind: schema.ledgerTransactions.kind, at: schema.ledgerTransactions.at, gameId: schema.ledgerTransactions.gameId, note: schema.ledgerTransactions.note, amount: schema.ledgerEntries.amount })
      .from(schema.ledgerEntries)
      .innerJoin(schema.ledgerTransactions, eq(schema.ledgerTransactions.id, schema.ledgerEntries.transactionId))
      .where(eq(schema.ledgerEntries.account, acc))
      .orderBy(desc(schema.ledgerTransactions.id))
      .limit(Math.min(limit, 500));
    return rows;
  }

  /** Řazení knihy; při shodě vždy podle čísla pohybu, aby bylo pořadí stabilní. */
  private ledgerOrder(f: LedgerFilters) {
    const lt_ = schema.ledgerTransactions;
    const dir = f.dir === 'asc' ? asc : desc;
    if (f.sort === 'kind') return [dir(lt_.kind), dir(lt_.id)];
    if (f.sort === 'amount') return [dir(sql`(select max(abs(e.amount)) from ledger_entries e where e.transaction_id = ${lt_.id})`), dir(lt_.id)];
    return [dir(lt_.id)];
  }

  /** Druhy pohybů, které se v knize vyskytují (pro filtr). */
  async ledgerKinds(actorId: string): Promise<string[]> {
    if (!this.deps.perms.can(actorId, 'mena.zobrazit_knihu').allowed) throw new PermissionError('FORBIDDEN');
    const rows = await this.deps.db.selectDistinct({ kind: schema.ledgerTransactions.kind }).from(schema.ledgerTransactions);
    return rows.map((r) => r.kind).sort();
  }

  /**
   * Kniha pro pokladníka s filtry: druh pohybu, účet (např. `wallet:<hráč>`, `house`, `mint`), období, text v poznámce, hra
   * a nejmenší částka na některém záznamu. Nejnovější první, nejvýš 500 řádků.
   */
  async ledgerOverview(actorId: string, limitOrFilters: number | LedgerFilters = 100, maxRows = 500) {
    if (!this.deps.perms.can(actorId, 'mena.zobrazit_knihu').allowed) throw new PermissionError('FORBIDDEN');
    const f: LedgerFilters = typeof limitOrFilters === 'number' ? { limit: limitOrFilters } : limitOrFilters;
    const lt_ = schema.ledgerTransactions;
    const le = schema.ledgerEntries;
    const conds = [];
    if (f.kind) conds.push(eq(lt_.kind, f.kind));
    if (f.from !== undefined) conds.push(gte(lt_.at, new Date(f.from)));
    if (f.to !== undefined) conds.push(lte(lt_.at, new Date(f.to)));
    if (f.q) conds.push(sql`lower(coalesce(${lt_.note}, '')) like ${'%' + f.q.toLowerCase().replace(/[%_\\]/g, (c) => '\\' + c) + '%'}`);
    if (f.gameId) conds.push(eq(lt_.gameId, f.gameId));
    if (f.account || f.minAmount) {
      const inner = [eq(le.transactionId, lt_.id)];
      if (f.account) inner.push(eq(le.account, f.account));
      if (f.minAmount) inner.push(sql`abs(${le.amount}) >= ${f.minAmount}`);
      conds.push(sql`exists (select 1 from ${le} where ${and(...inner)})`);
    }
    const txs = await this.deps.db.select().from(lt_).where(and(...conds)).orderBy(...this.ledgerOrder(f)).limit(Math.max(1, Math.min(f.limit ?? 100, maxRows)));
    const ids = txs.map((t) => t.id);
    const entries = ids.length ? await this.deps.db.select().from(schema.ledgerEntries).where(inArray(schema.ledgerEntries.transactionId, ids)).orderBy(asc(schema.ledgerEntries.seq)) : [];
    return txs.map((t) => ({ ...t, entries: entries.filter((e) => e.transactionId === t.id).map((e) => ({ account: e.account, amount: e.amount })) }));
  }

  /**
   * Odkud se vzala a kde je všechna vydaná měna: součet vydané měny (účet mint) se rozpadne na peněženky, dům, fondy, stoly,
   * turnaje a převody ven, a vypíše se posledních 30 vydání (registrace, dobití, garance…) s příjemcem.
   */
  private reconcile(nick: Map<string, string>): BalanceReconciliation {
    const by = new Map<string, number>();
    const mints: BalanceReconciliation['issuedBy'] = [];
    const txs = this.deps.ledger.transactions();
    for (const tx of txs) {
      for (const e of tx.entries) by.set(e.account, (by.get(e.account) ?? 0) + e.amount);
      const m = tx.entries.find((e) => e.account === accounts.mint());
      if (m) {
        const to = tx.entries.find((e) => e.account !== accounts.mint() && e.amount > 0);
        mints.push({ id: tx.id, at: tx.at, kind: tx.kind, note: tx.note ?? '', amount: -m.amount, to: to ? (nick.get(to.account) ?? to.account) : '' });
      }
    }
    const sum = (prefix: string) => [...by].filter(([a]) => a.startsWith(prefix)).reduce((n, [, v]) => n + v, 0);
    return {
      issued: -(by.get(accounts.mint()) ?? 0),
      wallets: sum('wallet:'),
      house: by.get(accounts.house()) ?? 0,
      funds: sum('fund:'),
      tables: sum('table:'),
      tournaments: sum('tournament:') + sum('bounty:') + sum('escrow:'),
      external: sum('external:'),
      issuedBy: mints.sort((a, b) => b.id - a.id).slice(0, 30),
    };
  }

  /** Stavy účtů všech hráčů pro pokladníka: zůstatek peněženky, stav účtu a poslední pohyb; součty za celou hernu. */
  async balances(actorId: string): Promise<{ rows: { userId: string; nickname: string; status: string; balance: number; lastMoveAt: number | null }[]; totals: { wallets: number; house: number; players: number }; reconciliation: BalanceReconciliation }> {
    if (!this.deps.perms.can(actorId, 'mena.zobrazit_knihu').allowed) throw new PermissionError('FORBIDDEN');
    const db = this.deps.db;
    const users = await db.select({ id: schema.users.id, nickname: schema.users.nickname, status: schema.users.status }).from(schema.users);
    const last = await db
      .select({ account: schema.ledgerEntries.account, at: sql<Date>`max(${schema.ledgerTransactions.at})` })
      .from(schema.ledgerEntries)
      .innerJoin(schema.ledgerTransactions, eq(schema.ledgerTransactions.id, schema.ledgerEntries.transactionId))
      .where(like(schema.ledgerEntries.account, 'wallet:%'))
      .groupBy(schema.ledgerEntries.account);
    const lastBy = new Map(last.map((r) => [r.account, new Date(r.at).getTime()]));
    const rows = users
      .map((u) => ({ userId: u.id, nickname: u.nickname, status: u.status, balance: this.deps.ledger.balance(accounts.wallet(u.id)), lastMoveAt: lastBy.get(accounts.wallet(u.id)) ?? null }))
      .sort((a, b) => b.balance - a.balance || a.nickname.localeCompare(b.nickname, 'cs'));
    const nick = new Map(users.map((u) => [accounts.wallet(u.id), u.nickname]));
    return { rows, totals: { wallets: rows.reduce((n, r) => n + r.balance, 0), house: this.deps.ledger.balance(accounts.house()), players: rows.length }, reconciliation: this.reconcile(nick) };
  }

  houseBalances(actorId: string): Record<string, number> {
    if (!this.deps.perms.can(actorId, 'mena.zobrazit_dum').allowed) throw new PermissionError('FORBIDDEN');
    const out: Record<string, number> = { house: this.deps.ledger.balance(accounts.house()) };
    return out;
  }

  // ---------- vyúčtování ----------

  /**
   * Vyúčtování období (večera, sezóny): čistý výsledek každého hráče z cash her a z turnajů zvlášť i dohromady
   * podle pohybů v peněžence (u stolů, kde hráč ještě sedí, se připočítají žetony u stolu), rozpad po hrách a minimální seznam převodů. Zisk herny (rake, poplatky, odvody)
   * se nedělí mezi hráče, v převodech je na straně „domu“. Hráči, kteří u cash stolu stále sedí, se počítají podle žetonů u stolu.
   * Vidí ho ten, kdo je jeho součástí (jen svůj řádek a své převody), nebo kdo má oprávnění „mena.vyuctovani“.
   */
  async settlementForPeriod(actorId: string, fromMs: number, toMs: number, seated: { userId: string; tableId: string; chips: number }[] = []): Promise<PeriodSettlement> {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) throw new PermissionError('INVALID', { field: 'period' });
    const txs = await this.deps.db
      .select({ id: schema.ledgerTransactions.id, kind: schema.ledgerTransactions.kind, gameId: schema.ledgerTransactions.gameId })
      .from(schema.ledgerTransactions)
      .where(and(gte(schema.ledgerTransactions.at, new Date(fromMs)), lte(schema.ledgerTransactions.at, new Date(toMs)), or(like(schema.ledgerTransactions.kind, 'cash_%'), like(schema.ledgerTransactions.kind, 'turnaj_%'), eq(schema.ledgerTransactions.kind, 'bounty'), eq(schema.ledgerTransactions.kind, 'jackpot_payout'))));
    const byId = new Map(txs.map((t) => [t.id, t]));
    const ids = [...byId.keys()];
    const entries = ids.length ? await this.deps.db.select().from(schema.ledgerEntries).where(and(inArray(schema.ledgerEntries.transactionId, ids), like(schema.ledgerEntries.account, 'wallet:%'))) : [];

    const cash: Record<string, number> = {};
    const tournament: Record<string, number> = {};
    const games = new Map<string, { id: string; kind: 'cash' | 'tournament'; results: Record<string, number>; parts: Record<string, PartTotals> }>();
    const parts: Record<string, PartTotals> = {};
    const addPart = (target: Record<string, PartTotals>, uid: string, part: SettlementPart, amount: number) => {
      const p = (target[uid] ??= {});
      p[part] = (p[part] ?? 0) + amount;
    };
    for (const e of entries) {
      const tx = byId.get(e.transactionId)!;
      const uid = e.account.slice('wallet:'.length);
      const kind = tx.kind.startsWith('turnaj_') || tx.kind === 'bounty' ? 'tournament' : 'cash';
      (kind === 'tournament' ? tournament : cash)[uid] = ((kind === 'tournament' ? tournament : cash)[uid] ?? 0) + e.amount;
      const gid = tx.gameId ?? '';
      const g = games.get(gid) ?? { id: gid, kind, results: {}, parts: {} };
      g.results[uid] = (g.results[uid] ?? 0) + e.amount;
      const part = settlementPartOf(tx.kind);
      addPart(parts, uid, part, e.amount);
      addPart(g.parts, uid, part, e.amount);
      games.set(gid, g);
    }
    // Hráči, kteří u cash stolu ještě sedí, mají žetony u stolu: počítají se jako výběr (jen když období sahá do současnosti).
    if (toMs >= Date.now() - 60_000) {
      const rate = Number(this.deps.settings()['cash.chipsPerCurrencyUnit']) || 1;
      for (const s of seated) {
        const value = Math.floor(s.chips / rate);
        if (value === 0 && !cash[s.userId]) continue;
        cash[s.userId] = (cash[s.userId] ?? 0) + value;
        const g = games.get(s.tableId) ?? { id: s.tableId, kind: 'cash' as const, results: {}, parts: {} };
        g.results[s.userId] = (g.results[s.userId] ?? 0) + value;
        addPart(parts, s.userId, 'cashOut', value);
        addPart(g.parts, s.userId, 'cashOut', value);
        games.set(s.tableId, g);
      }
    }
    const involved = [...new Set([...Object.keys(cash), ...Object.keys(tournament)])];
    const privileged = this.deps.perms.can(actorId, 'mena.vyuctovani').allowed;
    if (!involved.includes(actorId) && !privileged) throw new PermissionError('FORBIDDEN');

    const total: Record<string, number> = {};
    for (const id of involved) total[id] = (cash[id] ?? 0) + (tournament[id] ?? 0);
    const sum = Object.values(total).reduce((a, b) => a + b, 0);
    const nonZero = Object.fromEntries(Object.entries(total).filter(([, v]) => v !== 0));
    // Co hráči dohromady prohráli nebo vyhráli proti herně (rake, poplatky, odvody, garance), patří domu.
    const transferBalances = sum !== 0 ? { ...nonZero, __dum: -sum } : nonZero;
    let transfers = minimalTransfers(transferBalances);

    const users = involved.length ? await this.deps.db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, involved)) : [];
    const gameIds = [...games.keys()].filter(Boolean);
    const tableNames = gameIds.length ? await this.deps.db.select({ id: schema.gameTables.id, name: schema.gameTables.name }).from(schema.gameTables).where(inArray(schema.gameTables.id, gameIds)) : [];
    const tourNames = gameIds.length ? await this.deps.db.select({ id: schema.tournaments.id, name: schema.tournaments.name }).from(schema.tournaments).where(inArray(schema.tournaments.id, gameIds)) : [];
    const gameName = new Map([...tableNames, ...tourNames].map((g) => [g.id, g.name]));

    let players = involved.map((id) => ({ userId: id, cash: cash[id] ?? 0, tournament: tournament[id] ?? 0, total: total[id] ?? 0, parts: parts[id] ?? {} }));
    let gameList = [...games.values()].map((g) => ({ ...g, name: gameName.get(g.id) ?? g.id }));
    if (!privileged) {
      // Běžný hráč vidí jen svůj výsledek a převody, které se ho týkají.
      players = players.filter((p) => p.userId === actorId);
      gameList = gameList.map((g) => ({ ...g, results: g.results[actorId] !== undefined ? { [actorId]: g.results[actorId]! } : {}, parts: g.parts[actorId] ? { [actorId]: g.parts[actorId]! } : {} })).filter((g) => Object.keys(g.results).length > 0);
      transfers = transfers.filter((t) => t.from === actorId || t.to === actorId);
    }
    const names: Record<string, string> = Object.fromEntries(users.map((u) => [u.id, u.nickname]));
    names.__dum = 'dům';
    return {
      from: fromMs,
      to: toMs,
      players: players.sort((a, b) => b.total - a.total),
      games: gameList.sort((a, b) => a.name.localeCompare(b.name)),
      transfers,
      names,
      house: privileged ? -sum : null,
    };
  }

  /**
   * Vyúčtování stolu: čistý výsledek každého hráče (výběry − vklady) podle účetní knihy a
   * minimální seznam převodů. Hráči, kteří ještě sedí, se počítají podle žetonů u stolu.
   */
  async settlementForTable(actorId: string, tableId: string, seated: { userId: string; chips: number }[] = []): Promise<{ balances: Record<string, number>; transfers: Transfer[]; names: Record<string, string> }> {
    const txs = await this.deps.db
      .select({ id: schema.ledgerTransactions.id, kind: schema.ledgerTransactions.kind })
      .from(schema.ledgerTransactions)
      .where(and(eq(schema.ledgerTransactions.gameId, tableId), or(like(schema.ledgerTransactions.kind, 'cash_%'))));
    const ids = txs.map((t) => t.id);
    const entries = ids.length ? await this.deps.db.select().from(schema.ledgerEntries).where(and(inArray(schema.ledgerEntries.transactionId, ids), like(schema.ledgerEntries.account, 'wallet:%'))) : [];
    const balances: Record<string, number> = {};
    for (const e of entries) {
      const uid = e.account.slice('wallet:'.length);
      // Peněženka: vklad (buy-in) je záporný, výběr (cash-out) kladný, což je přesně čistý výsledek.
      balances[uid] = (balances[uid] ?? 0) + e.amount;
    }
    const rate = Number(this.deps.settings()['cash.chipsPerCurrencyUnit']) || 1;
    for (const s of seated) balances[s.userId] = (balances[s.userId] ?? 0) + Math.floor(s.chips / rate);
    const involved = Object.keys(balances);
    // Čtenář vidí vyúčtování, jen když je jeho součástí, nebo má oprávnění.
    if (!involved.includes(actorId) && !this.deps.perms.can(actorId, 'mena.vyuctovani').allowed) throw new PermissionError('FORBIDDEN');
    const users = involved.length ? await this.deps.db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, involved)) : [];
    const rounded = Object.fromEntries(Object.entries(balances).filter(([, v]) => v !== 0));
    // Zbytek ze zaokrouhlení žetonů patří domu a mezi hráče se nedělí.
    const sum = Object.values(rounded).reduce((a, b) => a + b, 0);
    let transferBalances = rounded;
    if (sum !== 0) transferBalances = { ...rounded, __dum: -sum };
    return { balances: rounded, transfers: minimalTransfers(transferBalances), names: { ...Object.fromEntries(users.map((u) => [u.id, u.nickname])), __dum: 'dům' } };
  }
}
