import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { accounts, type Ledger } from '@kb/ledger';
import { dayKey, type PermissionChecker, type PlayerProfile, type PollCondition, type SettingValues } from '@kb/shared';
import type { Tournament } from '@kb/game-core';
import { schema, type Db } from './db/index.js';

const DAY = 86_400_000;

/** Všechna čísla `days`, která podmínka používá (aktivita za posledních X dní), aby se spočítala předem. */
export function collectDays(node: PollCondition, out = new Set<number>()): Set<number> {
  if (node.type === 'group') {
    for (const c of node.children) collectDays(c, out);
  } else if (node.type === 'activity' && node.period === 'days') {
    out.add(node.days ?? 30);
  }
  return out;
}

export interface ProfileDeps {
  db: Db;
  perms: PermissionChecker & {
    assignmentsOf(userId: string): { role: { key: string; power: number } | undefined }[];
  };
  ledger: Ledger;
  settings: () => SettingValues;
  now: () => number;
  isOnline: (userId: string) => boolean;
  /** Stoly: id → sedící hráči. */
  seated: () => Map<string, string[]>;
  tournaments: () => { id: string; tournament: Tournament }[];
  progress: { brief(ids: string[]): Promise<{ userId: string; level: number; rank: { name: string } }[]> };
  rating: { numeric(userId: string): Promise<{ tournament: { value: number; provisional: boolean } | null; cash: { value: number; provisional: boolean } | null; division: string }> };
  stats: { leaderboard(range: { from: null; to: null }): Promise<{ userId: string }[]>; range(season: string | undefined): Promise<{ from: Date | null; to: Date | null }> };
  publicChannelIds: () => Promise<string[]>;
}

/**
 * Sestaví profily hráčů, proti kterým se vyhodnocují podmínky anket. Čte z databáze a z běžících her;
 * dotazy jsou hromadné, aby šly spočítat všichni aktivní hráči najednou (živý náhled v editoru).
 */
export class ProfileBuilder {
  constructor(private d: ProfileDeps) {}

  async activeUserIds(): Promise<string[]> {
    return (await this.d.db.select({ id: schema.users.id }).from(schema.users).where(ne(schema.users.status, 'blocked'))).map((u) => u.id);
  }

  async build(userIds: string[], days: number[] = []): Promise<PlayerProfile[]> {
    if (userIds.length === 0) return [];
    const now = this.d.now();
    const users = await this.d.db.select().from(schema.users).where(inArray(schema.users.id, userIds));
    const hp = schema.handPlayers;

    // handy: celkem, v sezóně a za posledních X dní
    const season = await this.d.stats.range('current');
    const handRows = await this.d.db
      .select({ userId: hp.userId, total: sql<number>`count(*)::int`, season: sql<number>`count(*) filter (where ${season.from ? sql`${hp.playedAt} >= ${season.from}` : sql`true`})::int` })
      .from(hp)
      .where(inArray(hp.userId, userIds))
      .groupBy(hp.userId);
    const handsByDays = new Map<number, Map<string, number>>();
    for (const n of days) {
      const rows = await this.d.db
        .select({ userId: hp.userId, n: sql<number>`count(*)::int` })
        .from(hp)
        .where(and(inArray(hp.userId, userIds), gte(hp.playedAt, new Date(now - n * DAY))))
        .groupBy(hp.userId);
      handsByDays.set(n, new Map(rows.map((r) => [r.userId, r.n])));
    }
    // hry: dohrané turnaje + cash sezení (stůl a den)
    const GR = schema.gameResults;
    const tourRows = await this.d.db.select({ userId: GR.userId, at: GR.finishedAt, place: GR.place }).from(GR).where(and(inArray(GR.userId, userIds), eq(GR.kind, 'tournament')));
    const cashRows = await this.d.db
      .select({ userId: hp.userId, at: sql<Date>`min(${hp.playedAt})` })
      .from(hp)
      .innerJoin(schema.hands, eq(schema.hands.id, hp.handId))
      .where(and(inArray(hp.userId, userIds), eq(hp.kind, 'cash')))
      .groupBy(hp.userId, schema.hands.tableId, sql`date(${hp.playedAt} at time zone 'Europe/Prague')`);
    const games = new Map<string, number[]>();
    const wins = new Map<string, number>();
    for (const r of tourRows) {
      (games.get(r.userId) ?? games.set(r.userId, []).get(r.userId)!).push(r.at.getTime());
      if (r.place === 1) wins.set(r.userId, (wins.get(r.userId) ?? 0) + 1);
    }
    for (const r of cashRows) (games.get(r.userId) ?? games.set(r.userId, []).get(r.userId)!).push(new Date(r.at).getTime());

    const seriesRows = await this.d.db.select({ userId: schema.xpEvents.userId, ref: schema.xpEvents.ref }).from(schema.xpEvents).where(and(inArray(schema.xpEvents.userId, userIds), eq(schema.xpEvents.source, 'series')));
    const board = await this.d.stats.leaderboard({ from: null, to: null });
    const rankOf = new Map(board.map((r, i) => [r.userId, i + 1]));
    const briefs = new Map((await this.d.progress.brief(userIds)).map((b) => [b.userId, b]));
    const members = await this.d.db.select({ userId: schema.chatMembers.userId, channelId: schema.chatMembers.channelId }).from(schema.chatMembers).where(inArray(schema.chatMembers.userId, userIds));
    const publicChannels = await this.d.publicChannelIds();
    const seated = this.d.seated();
    const trns = this.d.tournaments().map(({ id, tournament }) => ({ id, st: tournament.state() }));

    const out: PlayerProfile[] = [];
    for (const u of users) {
      const assignments = this.d.perms.assignmentsOf(u.id).filter((a) => a.role);
      const brief = briefs.get(u.id);
      const rating = await this.d.rating.numeric(u.id);
      const hr = handRows.find((r) => r.userId === u.id);
      const gameTimes = games.get(u.id) ?? [];
      const mine = trns.filter((t) => t.st.players.some((p) => p.userId === u.id && p.status !== 'out'));
      out.push({
        userId: u.id,
        online: this.d.isOnline(u.id),
        tableIds: [...seated].filter(([, ids]) => ids.includes(u.id)).map(([id]) => id),
        tournamentIds: mine.filter((t) => t.st.status === 'running' || t.st.status === 'registering').map((t) => t.id),
        aliveTournamentIds: mine.filter((t) => t.st.status === 'running').map((t) => t.id),
        registeredTournamentIds: mine.filter((t) => t.st.status === 'registering').map((t) => t.id),
        channelIds: [...new Set([...members.filter((m) => m.userId === u.id).map((m) => m.channelId), ...publicChannels])],
        roleKeys: assignments.map((a) => a.role!.key),
        maxPower: Math.max(0, ...assignments.map((a) => a.role!.power)),
        level: brief?.level ?? 1,
        rankName: brief?.rank.name ?? '',
        division: rating.division,
        ratingTournament: rating.tournament,
        ratingCash: rating.cash,
        accountAgeDays: Math.floor((now - u.createdAt.getTime()) / DAY),
        daysSinceActive: u.lastSeenAt ? Math.floor((now - u.lastSeenAt.getTime()) / DAY) : null,
        activity: {
          handsTotal: hr?.total ?? 0,
          handsSeason: hr?.season ?? 0,
          gamesTotal: gameTimes.length,
          gamesSeason: season.from ? gameTimes.filter((t) => t >= season.from!.getTime()).length : gameTimes.length,
          handsInLast: (n) => handsByDays.get(n)?.get(u.id) ?? 0,
          gamesInLast: (n) => gameTimes.filter((t) => t >= now - n * DAY).length,
        },
        seriesIds: seriesRows.filter((s) => s.userId === u.id).map((s) => s.ref),
        leaderboardRank: rankOf.get(u.id) ?? null,
        tournamentWins: wins.get(u.id) ?? 0,
        balance: this.d.ledger.balance(accounts.wallet(u.id)),
      });
    }
    void dayKey;
    return out;
  }
}
