import { and, asc, eq, sql } from 'drizzle-orm';
import { accounts } from '@kb/ledger';
import type { SettingValues } from '@kb/shared';
import { moneyEvents } from './side-results.js';
import { schema, type Db } from './db/index.js';

/** Bod časové řady: čas (epoch ms) a hodnota. */
export type Point = [number, number];

export interface Timeline {
  /** Zůstatek v peněžence po každém pohybu. */
  balance: Point[];
  /** Čistý výsledek každého odehraného turnaje (výplata + bounty − vklady) a součet v čase. */
  tournaments: { at: number; name: string; net: number; place: number; field: number; cumulative: number }[];
  /** Výdělek ze všech her (turnaje + cash + živý cash) v měně: jednotlivé události (čas, čistý výsledek), součet si počítá klient za zvolené období. */
  earnings: Point[];
  /** Cash game po dnech: výsledek dne v měně, počet hand a součet v čase. */
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
  /** `seated` = value in currency of the player's chips at cash tables (they count as a withdrawal at the end of the cash line). */
  constructor(private deps: { db: Db; settings: () => SettingValues; seated?: (userId: string) => number }) {}

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

    // Money comes only from the accounting ledger (same as the players overview and the wallet settlement); the results table gives just the place and the field.
    const events = await moneyEvents(db, { userIds: [userId] });
    const allResults = await db.select().from(schema.gameResults).where(eq(schema.gameResults.userId, userId)).orderBy(asc(schema.gameResults.finishedAt));
    const results = allResults.filter((r) => r.kind === 'tournament');
    const names = new Map((await db.select({ id: schema.tournaments.id, name: schema.tournaments.name }).from(schema.tournaments)).map((t) => [t.id, t.name]));
    // a tournament result = every ledger movement of the game (buy-in, payout, bounty, bets and head bounties)
    const netOfGame = new Map<string, number>();
    const lastOfGame = new Map<string, number>();
    for (const e of events) {
      if (!e.tournament || !e.gameId) continue;
      netOfGame.set(e.gameId, (netOfGame.get(e.gameId) ?? 0) + e.amount);
      lastOfGame.set(e.gameId, Math.max(lastOfGame.get(e.gameId) ?? 0, e.at));
    }
    const played = new Set(results.map((r) => r.ref));
    // games the player has no result for (bets as a spectator, head bounties, a refunded tournament) still count: place 0 = no result
    const tourRows = [
      ...results.map((r) => ({ at: r.finishedAt.getTime(), name: names.get(r.ref) ?? r.ref, net: netOfGame.get(r.ref) ?? 0, place: r.place, field: r.field })),
      ...[...netOfGame].filter(([id, net]) => !played.has(id) && net !== 0).map(([id, net]) => ({ at: lastOfGame.get(id)!, name: names.get(id) ?? id, net, place: 0, field: 0 })),
    ].sort((x, y) => x.at - y.at);
    let cum = 0;
    const tournaments = tourRows.map((r) => ({ ...r, cumulative: (cum += r.net) }));

    // hands per day (activity, and the hand count of the cash days)
    const day = sql<string>`date_trunc('day', ${schema.handPlayers.playedAt})`;
    const rows = await db
      .select({ day, kind: schema.handPlayers.kind, hands: sql<number>`count(*)::int` })
      .from(schema.handPlayers)
      .where(eq(schema.handPlayers.userId, userId))
      .groupBy(day, schema.handPlayers.kind)
      .orderBy(asc(day));
    const activityMap = new Map<number, number>();
    const cashHands = new Map<number, number>();
    for (const r of rows) {
      const d = new Date(r.day).getTime();
      activityMap.set(d, (activityMap.get(d) ?? 0) + Number(r.hands));
      if (r.kind === 'cash') cashHands.set(d, Number(r.hands));
    }
    // cash by days: the net of the day is the sum of the cash movements of the ledger (buy-ins, cash-outs, time charge, jackpot)
    const dayOf = (at: number) => Math.floor(at / 86_400_000) * 86_400_000;
    const cashNet = new Map<number, number>();
    for (const e of events) if (!e.tournament) cashNet.set(dayOf(e.at), (cashNet.get(dayOf(e.at)) ?? 0) + e.amount);
    const seatedNow = this.deps.seated?.(userId) ?? 0;
    if (seatedNow) cashNet.set(dayOf(Date.now()), (cashNet.get(dayOf(Date.now())) ?? 0) + seatedNow);
    let cashCum = 0;
    const cash = [...new Set([...cashNet.keys(), ...cashHands.keys()])]
      .sort((a, b) => a - b)
      .map((d) => ({ day: d, net: cashNet.get(d) ?? 0, hands: cashHands.get(d) ?? 0, cumulative: (cashCum += cashNet.get(d) ?? 0) }));
    const activity = [...activityMap.entries()].sort((a, b) => a[0] - b[0]).map(([d, hands]) => ({ day: d, hands }));

    // earnings from all games: every ledger movement of a game; chips at the tables are the last point
    const earnings: Point[] = events.map((e) => [e.at, e.amount] as Point);
    if (seatedNow) earnings.push([Date.now(), seatedNow]);

    // XP: součet událostí v čase
    const xpRows = await db.select({ at: schema.xpEvents.createdAt, amount: schema.xpEvents.amount }).from(schema.xpEvents).where(eq(schema.xpEvents.userId, userId)).orderBy(asc(schema.xpEvents.createdAt), asc(schema.xpEvents.id));
    let xpSum = 0;
    const xp: Point[] = xpRows.map((x) => [x.at.getTime(), (xpSum += x.amount)]);

    // rating
    const visible = !!this.deps.settings()['rating.showNumbers'] && !!this.deps.settings()['rating.enabled'];
    const ratingOf = async (scope: 'tournament' | 'cash'): Promise<Point[]> =>
      visible
        ? (await db.select({ at: schema.ratingEvents.at, v: schema.ratingEvents.displayAfter }).from(schema.ratingEvents).where(and(eq(schema.ratingEvents.userId, userId), eq(schema.ratingEvents.scope, scope))).orderBy(asc(schema.ratingEvents.at), asc(schema.ratingEvents.id))).map((r) => [r.at.getTime(), r.v] as Point)
        : [];
    return {
      balance: thin(balance),
      earnings: earnings.slice(-1000),
      tournaments: tournaments.slice(-200),
      cash: cash.slice(-365),
      xp: thin(xp),
      rating: { tournament: thin(await ratingOf('tournament')), cash: thin(await ratingOf('cash')), visible },
      activity: activity.slice(-180),
    };
  }
}
