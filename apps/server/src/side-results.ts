import { and, asc, gte, inArray, like, lt, or, eq, sql } from 'drizzle-orm';
import { schema, type Db } from './db/index.js';

/** Sázky a odměny na hlavu: patří k turnaji (gameId), ale nejsou jeho vstupem ani výplatou. */
export const SIDE_KINDS = ['bet_stake', 'bet_payout', 'bet_refund', 'bet_fee', 'head_bounty_post', 'head_bounty_payout', 'head_bounty_return', 'head_bounty_house', 'head_bounty_cancel'];
export const SIDE_SET = new Set(SIDE_KINDS);

export interface SideRow {
  userId: string;
  /** Hra (turnaj), ke které pohyby patří. */
  gameId: string;
  /** Čistý výsledek hráče z vedlejších pohybů hry (kladný = vydělal). */
  net: number;
  /** Čas posledního pohybu. */
  at: number;
}

/**
 * Vedlejší pohyby hráčů (sázky, odměny na hlavu) rozpočítané podle hry z účetní knihy. Jediný zdroj pravdy pro všechny
 * přehledy (statistiky, žebříčky, rok, časové osy, večery, výsledky turnajů): co se ve hře stalo, se vždy započítá k ní.
 * Počítá i hráče, kteří v turnaji nehráli (např. sázeli jako diváci).
 */
export async function sideNets(db: Db, opts: { userIds?: string[]; from?: Date | null; to?: Date | null; gameIds?: string[]; kinds?: string[] } = {}): Promise<SideRow[]> {
  const le = schema.ledgerEntries;
  const lt_ = schema.ledgerTransactions;
  if (opts.userIds && opts.userIds.length === 0) return [];
  if (opts.gameIds && opts.gameIds.length === 0) return [];
  const rows = await db
    .select({
      account: le.account,
      gameId: lt_.gameId,
      net: sql<number>`coalesce(sum(${le.amount}), 0)::int`,
      at: sql<Date>`max(${lt_.at})`,
    })
    .from(le)
    .innerJoin(lt_, sql`${lt_.id} = ${le.transactionId}`)
    .where(
      and(
        inArray(lt_.kind, opts.kinds ?? SIDE_KINDS),
        like(le.account, 'wallet:%'),
        opts.userIds ? inArray(le.account, opts.userIds.map((u) => `wallet:${u}`)) : undefined,
        opts.gameIds ? inArray(lt_.gameId, opts.gameIds) : undefined,
        opts.from ? gte(lt_.at, opts.from) : undefined,
        opts.to ? lt(lt_.at, opts.to) : undefined,
      ),
    )
    .groupBy(le.account, lt_.gameId);
  return rows
    .filter((r) => r.gameId)
    .map((r) => ({ userId: r.account.slice('wallet:'.length), gameId: r.gameId!, net: Number(r.net), at: new Date(r.at).getTime() }));
}

/** Sázky bokem (bez odměn na hlavu). */
export const BET_KINDS = ['bet_stake', 'bet_payout', 'bet_refund', 'bet_fee'];

/** Pohyby peněženky u cash her (vklady, výběry, vrácení, poplatky za čas, výplaty jackpotu). */
export const CASH_KINDS = ['cash_buyin', 'cash_topup', 'cash_cashout', 'cash_return', 'time_charge', 'jackpot_payout'];

const isTournamentKind = (k: string) => k.startsWith('turnaj_') || k === 'bounty' || SIDE_SET.has(k);

/** Podmínka na druh pohybu, který patří k nějaké hře (cash, turnaj, sázky, odměny na hlavu). */
const gameKindCond = (kind: typeof schema.ledgerTransactions.kind) => or(like(kind, 'turnaj_%'), eq(kind, 'bounty'), inArray(kind, [...SIDE_KINDS, ...CASH_KINDS]));

/**
 * Čistý výsledek hráčů ze všech her podle účetní knihy: cash (včetně živého) a turnaje (včetně bounty, sázek a odměn na hlavu) zvlášť.
 * Jediný zdroj peněz pro přehledy; shoduje se s vyúčtováním v peněžence a s výsledky večerů. Bez vkladů a výběrů správcem, bez kontokorentu.
 */
export async function gameNets(db: Db, opts: { userIds?: string[] } = {}): Promise<Map<string, { cash: number; tournament: number }>> {
  const out = new Map<string, { cash: number; tournament: number }>();
  if (opts.userIds && opts.userIds.length === 0) return out;
  const le = schema.ledgerEntries;
  const lt_ = schema.ledgerTransactions;
  const rows = await db
    .select({ account: le.account, kind: lt_.kind, net: sql<number>`coalesce(sum(${le.amount}), 0)::int` })
    .from(le)
    .innerJoin(lt_, sql`${lt_.id} = ${le.transactionId}`)
    .where(and(like(le.account, 'wallet:%'), gameKindCond(lt_.kind), opts.userIds ? inArray(le.account, opts.userIds.map((u) => `wallet:${u}`)) : undefined))
    .groupBy(le.account, lt_.kind);
  for (const r of rows) {
    const id = r.account.slice('wallet:'.length);
    const v = out.get(id) ?? { cash: 0, tournament: 0 };
    if (isTournamentKind(r.kind)) v.tournament += Number(r.net);
    else v.cash += Number(r.net);
    out.set(id, v);
  }
  return out;
}

/** Jednotlivé pohyby z her v čase (pro graf vývoje výdělku): čas a částka podle hráče, od nejstaršího. */
export async function gameEvents(db: Db, userIds: string[]): Promise<{ userId: string; at: number; amount: number }[]> {
  if (userIds.length === 0) return [];
  const le = schema.ledgerEntries;
  const lt_ = schema.ledgerTransactions;
  const rows = await db
    .select({ account: le.account, at: lt_.at, amount: le.amount })
    .from(le)
    .innerJoin(lt_, sql`${lt_.id} = ${le.transactionId}`)
    .where(and(inArray(le.account, userIds.map((u) => `wallet:${u}`)), gameKindCond(lt_.kind)))
    .orderBy(asc(lt_.id));
  return rows.map((r) => ({ userId: r.account.slice('wallet:'.length), at: r.at.getTime(), amount: Number(r.amount) }));
}

/** Součet vedlejších výsledků podle hráče. */
export function sideTotals(rows: SideRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.userId, (out.get(r.userId) ?? 0) + r.net);
  return out;
}
