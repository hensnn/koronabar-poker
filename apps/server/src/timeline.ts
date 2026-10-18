import { and, asc, eq, sql } from 'drizzle-orm';
import { accounts } from '@kb/ledger';
import type { SettingValues } from '@kb/shared';
import { schema, type Db } from './db/index.js';

/** Bod časové řady: čas (epoch ms) a hodnota. */
export type Point = [number, number];

export interface Timeline {
  /** Zůstatek v peněžence po každém pohybu. */
  balance: Point[];
  /** Čistý výsledek každého odehraného turnaje (výplata + bounty − vklady) a součet v čase. */
  tournaments: { at: number; name: string; net: number; place: number; field: number; cumulative: number }[];
  /** Cash game po dnech: výsledek dne v žetonech, počet hand a součet v čase. */
  cash: { day: number; net: number; hands: number; cumulative: number }[];
  /** XP v čase (součet). */
  xp: Point[];
  /** Rating v čase podle typu hry; prázdné, když je zobrazení čísel ratingu vypnuté. */
  rating: { tournament: Point[]; cash: Point[]; visible: boolean };
  /** Handy po dnech (aktivita). */
  activity: { day: number; hands: number }[];
}

const MAX_POINTS = 400;

/** Zredukuje řadu na nejvýš `max` bodů (rovnoměrně, vždy se zachová první a poslední). */
export function thin<T>(rows: T[], max = MAX_POINTS): T[] {
  if (rows.length <= max) return rows;
  const out: T[] = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(rows[Math.round(i * step)]!);
  return out;
}

/** Vývoj hráče v čase: zůstatek, výsledky turnajů a cash, XP, rating a aktivita. Vidí jen vlastní data. */
export class TimelineService {
  constructor(private deps: { db: Db; settings: () => SettingValues }) {}

  async of(userId: string): Promise<Timeline> {
    const db = this.deps.db;

    // zůstatek: běžící součet pohybů na účtu peněženky (kniha začíná od nuly)
    const moves = await db
      .select({ at: schema.ledgerTransactions.at, amount: schema.ledgerEntries.amount })
      .from(schema.ledgerEntries)
      .innerJoin(schema.ledgerTransactions, eq(schema.ledgerTransactions.id, schema.ledgerEntries.transactionId))
      .where(eq(schema.ledgerEntries.account, accounts.wallet(userId)))
      .orderBy(asc(schema.ledgerTransactions.id));
    let sum = 0;
    const balance: Point[] = moves.map((m) => [m.at.getTime(), (sum += Number(m.amount))]);

    // turnaje: čistý výsledek hry
    const results = await db.select().from(schema.gameResults).where(and(eq(schema.gameResults.userId, userId), eq(schema.gameResults.kind, 'tournament'))).orderBy(asc(schema.gameResults.finishedAt));
    const names = new Map((await db.select({ id: schema.tournaments.id, name: schema.tournaments.name }).from(schema.tournaments)).map((t) => [t.id, t.name]));
    let cum = 0;
    const tournaments = results.map((r) => {
      const net = Number(r.payout) + Number(r.bounty) - Number(r.spent);
      cum += net;
      return { at: r.finishedAt.getTime(), name: names.get(r.ref) ?? r.ref, net, place: r.place, field: r.field, cumulative: cum };
    });

    // cash a aktivita: výsledek handy = výhra − vklad (v žetonech), seskupeno po dnech
    const day = sql<string>`date_trunc('day', ${schema.handPlayers.playedAt})`;
    const rows = await db
      .select({ day, kind: schema.handPlayers.kind, net: sql<string>`coalesce(sum(${schema.handPlayers.won} - ${schema.handPlayers.invested}), 0)`, hands: sql<number>`count(*)::int` })
      .from(schema.handPlayers)
      .where(eq(schema.handPlayers.userId, userId))
      .groupBy(day, schema.handPlayers.kind)
      .orderBy(asc(day));
    const activityMap = new Map<number, number>();
    const cashRows: { day: number; net: number; hands: number }[] = [];
    for (const r of rows) {
      const d = new Date(r.day).getTime();
      activityMap.set(d, (activityMap.get(d) ?? 0) + Number(r.hands));
      if (r.kind === 'cash') cashRows.push({ day: d, net: Number(r.net), hands: Number(r.hands) });
    }
    let cashCum = 0;
    const cash = cashRows.map((c) => ({ ...c, cumulative: (cashCum += c.net) }));
    const activity = [...activityMap.entries()].sort((a, b) => a[0] - b[0]).map(([d, hands]) => ({ day: d, hands }));

    // XP: součet událostí v čase
    const xpRows = await db.select({ at: schema.xpEvents.createdAt, amount: schema.xpEvents.amount }).from(schema.xpEvents).where(eq(schema.xpEvents.userId, userId)).orderBy(asc(schema.xpEvents.createdAt), asc(schema.xpEvents.id));
    let xpSum = 0;
    const xp: Point[] = xpRows.map((x) => [x.at.getTime(), (xpSum += x.amount)]);

    // rating
    const visible = !!this.deps.settings()['rating.showNumbers'];
    const ratingOf = async (scope: 'tournament' | 'cash'): Promise<Point[]> =>
      visible
        ? (await db.select({ at: schema.ratingEvents.at, v: schema.ratingEvents.displayAfter }).from(schema.ratingEvents).where(and(eq(schema.ratingEvents.userId, userId), eq(schema.ratingEvents.scope, scope))).orderBy(asc(schema.ratingEvents.at), asc(schema.ratingEvents.id))).map((r) => [r.at.getTime(), r.v] as Point)
        : [];
    return {
      balance: thin(balance),
      tournaments: tournaments.slice(-200),
      cash: cash.slice(-365),
      xp: thin(xp),
      rating: { tournament: thin(await ratingOf('tournament')), cash: thin(await ratingOf('cash')), visible },
      activity: activity.slice(-180),
    };
  }
}
