import { asc, eq, inArray, sql } from 'drizzle-orm';
import { accounts, type Ledger } from '@kb/ledger';
import type { SettingValues } from '@kb/shared';
import { gameEvents, gameNets } from './side-results.js';
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
    // Jen cash ruce; ruce odehrané v turnajích se sem nepočítají (turnaje mají vlastní sloupec).
    const handsRows = await db.select({ userId: schema.handPlayers.userId, n: sql<number>`count(*)::int` }).from(schema.handPlayers).where(eq(schema.handPlayers.kind, 'cash')).groupBy(schema.handPlayers.userId);
    const hands = new Map(handsRows.map((r) => [r.userId, Number(r.n)]));
    // Peníze podle účetní knihy (stejný zdroj jako vyúčtování v peněžence a výsledky večerů): cash včetně živého, turnaje včetně sázek a odměn na hlavu.
    const nets = await gameNets(db);
    const rate = Number(this.deps.settings()['cash.chipsPerCurrencyUnit']) || 1;
    const seated = new Map<string, number>();
    for (const x of this.deps.seated?.() ?? []) seated.set(x.userId, (seated.get(x.userId) ?? 0) + Math.floor(x.chips / rate));
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
    return { rows };
  }

  /** Vývoj vybraných hráčů v čase: výdělek ze všech her (turnaje + cash + živý cash v měně), zůstatek nebo XP. */
  async compare(userIds: string[], metric: CompareMetric): Promise<{ series: { userId: string; nickname: string; color: number; points: Point[] }[] }> {
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
      const events = await gameEvents(db, ids);
      const rate = Number(this.deps.settings()['cash.chipsPerCurrencyUnit']) || 1;
      const seated = new Map<string, number>();
      for (const x of this.deps.seated?.() ?? []) seated.set(x.userId, (seated.get(x.userId) ?? 0) + Math.floor(x.chips / rate));
      for (const id of ids) {
        let sum = 0;
        const points = events.filter((e) => e.userId === id).map((e) => [e.at, (sum += e.amount)] as Point);
        if (seated.get(id)) points.push([Date.now(), sum + seated.get(id)!]);
        out.push({ userId: id, nickname: nick.get(id) ?? '?', color: colors.get(id) ?? 1, points: thin(points) });
      }
    }
      return { series: out };
  }
}
