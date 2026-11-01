import { and, gte, inArray, like, lt, sql } from 'drizzle-orm';
import { schema, type Db } from './db/index.js';

/** Sázky a odměny na hlavu: patří k turnaji (gameId), ale nejsou jeho vstupem ani výplatou. */
export const SIDE_KINDS = ['bet_stake', 'bet_payout', 'bet_refund', 'bet_fee', 'head_bounty_post', 'head_bounty_payout', 'head_bounty_return', 'head_bounty_house'];
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

/** Součet vedlejších výsledků podle hráče. */
export function sideTotals(rows: SideRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.userId, (out.get(r.userId) ?? 0) + r.net);
  return out;
}
