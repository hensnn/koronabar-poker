import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { accounts, type Ledger } from '@kb/ledger';
import type { SettingValues } from '@kb/shared';
import { schema, type Db } from './db/index.js';
import type { BriefDto } from './progress.js';
import { thin, type Point } from './timeline.js';

export class OverviewError extends Error {
  constructor(public readonly code: 'HIDDEN' | 'INVALID') {
    super(code);
  }
}

interface Deps {
  db: Db;
  ledger: Ledger;
  settings: () => SettingValues;
  brief: (userIds: string[]) => Promise<BriefDto[]>;
  /** Žebříček ratingu podle druhu hry (čísla jen když je povoleno jejich zobrazení). */
  rating: (scope: 'tournament' | 'cash') => Promise<{ userId: string; rating: number | null }[]>;
}

export interface OverviewRow {
  userId: string;
  nickname: string;
  balance: number;
  xp: number;
  level: number;
  rank: { name: string; icon: string; color: string };
  ratingTournament: number | null;
  ratingCash: number | null;
  hands: number;
  tournaments: number;
  tournamentNet: number;
  cashNet: number;
  total: number;
  lastSeenAt: number | null;
}

export type CompareMetric = 'balance' | 'profit' | 'xp';
export const MAX_COMPARE = 8;

/**
 * Přehled mezi hráči: kdo má jaký zůstatek, výsledky, úroveň a rating, a srovnání vývoje vybraných hráčů v čase.
 * Viditelnost řídí globální nastavení `stats.publicOverview` (výchozí zapnuto – hra je mezi přáteli, čísla nejsou tajná).
 */
export class OverviewService {
  constructor(private deps: Deps) {}

  private visible(): void {
    if (this.deps.settings()['stats.publicOverview'] === false) throw new OverviewError('HIDDEN');
  }

  async overview(): Promise<{ rows: OverviewRow[] }> {
    this.visible();
    const db = this.deps.db;
    const users = await db.select({ id: schema.users.id, nickname: schema.users.nickname, lastSeenAt: schema.users.lastSeenAt }).from(schema.users).where(eq(schema.users.status, 'active'));
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return { rows: [] };
    const briefs = new Map((await this.deps.brief(ids)).map((b) => [b.userId, b]));
    const xp = new Map((await db.select({ userId: schema.playerProgress.userId, xp: schema.playerProgress.xp }).from(schema.playerProgress)).map((p) => [p.userId, Number(p.xp)]));
    const handsRows = await db.select({ userId: schema.handPlayers.userId, n: sql<number>`count(*)::int` }).from(schema.handPlayers).groupBy(schema.handPlayers.userId);
    const hands = new Map(handsRows.map((r) => [r.userId, Number(r.n)]));
    const cashRows = await db
      .select({ userId: schema.handPlayers.userId, net: sql<string>`coalesce(round(sum((${schema.handPlayers.won} - ${schema.handPlayers.invested})::numeric / ${schema.hands.chipsPerUnit})), 0)` })
      .from(schema.handPlayers)
      .innerJoin(schema.hands, eq(schema.hands.id, schema.handPlayers.handId))
      .where(eq(schema.handPlayers.kind, 'cash'))
      .groupBy(schema.handPlayers.userId);
    const cash = new Map(cashRows.map((r) => [r.userId, Number(r.net)]));
    const gr = schema.gameResults;
    const tourRows = await db
      .select({ userId: gr.userId, n: sql<number>`count(*)::int`, net: sql<string>`coalesce(sum(${gr.payout} + ${gr.bounty} - ${gr.spent}), 0)` })
      .from(gr)
      .where(eq(gr.kind, 'tournament'))
      .groupBy(gr.userId);
    const tour = new Map(tourRows.map((r) => [r.userId, { n: Number(r.n), net: Number(r.net) }]));
    const rt = new Map((await this.deps.rating('tournament')).map((r) => [r.userId, r.rating]));
    const rc = new Map((await this.deps.rating('cash')).map((r) => [r.userId, r.rating]));
    const rows: OverviewRow[] = users.map((u) => {
      const b = briefs.get(u.id);
      const tn = tour.get(u.id)?.net ?? 0;
      const cn = cash.get(u.id) ?? 0;
      return {
        userId: u.id,
        nickname: u.nickname,
        balance: this.deps.ledger.balance(accounts.wallet(u.id)),
        xp: xp.get(u.id) ?? 0,
        level: b?.level ?? 1,
        rank: b?.rank ?? { name: '', icon: '', color: 'muted' },
        ratingTournament: rt.get(u.id) ?? null,
        ratingCash: rc.get(u.id) ?? null,
        hands: hands.get(u.id) ?? 0,
        tournaments: tour.get(u.id)?.n ?? 0,
        tournamentNet: tn,
        cashNet: cn,
        total: tn + cn,
        lastSeenAt: u.lastSeenAt ? u.lastSeenAt.getTime() : null,
      };
    });
    rows.sort((a, b) => b.total - a.total || b.balance - a.balance);
    return { rows };
  }

  /** Vývoj vybraných hráčů v čase: zůstatek, zisk (turnaje + cash v měně) nebo XP. */
  async compare(userIds: string[], metric: CompareMetric): Promise<{ series: { userId: string; nickname: string; points: Point[] }[] }> {
    this.visible();
    const ids = [...new Set(userIds)].slice(0, MAX_COMPARE);
    if (ids.length === 0 || !['balance', 'profit', 'xp'].includes(metric)) throw new OverviewError('INVALID');
    const db = this.deps.db;
    const nick = new Map((await db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, ids))).map((u) => [u.id, u.nickname]));
    const out: { userId: string; nickname: string; points: Point[] }[] = [];
    if (metric === 'balance') {
      const wallets = ids.map((i) => accounts.wallet(i));
      const moves = await db
        .select({ account: schema.ledgerEntries.account, at: schema.ledgerTransactions.at, amount: schema.ledgerEntries.amount })
        .from(schema.ledgerEntries)
        .innerJoin(schema.ledgerTransactions, eq(schema.ledgerTransactions.id, schema.ledgerEntries.transactionId))
        .where(inArray(schema.ledgerEntries.account, wallets))
        .orderBy(asc(schema.ledgerTransactions.id));
      for (const id of ids) {
        let sum = 0;
        out.push({ userId: id, nickname: nick.get(id) ?? '?', points: thin(moves.filter((m) => m.account === accounts.wallet(id)).map((m) => [m.at.getTime(), (sum += Number(m.amount))] as Point)) });
      }
    } else if (metric === 'xp') {
      const rows = await db.select({ userId: schema.xpEvents.userId, at: schema.xpEvents.createdAt, amount: schema.xpEvents.amount }).from(schema.xpEvents).where(inArray(schema.xpEvents.userId, ids)).orderBy(asc(schema.xpEvents.createdAt), asc(schema.xpEvents.id));
      for (const id of ids) {
        let sum = 0;
        out.push({ userId: id, nickname: nick.get(id) ?? '?', points: thin(rows.filter((r) => r.userId === id).map((r) => [r.at.getTime(), (sum += r.amount)] as Point)) });
      }
    } else {
      const gr = schema.gameResults;
      const games = await db.select().from(gr).where(and(inArray(gr.userId, ids), eq(gr.kind, 'tournament'))).orderBy(asc(gr.finishedAt));
      const day = sql<string>`date_trunc('day', ${schema.handPlayers.playedAt})`;
      const cash = await db
        .select({ userId: schema.handPlayers.userId, day, net: sql<string>`coalesce(round(sum((${schema.handPlayers.won} - ${schema.handPlayers.invested})::numeric / ${schema.hands.chipsPerUnit})), 0)` })
        .from(schema.handPlayers)
        .innerJoin(schema.hands, eq(schema.hands.id, schema.handPlayers.handId))
        .where(and(inArray(schema.handPlayers.userId, ids), eq(schema.handPlayers.kind, 'cash')))
        .groupBy(schema.handPlayers.userId, day)
        .orderBy(asc(day));
      for (const id of ids) {
        const events: Point[] = [
          ...games.filter((g) => g.userId === id).map((g) => [g.finishedAt.getTime(), Number(g.payout) + Number(g.bounty) - Number(g.spent)] as Point),
          ...cash.filter((c) => c.userId === id).map((c) => [new Date(c.day).getTime(), Number(c.net)] as Point),
        ].sort((a, b) => a[0] - b[0]);
        let sum = 0;
        out.push({ userId: id, nickname: nick.get(id) ?? '?', points: thin(events.map((e) => [e[0], (sum += e[1])] as Point)) });
      }
    }
    return { series: out };
  }
}
