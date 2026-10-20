import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { accounts, type Ledger } from '@kb/ledger';
import { DEFAULT_TZ, startOfMonth, yearBounds, type PermissionChecker, type SettingValues } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';
import type { WalletService } from './wallet/service.js';

export class HouseExpenseError extends Error {
  constructor(public readonly code: 'FORBIDDEN' | 'INVALID' | 'INSUFFICIENT') {
    super(code);
  }
}

type Meta = { ip?: string | null };

export interface ExpenseRow {
  id: number;
  category: string;
  amount: number;
  note: string;
  at: number;
  createdBy: string | null;
}

export interface HouseReport {
  house: number;
  categories: string[];
  expenses: ExpenseRow[];
  /** Součty výdajů podle kategorie za měsíc a za rok. */
  month: { total: number; byCategory: Record<string, number> };
  year: { total: number; byCategory: Record<string, number> };
  /** Příjmy domu za měsíc a za rok (rake, poplatky, odvody, strženo, vklady) bez výdajů. */
  income: { month: number; year: number };
}

interface Deps {
  db: Db;
  ledger: Ledger;
  perms: PermissionChecker;
  audit: AuditService;
  wallet: WalletService;
  settings: () => SettingValues;
  now: () => number;
}

const parseCategories = (raw: unknown): string[] => {
  const list = [...new Set(String(raw ?? '').split(/[,;\n]+/).map((x) => x.trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
  return list.length > 0 ? list : ['provoz'];
};

/**
 * Výdaje domu (provoz, ceny, akce…): měna jde z účtu domu zpět do zásoby, výdaj se zapíše s kategorií a poznámkou
 * a vždy i do účetní knihy a auditu. Dům nesmí jít do mínusu.
 */
export class HouseExpenseService {
  constructor(private deps: Deps) {}

  categories(): string[] {
    return parseCategories(this.deps.settings()['finance.expenseCategories']);
  }

  private can(actorId: string, permission: 'mena.zobrazit_dum' | 'mena.upravit_knihu'): void {
    if (!this.deps.perms.can(actorId, permission).allowed) throw new HouseExpenseError('FORBIDDEN');
  }

  /** Zapíše výdaj. Vrací `done: false`, když čeká na schválení (do přehledu se zapíše až po schválení). */
  async spend(actorId: string, input: { category: string; amount: number; note: string }, meta: Meta = {}): Promise<{ done: boolean }> {
    this.can(actorId, 'mena.upravit_knihu');
    const category = input.category.trim();
    const note = input.note.trim();
    if (!this.categories().includes(category) || !Number.isInteger(input.amount) || input.amount <= 0 || !note) throw new HouseExpenseError('INVALID');
    if (input.amount > this.deps.ledger.balance(accounts.house())) throw new HouseExpenseError('INSUFFICIENT');
    const r = await this.deps.wallet.adjust(actorId, [{ account: accounts.house(), amount: -input.amount }, { account: accounts.mint(), amount: input.amount }], `${category}: ${note}`, meta, { category, amount: input.amount, note });
    return { done: r.done };
  }

  /** Vklad do domu (počáteční vklad, doplnění zásoby). */
  async deposit(actorId: string, input: { amount: number; note: string }, meta: Meta = {}): Promise<{ done: boolean }> {
    this.can(actorId, 'mena.upravit_knihu');
    if (!Number.isInteger(input.amount) || input.amount <= 0 || !input.note.trim()) throw new HouseExpenseError('INVALID');
    const r = await this.deps.wallet.adjust(actorId, [{ account: accounts.mint(), amount: -input.amount }, { account: accounts.house(), amount: input.amount }], input.note.trim(), meta);
    return { done: r.done };
  }

  async report(actorId: string): Promise<HouseReport> {
    this.can(actorId, 'mena.zobrazit_dum');
    const db = this.deps.db;
    const now = this.deps.now();
    const year = Number(new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TZ, year: 'numeric' }).format(new Date(now)));
    const month = Number(new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TZ, month: 'numeric' }).format(new Date(now))) - 1;
    const yb = yearBounds(year, DEFAULT_TZ);
    const monthStart = new Date(startOfMonth(year, month, DEFAULT_TZ));
    const he = schema.houseExpenses;
    const sums = async (from: Date) => {
      const rows = await db.select({ category: he.category, total: sql<string>`coalesce(sum(${he.amount}), 0)` }).from(he).where(and(gte(he.at, from), lt(he.at, new Date(yb.to)))).groupBy(he.category);
      const byCategory = Object.fromEntries(rows.map((r) => [r.category, Number(r.total)]));
      return { total: Object.values(byCategory).reduce((a, b) => a + b, 0), byCategory };
    };
    const incomeSince = async (from: Date) => {
      const le = schema.ledgerEntries;
      const lt_ = schema.ledgerTransactions;
      const [r] = await db
        .select({ s: sql<string>`coalesce(sum(${le.amount}), 0)` })
        .from(le)
        .innerJoin(lt_, eq(lt_.id, le.transactionId))
        .where(and(eq(le.account, accounts.house()), sql`${le.amount} > 0`, gte(lt_.at, from), lt(lt_.at, new Date(yb.to))));
      return Number(r?.s ?? 0);
    };
    const rows = await db.select().from(he).orderBy(desc(he.at), desc(he.id)).limit(100);
    return {
      house: this.deps.ledger.balance(accounts.house()),
      categories: this.categories(),
      expenses: rows.map((r) => ({ id: r.id, category: r.category, amount: Number(r.amount), note: r.note, at: r.at.getTime(), createdBy: r.createdBy })),
      month: await sums(monthStart),
      year: await sums(new Date(yb.from)),
      income: { month: await incomeSince(monthStart), year: await incomeSince(new Date(yb.from)) },
    };
  }
}
