import { asc, eq, inArray, sql } from 'drizzle-orm';
import { accounts, type Ledger } from '@kb/ledger';
import type { SettingValues } from '@kb/shared';
import { gameNets, moneyEvents, seatedValues } from './side-results.js';
import { schema, type Db } from './db/index.js';
import { playerColors } from './player-colors.js';
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
  rating: (scope: 'tournament' | 'cash') => Promise<{ userId: string; rating: number | null; division?: { name: string; icon: string; color: string } }[]>;
  /** Divize všech hráčů (i provizorních) pro daný druh hry. */
  divisions?: (scope: 'tournament' | 'cash') => Promise<{ byUser: Map<string, DivisionInfo>; fallback: DivisionInfo }>;
  /** Hráči, kteří právě sedí u cash stolů (jejich žetony se do cash výsledku počítají jako výběr). */
  seated?: () => { userId: string; chips: number }[];
  /** Seasons, for the leaderboard in the lobby. */
  seasons?: () => Promise<{ id: string; name: string; startsAt: number; endsAt: number | null }[]>;
  now?: () => number;
}

export interface LobbyBoardRow {
  place: number;
  userId: string;
  nickname: string;
  rank: { name: string; icon: string; color: string };
  /** null when the Skill column is switched off (or the player has no division). */
  division: DivisionInfo | null;
  /** null when the Profit column is switched off. */
  total: number | null;
}

/** Leaderboard in the lobby: the same for everybody, set up by the administrator (period, rows, order, columns). */
export interface LobbyBoard {
  period: { kind: 'all' } | { kind: 'season'; id: string; name: string };
  sort: 'profit' | 'skill';
  columns: { skill: boolean; profit: boolean };
  rows: LobbyBoardRow[];
  /** The viewer's own row when it did not fit among the rows shown. */
  me: LobbyBoardRow | null;
}

/** Divize s číslem ratingu (i provizorním). */
export interface DivisionInfo {
  name: string;
  icon: string;
  color: string;
  rating: number | null;
}

export interface OverviewRow {
  userId: string;
  nickname: string;
  /** Barva hráče (1 až 12) ve statistikách a grafech. */
  color: number;
  balance: number;
  xp: number;
  level: number;
  rank: { name: string; icon: string; color: string };
  ratingTournament: number | null;
  ratingCash: number | null;
  /** Divize hráče podle ratingu (turnajový, jinak cash); null, když hráč ještě není v žebříčku ratingu. */
  division: DivisionInfo | null;
  /** Divize a rating podle druhu hry, i s provizorním ratingem (hráč bez her má výchozí). */
  divisionTournament: DivisionInfo | null;
  divisionCash: DivisionInfo | null;
  /** Počet hand odehraných u cash stolů (bez hand z turnajů). */
  hands: number;
  tournaments: number;
  tournamentNet: number;
  /** Cash game včetně živého cash (v měně). */
  cashNet: number;
  /** Výdělek ze všech her celkem (turnaje + cash + živý cash). */
  total: number;
  lastSeenAt: number | null;
}

export type CompareMetric = 'profit' | 'balance' | 'xp';
/** Which games a comparison of the profit counts: everything, only cash (with live cash) or only tournaments. */
export type CompareKind = 'all' | 'cash' | 'tournament';
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
    return { rows: await this.rows() };
  }

  /**
   * Leaderboard in the lobby. What it shows is decided here from the global settings, not by the client: the period
   * (whole history, the running season, or one chosen season), how many rows, the order and which columns.
   * A season that no longer exists, or "running season" while none runs, falls back to the whole history.
   */
  async lobbyBoard(viewerId: string): Promise<LobbyBoard> {
    this.visible();
    const s = this.deps.settings();
    const wanted = String(s['stats.lobbyBoardSeason'] ?? 'all');
    const now = this.deps.now?.() ?? Date.now();
    const seasons = wanted === 'all' ? [] : ((await this.deps.seasons?.()) ?? []);
    const season = wanted === 'current' ? seasons.find((x) => x.startsAt <= now && (x.endsAt === null || x.endsAt > now)) : seasons.find((x) => x.id === wanted);
    const all = await this.rows(season ? { from: new Date(season.startsAt), to: season.endsAt === null ? null : new Date(season.endsAt) } : {});
    const columns = { skill: s['stats.lobbyBoardSkill'] !== false, profit: s['stats.lobbyBoardProfit'] !== false };
    const sort = s['stats.lobbyBoardSort'] === 'skill' ? 'skill' : 'profit';
    // Skill as a number for ordering; hidden numbers (or no skill at all) leave the order by profit.
    const skill = (r: OverviewRow) => r.division?.rating ?? r.ratingTournament ?? r.ratingCash ?? Number.NEGATIVE_INFINITY;
    if (sort === 'skill') all.sort((a, b) => skill(b) - skill(a) || b.total - a.total || b.balance - a.balance);
    const view = (r: OverviewRow, i: number): LobbyBoardRow => ({ place: i + 1, userId: r.userId, nickname: r.nickname, rank: r.rank, division: columns.skill ? r.division : null, total: columns.profit ? r.total : null });
    const limit = Math.max(1, Number(s['stats.lobbyBoardRows']) || 1);
    const mine = all.findIndex((r) => r.userId === viewerId);
    return {
      period: season ? { kind: 'season', id: season.id, name: season.name } : { kind: 'all' },
      sort,
      columns,
      rows: all.slice(0, limit).map(view),
      me: mine >= limit ? view(all[mine]!, mine) : null,
    };
  }

  /** Rows of all active players, ordered by profit. `from`/`to` limit the profit to a period; the rest is as of now. */
  private async rows(period: { from?: Date | null; to?: Date | null } = {}): Promise<OverviewRow[]> {
    this.visible();
    const db = this.deps.db;
    const users = await db.select({ id: schema.users.id, nickname: schema.users.nickname, lastSeenAt: schema.users.lastSeenAt }).from(schema.users).where(eq(schema.users.status, 'active'));
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return [];
    const briefs = new Map((await this.deps.brief(ids)).map((b) => [b.userId, b]));
    const xp = new Map((await db.select({ userId: schema.playerProgress.userId, xp: schema.playerProgress.xp }).from(schema.playerProgress)).map((p) => [p.userId, Number(p.xp)]));
    // Jen cash ruce; ruce odehrané v turnajích se sem nepočítají (turnaje mají vlastní sloupec).
    const handsRows = await db.select({ userId: schema.handPlayers.userId, n: sql<number>`count(*)::int` }).from(schema.handPlayers).where(eq(schema.handPlayers.kind, 'cash')).groupBy(schema.handPlayers.userId);
    const hands = new Map(handsRows.map((r) => [r.userId, Number(r.n)]));
    // Peníze podle účetní knihy (stejný zdroj jako vyúčtování v peněžence a výsledky večerů): cash včetně živého, turnaje včetně sázek a odměn na hlavu.
    const nets = await gameNets(db, { from: period.from, to: period.to });
    // chips at the tables count as a withdrawal only for a period that reaches the present
    const open = !period.to || period.to.getTime() > (this.deps.now?.() ?? Date.now());
    const seated = seatedValues(open ? (this.deps.seated?.() ?? []) : [], Number(this.deps.settings()['cash.chipsPerCurrencyUnit']));
    const gr = schema.gameResults;
    const tourRows = await db
      .select({ userId: gr.userId, n: sql<number>`count(*)::int` })
      .from(gr)
      .where(eq(gr.kind, 'tournament'))
      .groupBy(gr.userId);
    const tour = new Map(tourRows.map((r) => [r.userId, Number(r.n)]));
    const lt = await this.deps.rating('tournament');
    const lc = await this.deps.rating('cash');
    const rt = new Map(lt.map((r) => [r.userId, r.rating]));
    const rc = new Map(lc.map((r) => [r.userId, r.rating]));
    const dt = await this.deps.divisions?.('tournament');
    const dc = await this.deps.divisions?.('cash');
    const s = this.deps.settings();
    const tOn = s['rating.enabled'] !== false && s['rating.tournamentsEnabled'] !== false;
    const cOn = s['rating.enabled'] !== false && s['rating.cashEnabled'] !== false;
    const divT = (id: string) => (dt ? (dt.byUser.get(id) ?? dt.fallback) : null);
    const divC = (id: string) => (dc ? (dc.byUser.get(id) ?? dc.fallback) : null);
    const divisionOf = (id: string) => (tOn ? divT(id) : cOn ? divC(id) : null);
    const colors = await playerColors(db);
    const rows: OverviewRow[] = users.map((u) => {
      const b = briefs.get(u.id);
      const tn = nets.get(u.id)?.tournament ?? 0;
      const cn = (nets.get(u.id)?.cash ?? 0) + (seated.get(u.id) ?? 0);
      return {
        userId: u.id,
        nickname: u.nickname,
        color: colors.get(u.id) ?? 1,
        balance: this.deps.ledger.balance(accounts.wallet(u.id)),
        xp: xp.get(u.id) ?? 0,
        level: b?.level ?? 1,
        rank: b?.rank ?? { name: '', icon: '', color: 'muted' },
        ratingTournament: rt.get(u.id) ?? null,
        ratingCash: rc.get(u.id) ?? null,
        division: divisionOf(u.id),
        divisionTournament: tOn ? divT(u.id) : null,
        divisionCash: cOn ? divC(u.id) : null,
        hands: hands.get(u.id) ?? 0,
        tournaments: tour.get(u.id) ?? 0,
        tournamentNet: tn,
        cashNet: cn,
        total: tn + cn,
        lastSeenAt: u.lastSeenAt ? u.lastSeenAt.getTime() : null,
      };
    });
    rows.sort((a, b) => b.total - a.total || b.balance - a.balance);
    return rows;
  }

  /** Vývoj vybraných hráčů v čase: výdělek ze všech her (turnaje + cash + živý cash v měně), zůstatek nebo XP. */
  async compare(userIds: string[], metric: CompareMetric, kind: CompareKind = 'all'): Promise<{ series: { userId: string; nickname: string; color: number; points: Point[] }[] }> {
    this.visible();
    const ids = [...new Set(userIds)].slice(0, MAX_COMPARE);
    if (ids.length === 0 || !['balance', 'profit', 'xp'].includes(metric)) throw new OverviewError('INVALID');
    const db = this.deps.db;
    const nick = new Map((await db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, ids))).map((u) => [u.id, u.nickname]));
    const colors = await playerColors(db);
    const out: { userId: string; nickname: string; color: number; points: Point[] }[] = [];
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
        out.push({ userId: id, nickname: nick.get(id) ?? '?', color: colors.get(id) ?? 1, points: thin(moves.filter((m) => m.account === accounts.wallet(id)).map((m) => [m.at.getTime(), (sum += Number(m.amount))] as Point)) });
      }
    } else if (metric === 'xp') {
      const rows = await db.select({ userId: schema.xpEvents.userId, at: schema.xpEvents.createdAt, amount: schema.xpEvents.amount }).from(schema.xpEvents).where(inArray(schema.xpEvents.userId, ids)).orderBy(asc(schema.xpEvents.createdAt), asc(schema.xpEvents.id));
      for (const id of ids) {
        let sum = 0;
        out.push({ userId: id, nickname: nick.get(id) ?? '?', color: colors.get(id) ?? 1, points: thin(rows.filter((r) => r.userId === id).map((r) => [r.at.getTime(), (sum += r.amount)] as Point)) });
      }
    } else {
      // Výdělek v čase z pohybů v účetní knize (součet na konci = Výdělek v přehledu); žetony u stolu se přidají jako poslední bod.
      const events = await moneyEvents(db, { userIds: ids });
      const seated = seatedValues(this.deps.seated?.() ?? [], Number(this.deps.settings()['cash.chipsPerCurrencyUnit']));
      for (const id of ids) {
        let sum = 0;
        const points = events.filter((e) => e.userId === id && (kind === 'all' || (kind === 'tournament') === e.tournament)).map((e) => [e.at, (sum += e.amount)] as Point);
        // chips at the tables belong to cash
        if (kind !== 'tournament' && seated.get(id)) points.push([Date.now(), sum + seated.get(id)!]);
        out.push({ userId: id, nickname: nick.get(id) ?? '?', color: colors.get(id) ?? 1, points: thin(points) });
      }
    }
      return { series: out };
  }
}
