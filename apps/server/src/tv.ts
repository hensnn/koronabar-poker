import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Card, TableView, TableActor } from '@kb/game-core';
import type { PermissionChecker, SettingValues } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';
import type { LeaderRow, StatsRange } from './stats.js';
import { resultSummary, type TournamentManager } from './tournaments.js';
import type { TableManager } from './tables.js';
import type { AnnouncerService } from './announcer.js';
import type { EveningService } from './evenings.js';

export type TvErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'DISABLED' | 'CODE_INVALID' | 'RATE' | 'UNAUTHORIZED';

export class TvError extends Error {
  constructor(
    public code: TvErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export const TV_SCREENS = ['clock', 'payouts', 'players', 'leaderboard', 'table', 'polls', 'upcoming', 'evening'] as const;
export type TvScreenType = (typeof TV_SCREENS)[number];

export interface TvScreen {
  type: TvScreenType;
  /** Jak dlouho se obrazovka drží (výchozí z nastavení „tv.rotationSeconds“). */
  seconds?: number;
  /** Přenos stolu: id stolu nebo turnaje; chybí = vybere se sám. */
  tableId?: string;
  /** Hodiny, výplaty a hráči: konkrétní turnaj; chybí = ten hlavní. */
  tournamentId?: string;
}

export interface TvLayout {
  id: string;
  name: string;
  screens: TvScreen[];
  /** Vestavěný motiv pro televizi; chybí = výchozí. */
  themeId?: string;
  fontScalePercent?: number;
  /** Pruh se zprávami z chatu. */
  strip?: boolean;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LAYOUT_KEY = 'tv:layouts';
const MAX_LAYOUTS = 10;
const MAX_SCREENS = 20;
const WATCH_MS = 5 * 60_000;
const PAIR_FAILS = 10;
const PAIR_WINDOW_MS = 10 * 60_000;

export interface TvTournament {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  onBreak: boolean;
  live: boolean;
  levelNumber: number;
  level: { smallBlind: number; bigBlind: number; ante: number } | null;
  nextLevel: { smallBlind: number; bigBlind: number; ante: number } | null;
  clockKind: 'level' | 'break' | null;
  clockMs: number | null;
  levelMode: string;
  handsInLevel: number;
  levelHands: number;
  players: number;
  alive: number;
  avgStack: number | null;
  prizePool: number;
  payouts: { place: number; amount: number }[];
  bubble: boolean;
  standings: { name: string; place: number; chips: number | null; status: string; payout: number | null }[];
  results: { name: string; place: number; payout: number }[] | null;
}

export interface TvTable {
  id: string;
  name: string;
  /** Zpoždění přenosu v sekundách. */
  delay: number;
  /** Přenos ještě nemá dost starých dat (po zapnutí televize). */
  ready: boolean;
  view: PublicTableView | null;
}

/** Pohled na stůl pro televizi: jen veřejná pole (žádné akce, hlasování ani šance). */
export interface PublicTableView {
  handNumber: number;
  street: string | null;
  board: Card[];
  buttonSeat: number | null;
  actingSeat: number | null;
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  tournament: boolean;
  seats: { seat: number; name: string; stack: number; bet: number; status: string; isDealer: boolean; cards: [Card, Card] | null; hasCards: boolean }[];
  totalPot: number;
  winners: { seat: number; amount: number }[] | null;
}

export type CardsMode = 'never' | 'afterHand' | 'spectator';

/** Karty hráčů na televizi: nikdy, až po skončené handě, nebo tak, jak je vidí divák. */
export function publicTable(v: TableView, mode: CardsMode): PublicTableView {
  const finished = v.winners !== null;
  return {
    handNumber: v.handNumber,
    street: v.street,
    board: v.board,
    buttonSeat: v.buttonSeat,
    actingSeat: v.actingSeat,
    seatCount: v.info.seatCount,
    smallBlind: v.info.smallBlind,
    bigBlind: v.info.bigBlind,
    tournament: !!v.info.tournament,
    seats: v.seats.map((s) => ({
      seat: s.seat,
      name: s.name,
      stack: s.stack,
      bet: s.bet,
      status: s.status,
      isDealer: s.isDealer,
      cards: mode === 'never' || (mode === 'afterHand' && !finished) ? null : s.cards,
      hasCards: s.hasCards,
    })),
    totalPot: v.totalPot,
    winners: v.winners ? v.winners.map((w) => ({ seat: w.seat, amount: w.amount })) : null,
  };
}

interface Deps {
  db: Db;
  perms: PermissionChecker;
  audit: AuditService;
  settings: () => SettingValues;
  now: () => number;
  tournaments: () => TournamentManager;
  tables: () => TableManager;
  stats: () => { leaderboard(range: StatsRange): Promise<LeaderRow[]>; seasons(): Promise<{ id: string; name: string; startsAt: number; endsAt: number | null }[]> };
  rating: () => { leaderboard(scope: 'tournament' | 'cash'): Promise<{ rank: number; nickname: string; rating: number | null; division: string }[]> };
  mainChannelId: () => Promise<string>;
  announcer: () => AnnouncerService;
  evenings: () => EveningService;
}

type Meta = { ip?: string | null };

/**
 * TV režim: zařízení se párují jednorázovým kódem, pak čtou jen veřejný „TV snapshot“ (hodiny, výplaty, žebříčky,
 * ankety, zprávy a zpožděný přenos stolu bez karet). Token se ukládá jen jako otisk a jde kdykoli odvolat.
 */
export class TvService {
  private buffers = new Map<string, { at: number; view: TableView }[]>();
  private watched = new Map<string, number>();
  private fails = new Map<string, { n: number; until: number }>();
  private lastSeen = new Map<string, number>();
  private cache: { at: number; leaderboard: unknown } | null = null;
  private jingles: { id: string; soundId: string; nickname: string; kind: string; at: number }[] = [];

  constructor(private deps: Deps) {}

  private s() {
    return this.deps.settings();
  }

  private manage(userId: string): void {
    if (!this.deps.perms.can(userId, 'tv.spravovat').allowed) throw new TvError('FORBIDDEN');
  }

  private enabled(): void {
    if (!this.s()['tv.enabled']) throw new TvError('DISABLED');
  }

  // ---------- zařízení ----------

  private newCode(): { code: string; hash: string; expiresAt: Date } {
    let code = '';
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return { code, hash: sha(code), expiresAt: new Date(this.deps.now() + Number(this.s()['tv.pairCodeMinutes']) * 60_000) };
  }

  async createDevice(actorId: string, name: string, layoutId: string | null, meta: Meta = {}): Promise<{ id: string; code: string; expiresAt: number }> {
    this.manage(actorId);
    this.enabled();
    const clean = name.trim();
    if (clean.length < 2 || clean.length > 40) throw new TvError('INVALID', { field: 'name' });
    const c = this.newCode();
    const [row] = await this.deps.db.insert(schema.tvDevices).values({ name: clean, layoutId, pairCodeHash: c.hash, pairExpiresAt: c.expiresAt, createdBy: actorId }).returning();
    await this.deps.audit.log({ actorId, action: 'tv.zarizeni_zalozit', targetType: 'tv_device', targetId: row!.id, after: { name: clean, layoutId }, ...meta });
    return { id: row!.id, code: c.code, expiresAt: c.expiresAt.getTime() };
  }

  /** Nový kód pro už spárované zařízení: starý token přestane platit. */
  async renewCode(actorId: string, id: string, meta: Meta = {}): Promise<{ code: string; expiresAt: number }> {
    this.manage(actorId);
    this.enabled();
    const c = this.newCode();
    const [row] = await this.deps.db.update(schema.tvDevices).set({ pairCodeHash: c.hash, pairExpiresAt: c.expiresAt, tokenHash: null }).where(eq(schema.tvDevices.id, id)).returning();
    if (!row) throw new TvError('NOT_FOUND');
    await this.deps.audit.log({ actorId, action: 'tv.zarizeni_novy_kod', targetType: 'tv_device', targetId: id, ...meta });
    return { code: c.code, expiresAt: c.expiresAt.getTime() };
  }

  async updateDevice(actorId: string, id: string, patch: { name?: string; layoutId?: string | null }, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    const set: Partial<typeof schema.tvDevices.$inferInsert> = {};
    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (n.length < 2 || n.length > 40) throw new TvError('INVALID', { field: 'name' });
      set.name = n;
    }
    if (patch.layoutId !== undefined) set.layoutId = patch.layoutId;
    const [row] = await this.deps.db.update(schema.tvDevices).set(set).where(eq(schema.tvDevices.id, id)).returning();
    if (!row) throw new TvError('NOT_FOUND');
    await this.deps.audit.log({ actorId, action: 'tv.zarizeni_upravit', targetType: 'tv_device', targetId: id, after: patch, ...meta });
  }

  async removeDevice(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    const rows = await this.deps.db.delete(schema.tvDevices).where(eq(schema.tvDevices.id, id)).returning({ id: schema.tvDevices.id });
    if (rows.length === 0) throw new TvError('NOT_FOUND');
    this.lastSeen.delete(id);
    await this.deps.audit.log({ actorId, action: 'tv.zarizeni_odvolat', targetType: 'tv_device', targetId: id, ...meta });
  }

  async devices(actorId: string) {
    this.manage(actorId);
    const rows = await this.deps.db.select().from(schema.tvDevices).orderBy(desc(schema.tvDevices.createdAt));
    const now = this.deps.now();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      layoutId: r.layoutId,
      paired: !!r.tokenHash,
      codePending: !!r.pairCodeHash && !!r.pairExpiresAt && r.pairExpiresAt.getTime() > now,
      lastSeenAt: Math.max(r.lastSeenAt?.getTime() ?? 0, this.lastSeen.get(r.id) ?? 0) || null,
      createdAt: r.createdAt.getTime(),
    }));
  }

  /** Spárování: televize zadá kód a dostane dlouhý token (zobrazí se jen jednou). Po 10 chybách se adresa na čas zablokuje. */
  async pair(code: string, ip: string): Promise<{ token: string; deviceId: string; name: string }> {
    this.enabled();
    const now = this.deps.now();
    const f = this.fails.get(ip);
    if (f && f.n >= PAIR_FAILS && f.until > now) throw new TvError('RATE');
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const [row] = clean.length === 8 ? await this.deps.db.select().from(schema.tvDevices).where(eq(schema.tvDevices.pairCodeHash, sha(clean))) : [];
    if (!row || !row.pairExpiresAt || row.pairExpiresAt.getTime() < now) {
      const cur = f && f.until > now ? f : { n: 0, until: now + PAIR_WINDOW_MS };
      this.fails.set(ip, { n: cur.n + 1, until: cur.until });
      throw new TvError('CODE_INVALID');
    }
    const token = randomBytes(32).toString('base64url');
    await this.deps.db.update(schema.tvDevices).set({ tokenHash: sha(token), pairCodeHash: null, pairExpiresAt: null, lastSeenAt: new Date(now) }).where(eq(schema.tvDevices.id, row.id));
    this.fails.delete(ip);
    await this.deps.audit.log({ action: 'tv.zarizeni_sparovat', targetType: 'tv_device', targetId: row.id, ip });
    return { token, deviceId: row.id, name: row.name };
  }

  /** Znělka hráče pro televizi: zazní se stejným zpožděním jako přenos stolu. */
  pushJingle(e: { soundId: string; from: { nickname: string } }, kind: string, tableRelated: boolean): void {
    if (!this.s()['tv.enabled'] || !this.s()['sounds.jingleOnTv']) return;
    const now = this.deps.now();
    const delay = tableRelated ? Number(this.s()['tv.tableDelaySeconds']) * 1000 : 0;
    this.jingles.push({ id: `${now}-${this.jingles.length}`, soundId: e.soundId, nickname: e.from.nickname, kind, at: now + delay });
    this.jingles = this.jingles.filter((j) => now - j.at < 120_000).slice(-50);
  }

  /** Smí televize stáhnout tento zvuk? Jen když právě zazněl jako znělka. */
  jingleSoundAllowed(soundId: string): boolean {
    return this.jingles.some((j) => j.soundId === soundId && this.deps.now() - j.at < 120_000);
  }

  /** Ověří token televize (pro stažení audia hlasatele). */
  async authenticate(token: string | undefined): Promise<void> {
    this.enabled();
    await this.deviceByToken(token);
  }

  private async deviceByToken(token: string | undefined) {
    if (!token) throw new TvError('UNAUTHORIZED');
    const [row] = await this.deps.db.select().from(schema.tvDevices).where(eq(schema.tvDevices.tokenHash, sha(token)));
    if (!row) throw new TvError('UNAUTHORIZED');
    const now = this.deps.now();
    if (now - (this.lastSeen.get(row.id) ?? 0) > 60_000) {
      this.lastSeen.set(row.id, now);
      void this.deps.db.update(schema.tvDevices).set({ lastSeenAt: new Date(now) }).where(eq(schema.tvDevices.id, row.id)).catch(() => undefined);
    }
    return row;
  }

  // ---------- rozvržení ----------

  private defaultLayout(): TvLayout {
    const seconds = Number(this.s()['tv.rotationSeconds']);
    return {
      id: 'default',
      name: 'default',
      screens: TV_SCREENS.map((type) => ({ type, seconds })),
      fontScalePercent: Number(this.s()['tv.fontScalePercent']),
      strip: !!this.s()['tv.chatStrip'],
    };
  }

  async layouts(): Promise<TvLayout[]> {
    const [r] = await this.deps.db.select().from(schema.systemMeta).where(eq(schema.systemMeta.key, LAYOUT_KEY));
    const saved = Array.isArray(r?.value) ? (r!.value as TvLayout[]) : [];
    return saved;
  }

  private clean(list: unknown): TvLayout[] {
    if (!Array.isArray(list) || list.length > MAX_LAYOUTS) throw new TvError('INVALID', { field: 'layouts' });
    const ids = new Set<string>();
    return list.map((raw) => {
      const l = raw as Partial<TvLayout>;
      const id = String(l.id ?? '').trim();
      const name = String(l.name ?? '').trim();
      if (!/^[a-z0-9-]{1,30}$/.test(id) || ids.has(id) || name.length < 1 || name.length > 40) throw new TvError('INVALID', { field: 'id' });
      ids.add(id);
      if (!Array.isArray(l.screens) || l.screens.length < 1 || l.screens.length > MAX_SCREENS) throw new TvError('INVALID', { field: 'screens' });
      const screens = l.screens.map((sc) => {
        if (!TV_SCREENS.includes(sc.type)) throw new TvError('INVALID', { field: 'type' });
        const out: TvScreen = { type: sc.type };
        if (sc.seconds !== undefined) {
          if (!Number.isInteger(sc.seconds) || sc.seconds < 3 || sc.seconds > 600) throw new TvError('INVALID', { field: 'seconds' });
          out.seconds = sc.seconds;
        }
        if (sc.tableId) out.tableId = String(sc.tableId).slice(0, 80);
        if (sc.tournamentId) out.tournamentId = String(sc.tournamentId).slice(0, 80);
        return out;
      });
      const res: TvLayout = { id, name, screens };
      if (l.themeId) res.themeId = String(l.themeId).slice(0, 60);
      if (l.fontScalePercent !== undefined) {
        if (!Number.isInteger(l.fontScalePercent) || l.fontScalePercent < 50 || l.fontScalePercent > 300) throw new TvError('INVALID', { field: 'fontScalePercent' });
        res.fontScalePercent = l.fontScalePercent;
      }
      if (l.strip !== undefined) res.strip = !!l.strip;
      return res;
    });
  }

  async saveLayouts(actorId: string, list: unknown, meta: Meta = {}): Promise<TvLayout[]> {
    this.manage(actorId);
    const clean = this.clean(list);
    await this.deps.db.insert(schema.systemMeta).values({ key: LAYOUT_KEY, value: clean }).onConflictDoUpdate({ target: schema.systemMeta.key, set: { value: clean } });
    await this.deps.audit.log({ actorId, action: 'tv.rozvrzeni_ulozit', targetType: 'tv_layouts', after: { ids: clean.map((l) => l.id) }, ...meta });
    return clean;
  }

  private async layoutFor(layoutId: string | null): Promise<TvLayout> {
    const saved = await this.layouts();
    const wanted = layoutId ?? String(this.s()['tv.defaultLayout'] ?? 'default');
    const found = saved.find((l) => l.id === wanted) ?? saved.find((l) => l.id === String(this.s()['tv.defaultLayout'])) ?? this.defaultLayout();
    const seconds = Number(this.s()['tv.rotationSeconds']);
    return {
      ...found,
      screens: found.screens.map((sc) => ({ ...sc, seconds: sc.seconds ?? seconds })),
      fontScalePercent: found.fontScalePercent ?? Number(this.s()['tv.fontScalePercent']),
      strip: found.strip ?? !!this.s()['tv.chatStrip'],
    };
  }

  // ---------- zpožděný přenos stolu ----------

  /** Volá se při každé změně stolu: ukládá veřejný pohled, ale jen když se na přenos někdo dívá. */
  onTableChange(tableId: string): void {
    const seen = this.watched.get(tableId);
    if (seen === undefined || this.deps.now() - seen > WATCH_MS) return;
    this.record(tableId);
  }

  private record(tableId: string): void {
    const actor = this.deps.tables().actors.get(tableId) as TableActor | undefined;
    if (!actor) return;
    const at = this.deps.now();
    const buf = this.buffers.get(tableId) ?? [];
    buf.push({ at, view: actor.viewFor(null) });
    // Drží se jen to, co zpoždění ještě může potřebovat: poslední záznam starší než zpoždění a vše novější.
    const cutoff = at - Number(this.s()['tv.tableDelaySeconds']) * 1000;
    let keepFrom = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i]!.at <= cutoff) keepFrom = i;
    const kept = buf.slice(keepFrom).slice(-600);
    this.buffers.set(tableId, kept);
  }

  /** Vybere stůl pro přenos: běžící online turnaj, jinak stůl s nejvíc hráči. */
  private autoTable(): string | null {
    const actors = this.deps.tables().actors;
    const tours = this.deps.tournaments();
    const running = tours.list().filter((r) => tours.get(r.id)?.state().status === 'running' && tours.tableIdsOf(r.id).some((id) => actors.has(id)));
    const pool = running.length ? running.flatMap((r) => tours.tableIdsOf(r.id).filter((id) => actors.has(id))) : [...actors.keys()];
    let best: { id: string; n: number } | null = null;
    for (const id of pool) {
      const n = actors.get(id)!.viewFor(null).seats.length;
      if (n > 0 && (!best || n > best.n)) best = { id, n };
    }
    return best?.id ?? null;
  }

  private tableName(id: string): string {
    return this.deps.tables().row(id)?.name ?? this.deps.tournaments().tableLabel(id) ?? this.deps.tournaments().nameOf(id) ?? id;
  }

  private tableFor(id: string): TvTable {
    const s = this.s();
    const delay = Number(s['tv.tableDelaySeconds']);
    const mode = String(s['tv.cardsMode']) as CardsMode;
    const actor = this.deps.tables().actors.get(id);
    const base = { id, name: this.tableName(id), delay };
    if (!actor) return { ...base, ready: false, view: null };
    const now = this.deps.now();
    if (delay <= 0) return { ...base, ready: true, view: publicTable(actor.viewFor(null), mode) };
    const first = !this.watched.has(id) || now - this.watched.get(id)! > WATCH_MS;
    this.watched.set(id, now);
    if (first) this.record(id);
    const buf = this.buffers.get(id) ?? [];
    const cutoff = now - delay * 1000;
    let pick: TableView | null = null;
    for (const e of buf) if (e.at <= cutoff) pick = e.view;
    return { ...base, ready: pick !== null, view: pick ? publicTable(pick, mode) : null };
  }

  // ---------- snapshot ----------

  private tournamentOf(id: string): TvTournament | null {
    const tours = this.deps.tournaments();
    const tour = tours.get(id);
    const row = tours.row(id);
    if (!tour || !row) return null;
    const st = tour.state();
    const s = tours.settingsOf(id)!;
    const level = tour.currentLevel();
    const levels = tour.levels();
    const alive = st.players.filter((p) => p.status === 'playing' || p.status === 'deciding').length;
    const isLive = !!s['tournament.live'];
    let chips = 0;
    for (const p of st.payments) if (!p.refunded) chips += Number(s[p.kind === 'turnaj_buyin' ? 'tournament.startingStack' : p.kind === 'turnaj_rebuy' ? 'tournament.rebuyChips' : 'tournament.addonChips']);
    const results = st.results;
    return {
      id,
      name: row.name,
      status: st.status,
      paused: st.paused,
      onBreak: st.onBreak,
      live: isLive,
      levelNumber: tour.levelNumber(),
      level: level ? { smallBlind: level.smallBlind, bigBlind: level.bigBlind, ante: level.ante } : null,
      nextLevel: st.levelIndex < levels.length - 1 ? { smallBlind: levels[st.levelIndex + 1]!.smallBlind, bigBlind: levels[st.levelIndex + 1]!.bigBlind, ante: levels[st.levelIndex + 1]!.ante } : null,
      clockKind: st.clock.kind,
      clockMs: tour.clockRemainingMs(),
      levelMode: String(s['tournament.levelMode']),
      handsInLevel: st.handsInLevel,
      levelHands: Number(s['tournament.levelHands']),
      players: st.players.length,
      alive,
      avgStack: st.status === 'running' && alive > 0 ? Math.floor(chips / alive) : null,
      prizePool: tour.prizePool() || st.payments.filter((p) => !p.refunded).reduce((a, p) => a + (p.cost - (p.house ?? 0) - (p.fund ?? 0) - (p.bounty ?? 0)), 0),
      payouts: tour.payoutPreview(),
      bubble: tour.isBubble(),
      standings: tour.standings().map((p) => ({ name: p.name, place: p.place, chips: isLive ? null : p.chips, status: p.status, payout: results?.find((r) => r.userId === p.userId)?.payout ?? null, profit: ((r) => (r ? resultSummary(st, r).profit : null))(results?.find((r) => r.userId === p.userId)) })),
      results: results ? results.map((r) => ({ name: r.name, place: r.place, payout: r.payout })) : null,
    };
  }

  private async boards() {
    const now = this.deps.now();
    if (this.cache && now - this.cache.at < 30_000) return this.cache.leaderboard as { seasonName: string | null; season: Row[]; rating: RatingRow[]; evening: Row[] };
    const stats = this.deps.stats();
    const seasons = await stats.seasons();
    const current = seasons.find((x) => x.startsAt <= now && (x.endsAt === null || x.endsAt > now)) ?? null;
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    const top = (rows: LeaderRow[]): Row[] =>
      [...rows]
        .sort((a, b) => b.total - a.total)
        .slice(0, 10)
        .map((r, i) => ({ rank: i + 1, nickname: r.nickname, value: r.total }));
    const season = current ? top(await stats.leaderboard({ from: new Date(current.startsAt), to: current.endsAt ? new Date(current.endsAt) : null })) : top(await stats.leaderboard({ from: null, to: null }));
    // Večerní žebříček: podle herního večera, který běží (nebo právě skončil); bez večera podle dnešního dne.
    const board = this.s()['evening.enabled'] ? await this.deps.evenings().tvBoard() : null;
    const evening: Row[] = board ? board.players.map((p) => ({ rank: p.rank, nickname: p.nickname, value: p.net })) : top((await stats.leaderboard({ from: day, to: null })).filter((r) => r.total !== 0));
    const rating = (await this.deps.rating().leaderboard('tournament')).slice(0, 10).map((r) => ({ rank: r.rank, nickname: r.nickname, rating: r.rating, division: r.division }));
    const out = { seasonName: current?.name ?? null, season, rating, evening };
    this.cache = { at: now, leaderboard: out };
    return out;
  }

  private async ticker() {
    const channelId = await this.deps.mainChannelId();
    const rows = await this.deps.db
      .select({ body: schema.chatMessages.body, at: schema.chatMessages.createdAt, system: schema.chatMessages.system, nick: schema.users.nickname })
      .from(schema.chatMessages)
      .leftJoin(schema.users, eq(schema.users.id, schema.chatMessages.userId))
      .where(and(eq(schema.chatMessages.channelId, channelId), isNull(schema.chatMessages.deletedAt)))
      .orderBy(desc(schema.chatMessages.id))
      .limit(8);
    return rows.reverse().map((r) => ({ nick: r.system ? null : (r.nick ?? '?'), body: r.body.slice(0, 160), at: r.at.getTime() }));
  }

  async snapshot(token: string | undefined) {
    this.enabled();
    const device = await this.deviceByToken(token);
    const layout = await this.layoutFor(device.layoutId);
    const now = this.deps.now();
    const tours = this.deps.tournaments();
    const active = tours
      .list()
      .map((r) => ({ id: r.id, st: tours.get(r.id)?.state().status }))
      .filter((x) => x.st === 'running' || x.st === 'registering')
      .sort((a, b) => (a.st === b.st ? 0 : a.st === 'running' ? -1 : 1))
      .slice(0, 4)
      .map((x) => x.id);
    // Poslední skončený turnaj zůstává na televizi s výsledky, dokud nezačne další.
    const recentDone = tours
      .list()
      .map((r) => ({ id: r.id, st: tours.get(r.id)?.state() }))
      .filter((x) => x.st?.status === 'finished' && x.st.finishedAt && now - x.st.finishedAt < 3 * 3600_000)
      .sort((a, b) => b.st!.finishedAt! - a.st!.finishedAt!)
      .slice(0, 1)
      .map((x) => x.id);
    const tournaments = [...active, ...recentDone].map((id) => this.tournamentOf(id)).filter((x): x is TvTournament => !!x);

    const wantedTables = new Set<string>();
    for (const sc of layout.screens) if (sc.type === 'table') wantedTables.add(sc.tableId ?? 'auto');
    const tables: Record<string, TvTable | null> = {};
    for (const key of wantedTables) {
      const id = key === 'auto' ? this.autoTable() : key;
      tables[key] = id ? this.tableFor(id) : null;
    }

    const upcoming = tours
      .scheduled()
      .filter((x) => x.status === 'registering')
      .sort((a, b) => a.sched.startAt - b.sched.startAt)
      .slice(0, 6)
      .map((x) => ({ id: x.id, name: tours.nameOf(x.id) ?? '', startAt: x.sched.startAt, players: tours.registeredUsers(x.id).length }));

    const pollRows = this.s()['poll.enabled'] === false ? [] : await this.deps.db.select().from(schema.polls).where(inArray(schema.polls.status, ['open', 'tie'])).orderBy(desc(schema.polls.createdAt)).limit(5);
    const polls = pollRows.map((p) => ({ id: p.id, title: p.title, endsAt: p.endsAt.getTime() }));

    return {
      serverTime: now,
      device: { id: device.id, name: device.name },
      layout,
      themeId: layout.themeId || String(this.s()['tv.themeId'] ?? '') || null,
      tournaments,
      tables,
      boards: await this.boards(),
      evening: this.s()['evening.enabled'] ? await this.deps.evenings().tvBoard() : null,
      upcoming,
      polls,
      ticker: layout.strip ? await this.ticker() : [],
      jingles: this.jingles.filter((j) => j.at <= now && now - j.at < 30_000).map((j) => ({ id: j.id, soundId: j.soundId, nickname: j.nickname, kind: j.kind })),
      announcer: { enabled: !!this.s()['announcer.enabled'], audio: this.deps.announcer().tvAudio(), ratePercent: Number(this.s()['announcer.ratePercent']), volumePercent: Number(this.s()['announcer.volumePercent']), items: this.s()['announcer.enabled'] ? this.deps.announcer().forTv(now) : [] },
    };
  }
}

interface Row {
  rank: number;
  nickname: string;
  value: number;
}
interface RatingRow {
  rank: number;
  nickname: string;
  rating: number | null;
  division: string;
}
