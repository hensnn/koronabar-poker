import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, ne, sql } from 'drizzle-orm';
import { accounts, type Ledger } from '@kb/ledger';
import { boardName, effectiveColumns, rankFor, sanitizeBoardConfig, type BoardColumn, type PermissionChecker, type PublicBoardConfig, type SettingValues } from '@kb/shared';
import type { AuditService, AuditSource } from './auth/audit.js';
import { schema, type Db } from './db/index.js';
import type { RatingService } from './rating.js';
import type { StatsService } from './stats.js';
import { thin } from './timeline.js';

type Meta = { ip?: string | null; source?: AuditSource; reason?: string | null };

export class PublicBoardError extends Error {
  constructor(public readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'RATE_LIMIT') {
    super(code);
  }
}

export interface PublicBoardRow {
  id: string;
  name: string;
  token: string;
  enabled: boolean;
  config: PublicBoardConfig;
  updatedAt: number;
}

export interface BoardRowView {
  rank: number;
  nickname: string;
  profit?: number;
  cashProfit?: number;
  tournamentProfit?: number;
  xp?: number;
  level?: number;
  rankName?: string;
  rankIcon?: string;
  rating?: number | null;
  division?: string;
  games?: number;
  wins?: number;
  itm?: number;
  avgPlace?: number | null;
  bounty?: number;
  cashHands?: number;
  /** Stav peněženky (virtuální žetony). */
  balance?: number;
}

export interface PublicBoardView {
  title: string;
  subtitle: string;
  columns: BoardColumn[];
  rows: BoardRowView[];
  currency: string;
  updatedAt: number;
  refreshSeconds: number;
  /** Vývoj zisku z turnajů v čase pro nejlepší hráče (prázdné, když graf nebo částky nejsou zapnuté). */
  chart: { id: string; name: string; points: [number, number][] }[];
}

interface Deps {
  db: Db;
  perms: PermissionChecker;
  audit: AuditService;
  settings: () => SettingValues;
  stats: () => StatsService;
  rating: () => RatingService;
  ledger: () => Ledger;
  now: () => number;
}

const DAY = 86_400_000;
const CACHE_MS = 30_000;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;

/**
 * Veřejné přehledy hráčů: žebříček, zisk, zkušenosti a základní údaje na tajném odkazu bez přihlášení.
 * Odkaz jde kdykoli vypnout nebo vyměnit. Nikdy se neposílají e-maily, osobní údaje (kromě přezdívky) ani nic skrytého ze hry; stav peněženky jen když ho správce zapne.
 */
export class PublicBoardService {
  private cache = new Map<string, { at: number; view: PublicBoardView }>();
  private hits = new Map<string, { start: number; n: number }>();

  constructor(private deps: Deps) {}

  private can(actorId: string): void {
    if (!this.deps.perms.can(actorId, 'nastaveni.globalni').allowed) throw new PublicBoardError('FORBIDDEN');
  }

  private dto(r: typeof schema.publicBoards.$inferSelect): PublicBoardRow {
    return { id: r.id, name: r.name, token: r.token, enabled: r.enabled, config: sanitizeBoardConfig(r.config), updatedAt: r.updatedAt.getTime() };
  }

  async list(actorId: string): Promise<{ boards: PublicBoardRow[]; enabled: boolean }> {
    this.can(actorId);
    const rows = await this.deps.db.select().from(schema.publicBoards).orderBy(desc(schema.publicBoards.createdAt));
    return { boards: rows.map((r) => this.dto(r)), enabled: !!this.deps.settings()['stats.publicEnabled'] };
  }

  async create(actorId: string, input: { name: string; config?: unknown }, meta: Meta = {}): Promise<PublicBoardRow> {
    this.can(actorId);
    const name = String(input.name ?? '').trim().slice(0, 80);
    if (!name) throw new PublicBoardError('INVALID');
    const [r] = await this.deps.db
      .insert(schema.publicBoards)
      .values({ name, token: randomBytes(24).toString('base64url'), config: sanitizeBoardConfig(input.config) as unknown as Record<string, unknown>, createdBy: actorId })
      .returning();
    await this.deps.audit.log({ actorId, action: 'prehled.vytvorit', targetType: 'public_board', targetId: r!.id, after: { name }, ...meta });
    return this.dto(r!);
  }

  async update(actorId: string, id: string, input: { name?: string; enabled?: boolean; config?: unknown }, meta: Meta = {}): Promise<PublicBoardRow> {
    this.can(actorId);
    const set: Partial<typeof schema.publicBoards.$inferInsert> = { updatedAt: new Date(this.deps.now()) };
    if (input.name !== undefined) {
      const name = String(input.name).trim().slice(0, 80);
      if (!name) throw new PublicBoardError('INVALID');
      set.name = name;
    }
    if (input.enabled !== undefined) set.enabled = !!input.enabled;
    if (input.config !== undefined) set.config = sanitizeBoardConfig(input.config) as unknown as Record<string, unknown>;
    const [r] = await this.deps.db.update(schema.publicBoards).set(set).where(eq(schema.publicBoards.id, id)).returning();
    if (!r) throw new PublicBoardError('NOT_FOUND');
    this.cache.clear();
    await this.deps.audit.log({ actorId, action: 'prehled.upravit', targetType: 'public_board', targetId: id, after: { enabled: r.enabled }, ...meta });
    return this.dto(r);
  }

  /** Nový tajný odkaz: starý přestane fungovat. */
  async rotate(actorId: string, id: string, meta: Meta = {}): Promise<PublicBoardRow> {
    this.can(actorId);
    const [r] = await this.deps.db.update(schema.publicBoards).set({ token: randomBytes(24).toString('base64url'), updatedAt: new Date(this.deps.now()) }).where(eq(schema.publicBoards.id, id)).returning();
    if (!r) throw new PublicBoardError('NOT_FOUND');
    this.cache.clear();
    await this.deps.audit.log({ actorId, action: 'prehled.novy_odkaz', targetType: 'public_board', targetId: id, ...meta });
    return this.dto(r);
  }

  async remove(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    this.can(actorId);
    await this.deps.db.delete(schema.publicBoards).where(eq(schema.publicBoards.id, id));
    this.cache.clear();
    await this.deps.audit.log({ actorId, action: 'prehled.smazat', targetType: 'public_board', targetId: id, ...meta });
  }

  /** Jednoduché omezení počtu dotazů z jedné adresy (veřejný endpoint bez přihlášení). */
  private throttle(ip: string): void {
    const now = this.deps.now();
    const h = this.hits.get(ip);
    if (!h || now - h.start > WINDOW_MS) this.hits.set(ip, { start: now, n: 1 });
    else if (++h.n > MAX_PER_WINDOW) throw new PublicBoardError('RATE_LIMIT');
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (now - v.start > WINDOW_MS) this.hits.delete(k);
  }

  /** Obsah přehledu pro veřejnou stránku. Neexistující, vypnutý přehled i vypnutá funkce vypadají stejně (NOT_FOUND). */
  async view(token: string, ip: string): Promise<PublicBoardView> {
    this.throttle(ip || 'neznama');
    if (!this.deps.settings()['stats.publicEnabled'] || !/^[A-Za-z0-9_-]{20,80}$/.test(token)) throw new PublicBoardError('NOT_FOUND');
    const hit = this.cache.get(token);
    if (hit && this.deps.now() - hit.at < CACHE_MS) return hit.view;
    const [board] = await this.deps.db.select().from(schema.publicBoards).where(and(eq(schema.publicBoards.token, token), eq(schema.publicBoards.enabled, true)));
    if (!board) throw new PublicBoardError('NOT_FOUND');
    const view = await this.build(board.name, sanitizeBoardConfig(board.config));
    this.cache.set(token, { at: this.deps.now(), view });
    return view;
  }

  /** Sestaví řádky přehledu z existujících žebříčků (zisk, zkušenosti, rating) podle nastavení přehledu. */
  async build(name: string, c: PublicBoardConfig): Promise<PublicBoardView> {
    const s = this.deps.settings();
    const features = { xp: s['xp.enabled'] !== false, rating: s['rating.enabled'] !== false && s['rating.tournamentsEnabled'] !== false };
    const columns = effectiveColumns(c, features);
    const now = this.deps.now();
    const range = { from: c.periodDays > 0 ? new Date(now - c.periodDays * DAY) : null, to: null };
    const leader = await this.deps.stats().leaderboard(range);
    const progress = features.xp ? await this.deps.db.select().from(schema.playerProgress).where(gt(schema.playerProgress.xp, 0)) : [];
    const ratings = features.rating ? await this.deps.rating().leaderboard('tournament') : [];

    const ids = new Set<string>([...leader.map((r) => r.userId), ...progress.map((r) => r.userId), ...ratings.map((r) => r.userId)]);
    for (const h of c.hiddenUserIds) ids.delete(h);
    if (ids.size === 0) return { title: c.title || name, subtitle: c.subtitle, columns, rows: [], currency: String(s['economy.currencySymbol'] ?? ''), updatedAt: now, refreshSeconds: c.refreshSeconds, chart: [] };
    const users = await this.deps.db
      .select({ id: schema.users.id, nickname: schema.users.nickname })
      .from(schema.users)
      .where(and(inArray(schema.users.id, [...ids]), ne(schema.users.status, 'blocked')));
    const nick = new Map(users.map((u) => [u.id, u.nickname]));
    const lead = new Map(leader.map((r) => [r.userId, r]));
    const prog = new Map(progress.map((r) => [r.userId, r]));
    const rate = new Map(ratings.map((r) => [r.userId, r]));
    const ranks = String(s['xp.ranks'] ?? '');

    let list = [...nick.keys()].map((id) => {
      const l = lead.get(id);
      const p = prog.get(id);
      const r = rate.get(id);
      return {
        id,
        nickname: nick.get(id)!,
        profit: l?.total ?? 0,
        cashProfit: l?.cashNet ?? 0,
        tournamentProfit: l?.tournamentNet ?? 0,
        xp: p?.xp ?? 0,
        level: p?.level ?? (features.xp ? 1 : undefined),
        rating: r ? r.rating : null,
        ratingOrder: r ? (r.rating ?? 100_000 - r.rank) : -1,
        division: r?.division,
        games: l?.games ?? 0,
        wins: l?.wins ?? 0,
        itm: l?.itm ?? 0,
        avgPlace: l?.avgPlace ?? null,
        bounty: l?.bounty ?? 0,
        cashHands: l?.cashHands ?? 0,
        balance: columns.includes('balance') ? this.deps.ledger().balance(accounts.wallet(id)) : 0,
      };
    });
    if (c.minGames > 0 || c.minHands > 0) list = list.filter((x) => (c.minGames > 0 && x.games >= c.minGames) || (c.minHands > 0 && x.cashHands >= c.minHands));
    const key: Record<PublicBoardConfig['sort'], (x: (typeof list)[number]) => number> = {
      profit: (x) => x.profit,
      xp: (x) => x.xp,
      rating: (x) => x.ratingOrder,
      wins: (x) => x.wins,
      games: (x) => x.games,
    };
    list.sort((a, b) => key[c.sort](b) - key[c.sort](a) || a.nickname.localeCompare(b.nickname, 'cs'));
    if (c.limit > 0) list = list.slice(0, c.limit);

    const rows: BoardRowView[] = list.map((x, i) => {
      const row: BoardRowView = { rank: i + 1, nickname: boardName(x.nickname, c.nameMode) };
      const has = (col: BoardColumn) => columns.includes(col);
      if (has('profit')) row.profit = x.profit;
      if (has('cashProfit')) row.cashProfit = x.cashProfit;
      if (has('tournamentProfit')) row.tournamentProfit = x.tournamentProfit;
      if (has('xp')) row.xp = x.xp;
      if (has('level') && x.level !== undefined) {
        const rk = rankFor(x.level, ranks);
        row.level = x.level;
        row.rankName = rk.name;
        row.rankIcon = rk.icon;
      }
      if (has('rating')) {
        row.rating = x.rating;
        row.division = x.division;
      }
      if (has('games')) row.games = x.games;
      if (has('wins')) row.wins = x.wins;
      if (has('itm')) row.itm = x.itm;
      if (has('avgPlace')) row.avgPlace = x.avgPlace;
      if (has('bounty')) row.bounty = x.bounty;
      if (has('cashHands')) row.cashHands = x.cashHands;
      if (has('balance')) row.balance = x.balance;
      return row;
    });
    const chart = c.showChart && c.showMoney ? await this.chart(list.slice(0, c.chartPlayers).map((x) => ({ id: x.id, name: boardName(x.nickname, c.nameMode) })), range.from) : [];
    return { title: c.title || name, subtitle: c.subtitle, columns, rows, currency: String(s['economy.currencySymbol'] ?? ''), updatedAt: now, refreshSeconds: c.refreshSeconds, chart };
  }

  /** Kumulovaný zisk z turnajů (výplata + bounty − vstupy) v čase pro vybrané hráče. */
  private async chart(players: { id: string; name: string }[], from: Date | null): Promise<PublicBoardView['chart']> {
    if (players.length === 0) return [];
    const gr = schema.gameResults;
    const conds = [inArray(gr.userId, players.map((p) => p.id)), eq(gr.kind, 'tournament')];
    if (from) conds.push(gte(gr.finishedAt, from));
    const rows = await this.deps.db.select({ userId: gr.userId, at: gr.finishedAt, net: sql<string>`${gr.payout} + ${gr.bounty} - ${gr.spent}` }).from(gr).where(and(...conds)).orderBy(asc(gr.finishedAt));
    return players.map((p, i) => {
      let sum = 0;
      const points = rows.filter((r) => r.userId === p.id).map((r) => [r.at.getTime(), (sum += Number(r.net))] as [number, number]);
      return { id: String(i), name: p.name, points: thin(points) };
    });
  }
}
