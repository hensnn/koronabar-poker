import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { analyzeHand, type PermissionChecker, type SettingValues } from '@kb/shared';
import type { HandRecordData, TableEvent } from '@kb/game-core';
import { schema, type Db } from './db/index.js';

export class StatsError extends Error {
  constructor(public code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID') {
    super(code);
  }
}

/** Kontext zdroje událostí: cash stůl, nebo stůl turnaje. */
export interface HandSource {
  tableId: string;
  kind: 'cash' | 'tournament';
  tournamentId?: string;
  settings: SettingValues;
  chipsPerUnit: number;
}

interface Pending {
  handId: string;
  blinds: { sb: number; bb: number; ante: number };
  actions: { userId: string; street: string; action: string; amount: number; facing: number }[];
}

export interface PlayerStats {
  hands: number;
  vpip: number;
  pfr: number;
  threeBet: number;
  wtsd: number;
  wsd: number;
  aggressionFactor: number | null;
  /** Čistý zisk z cash her v měně. */
  cashNet: number;
  biggestPot: number;
  bestHand: { key: string } | null;
  tournaments: { games: number; wins: number; itm: number; avgPlace: number | null; net: number; bounty: number; rebuys: number };
}

export interface LeaderRow {
  userId: string;
  nickname: string;
  cashHands: number;
  cashNet: number;
  games: number;
  wins: number;
  itm: number;
  avgPlace: number | null;
  rebuys: number;
  bounty: number;
  tournamentNet: number;
  total: number;
}

export type StatsRange = { from: Date | null; to: Date | null };

const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * Ukládání odehraných hand a výpočet statistik, žebříčků a sezón. Handy jdou do DB po jejich skončení
 * (mimo účetní knihu, nejde o peníze); hráčské karty vidí jen jejich majitel, ostatní jen ty odkryté.
 */
export class StatsService {
  private pending = new Map<string, Pending>();
  private lastHand = new Map<string, string>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private deps: {
      db: Db;
      perms: PermissionChecker;
      settings: () => SettingValues;
      now: () => number;
      onError?: (e: unknown) => void;
      /** Handa je uložená (zkušenosti a rating z ní vycházejí). */
      onHand?: (h: { handId: string; playedAt: number; kind: 'cash' | 'tournament'; tableId: string; players: { userId: string; wonShowdown: boolean }[] }) => void;
    },
  ) {}

  /** Počká na dokončení všech zápisů (testy, vypnutí serveru). */
  async idle(): Promise<void> {
    await this.writes;
  }

  private stopped = false;

  /** Vypnutí serveru: čekající zápisy se zahodí. */
  stop(): void {
    this.stopped = true;
  }

  private queue(fn: () => Promise<unknown>): void {
    this.writes = this.writes.then(() => (this.stopped ? undefined : fn())).catch((e) => this.deps.onError?.(e));
  }

  // ---------- záznam ----------

  /** Zpracuje událost stolu; ukládá se jen, když je záznam hand zapnutý. */
  onTableEvent(src: HandSource, e: TableEvent): void {
    if (!this.deps.settings()['stats.recordHands']) return;
    const key = src.tableId;
    if (e.type === 'handStart') {
      const n = (k: string) => Number(src.settings[k] ?? 0);
      this.pending.set(key, { handId: e.handId, blinds: { sb: n('table.smallBlind'), bb: n('table.bigBlind'), ante: n('table.ante') }, actions: [] });
    } else if (e.type === 'action') {
      this.pending.get(key)?.actions.push({ userId: e.userId, street: e.street, action: e.action, amount: e.amount, facing: e.facing });
    } else if (e.type === 'handEnd') {
      const p = this.pending.get(key);
      this.pending.delete(key);
      if (!p || p.handId !== e.handId) return;
      this.lastHand.set(key, e.handId);
      this.queue(() => this.saveHand(src, p, e.board, e.showdown, e.record));
    } else if (e.type === 'rake') {
      this.queue(() => this.deps.db.update(schema.hands).set({ rake: e.total }).where(eq(schema.hands.id, e.handId)));
    } else if (e.type === 'shown') {
      const handId = this.lastHand.get(key);
      if (handId) this.queue(() => this.deps.db.update(schema.handPlayers).set({ revealed: true }).where(and(eq(schema.handPlayers.handId, handId), eq(schema.handPlayers.userId, e.userId))));
    }
  }

  private async saveHand(src: HandSource, p: Pending, board: string[], showdown: boolean, rec: HandRecordData): Promise<void> {
    const flags = analyzeHand(p.actions, rec.players, board.length);
    const playedAt = new Date(this.deps.now());
    const known = new Set((await this.deps.db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, rec.players.map((x) => x.userId)))).map((u) => u.id));
    const players = rec.players.filter((x) => known.has(x.userId));
    if (players.length === 0) return;
    await this.deps.db.transaction(async (trx) => {
      await trx
        .insert(schema.hands)
        .values({
          id: p.handId,
          tableId: src.tableId,
          kind: src.kind,
          tournamentId: src.tournamentId ?? null,
          handNumber: rec.handNumber,
          playedAt,
          buttonSeat: rec.buttonSeat,
          board,
          pot: rec.players.reduce((n, x) => n + x.invested, 0),
          showdown,
          runs: rec.runs,
          chipsPerUnit: src.chipsPerUnit,
          blinds: p.blinds,
          actions: p.actions,
        })
        .onConflictDoNothing();
      await trx
        .insert(schema.handPlayers)
        .values(
          players.map((x) => {
            const f = flags.get(x.userId)!;
            return {
              handId: p.handId,
              userId: x.userId,
              seat: x.seat,
              kind: src.kind,
              playedAt,
              startStack: x.startStack,
              invested: x.invested,
              won: x.won,
              hole: x.hole,
              revealed: x.revealed,
              vpip: f.vpip,
              pfr: f.pfr,
              threeBetChance: f.threeBetChance,
              threeBet: f.threeBet,
              sawFlop: f.sawFlop,
              showdown: f.showdown,
              wonShowdown: f.wonShowdown,
              aggressive: f.aggressive,
              calls: f.calls,
              handScore: x.handScore,
              allInEquity: rec.allInEquity?.[x.userId] ?? null,
              handKey: x.handKey,
            };
          }),
        )
        .onConflictDoNothing();
    });
    this.deps.onHand?.({ handId: p.handId, playedAt: playedAt.getTime(), kind: src.kind, tableId: src.tableId, players: players.map((x) => ({ userId: x.userId, wonShowdown: flags.get(x.userId)?.wonShowdown ?? false })) });
  }

  /** Výsledky turnaje do statistik (po jeho skončení). Částky jsou v měně. */
  recordTournament(tournamentId: string, info: { targetMinutes: number; rated: boolean; live?: boolean }, st: { finishedAt: number | null; results: { userId: string; place: number; payout: number; bounty?: number }[] | null; payments: { userId: string; kind: string; cost: number; fee: number; refunded?: boolean }[] }): void {
    if (!st.results || st.results.length === 0) return;
    const results = st.results;
    const finishedAt = new Date(st.finishedAt ?? this.deps.now());
    this.queue(async () => {
      const known = new Set((await this.deps.db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, results.map((r) => r.userId)))).map((u) => u.id));
      const rows = results
        .filter((r) => known.has(r.userId))
        .map((r) => {
          const own = st.payments.filter((p) => p.userId === r.userId && !p.refunded);
          return { kind: 'tournament', ref: tournamentId, userId: r.userId, finishedAt, place: r.place, field: results.length, spent: own.reduce((n, p) => n + p.cost + p.fee, 0), payout: r.payout, bounty: r.bounty ?? 0, rebuys: own.filter((p) => p.kind === 'turnaj_rebuy').length, targetMinutes: info.targetMinutes, rated: info.rated, live: !!info.live };
        });
      if (rows.length > 0) await this.deps.db.insert(schema.gameResults).values(rows).onConflictDoNothing();
    });
  }

  // ---------- sezóny ----------

  private mustManage(actorId: string): void {
    if (!this.deps.perms.can(actorId, 'statistiky.sezony').allowed) throw new StatsError('FORBIDDEN');
  }

  async seasons(): Promise<{ id: string; name: string; startsAt: number; endsAt: number | null }[]> {
    const rows = await this.deps.db.select().from(schema.seasons).orderBy(desc(schema.seasons.startsAt));
    return rows.map((r) => ({ id: r.id, name: r.name, startsAt: r.startsAt.getTime(), endsAt: r.endsAt?.getTime() ?? null }));
  }

  async createSeason(actorId: string, input: { name: string; startsAt: number; endsAt?: number | null }): Promise<string> {
    this.mustManage(actorId);
    const name = input.name?.trim();
    if (!name || name.length > 60 || !Number.isFinite(input.startsAt) || (input.endsAt != null && input.endsAt <= input.startsAt)) throw new StatsError('INVALID');
    const [row] = await this.deps.db
      .insert(schema.seasons)
      .values({ name, startsAt: new Date(input.startsAt), endsAt: input.endsAt != null ? new Date(input.endsAt) : null })
      .returning({ id: schema.seasons.id });
    return row!.id;
  }

  async updateSeason(actorId: string, id: string, input: { name?: string; endsAt?: number | null }): Promise<void> {
    this.mustManage(actorId);
    const [cur] = await this.deps.db.select().from(schema.seasons).where(eq(schema.seasons.id, id));
    if (!cur) throw new StatsError('NOT_FOUND');
    const name = input.name !== undefined ? input.name.trim() : cur.name;
    const endsAt = input.endsAt !== undefined ? (input.endsAt === null ? null : new Date(input.endsAt)) : cur.endsAt;
    if (!name || name.length > 60 || (endsAt && endsAt <= cur.startsAt)) throw new StatsError('INVALID');
    await this.deps.db.update(schema.seasons).set({ name, endsAt }).where(eq(schema.seasons.id, id));
  }

  async deleteSeason(actorId: string, id: string): Promise<void> {
    this.mustManage(actorId);
    await this.deps.db.delete(schema.seasons).where(eq(schema.seasons.id, id));
  }

  /** `all` = celá historie, `current` = právě běžící sezóna (jinak celá historie), jinak id sezóny. */
  async range(season: string | undefined): Promise<StatsRange> {
    if (!season || season === 'all') return { from: null, to: null };
    const all = await this.seasons();
    const s = season === 'current' ? all.find((x) => x.startsAt <= this.deps.now() && (x.endsAt === null || x.endsAt > this.deps.now())) : all.find((x) => x.id === season);
    if (!s) {
      if (season === 'current') return { from: null, to: null };
      throw new StatsError('NOT_FOUND');
    }
    return { from: new Date(s.startsAt), to: s.endsAt ? new Date(s.endsAt) : null };
  }

  // ---------- čtení ----------

  private inRange(col: typeof schema.handPlayers.playedAt | typeof schema.gameResults.finishedAt, r: StatsRange) {
    return and(r.from ? gte(col, r.from) : undefined, r.to ? lt(col, r.to) : undefined);
  }

  async playerStats(viewerId: string, userId: string, range: StatsRange): Promise<PlayerStats> {
    if (viewerId !== userId && !this.deps.settings()['stats.publicProfiles'] && !this.deps.perms.can(viewerId, 'statistiky.sezony').allowed) throw new StatsError('FORBIDDEN');
    const hp = schema.handPlayers;
    const [a] = await this.deps.db
      .select({
        hands: sql<number>`count(*)`,
        vpip: sql<number>`count(*) filter (where ${hp.vpip})`,
        pfr: sql<number>`count(*) filter (where ${hp.pfr})`,
        chances: sql<number>`count(*) filter (where ${hp.threeBetChance})`,
        threeBet: sql<number>`count(*) filter (where ${hp.threeBet})`,
        sawFlop: sql<number>`count(*) filter (where ${hp.sawFlop})`,
        showdown: sql<number>`count(*) filter (where ${hp.showdown})`,
        wonShowdown: sql<number>`count(*) filter (where ${hp.wonShowdown})`,
        aggressive: sql<number>`coalesce(sum(${hp.aggressive}), 0)`,
        calls: sql<number>`coalesce(sum(${hp.calls}), 0)`,
        best: sql<number | null>`min(${hp.handScore}) filter (where ${hp.won} > 0)`,
      })
      .from(hp)
      .where(and(eq(hp.userId, userId), this.inRange(hp.playedAt, range)));
    const [cash] = await this.deps.db
      .select({
        net: sql<string>`coalesce(round(sum((${hp.won} - ${hp.invested})::numeric / ${schema.hands.chipsPerUnit})), 0)`,
        biggest: sql<string>`coalesce(max(${hp.won}::numeric / ${schema.hands.chipsPerUnit}), 0)`,
      })
      .from(hp)
      .innerJoin(schema.hands, eq(schema.hands.id, hp.handId))
      .where(and(eq(hp.userId, userId), eq(hp.kind, 'cash'), this.inRange(hp.playedAt, range)));
    // Živý cash (skutečné karty): výsledek hráče ze zápisů ředitele, bez hand.
    const [live] = await this.deps.db
      .select({ net: sql<string>`coalesce(sum(${schema.gameResults.payout} - ${schema.gameResults.spent}), 0)` })
      .from(schema.gameResults)
      .where(and(eq(schema.gameResults.userId, userId), eq(schema.gameResults.kind, 'live_cash'), this.inRange(schema.gameResults.finishedAt, range)));
    let bestHand: PlayerStats['bestHand'] = null;
    if (a?.best != null) {
      const [b] = await this.deps.db
        .select({ key: hp.handKey })
        .from(hp)
        .where(and(eq(hp.userId, userId), eq(hp.handScore, Number(a.best)), gte(hp.won, 1), this.inRange(hp.playedAt, range)))
        .limit(1);
      if (b?.key) bestHand = { key: b.key };
    }
    const gr = schema.gameResults;
    const [tr] = await this.deps.db
      .select({
        games: sql<number>`count(*)`,
        wins: sql<number>`count(*) filter (where ${gr.place} = 1)`,
        itm: sql<number>`count(*) filter (where ${gr.payout} > 0)`,
        avg: sql<string | null>`avg(${gr.place})`,
        net: sql<string>`coalesce(sum(${gr.payout} + ${gr.bounty} - ${gr.spent}), 0)`,
        bounty: sql<string>`coalesce(sum(${gr.bounty}), 0)`,
        rebuys: sql<string>`coalesce(sum(${gr.rebuys}), 0)`,
      })
      .from(gr)
      .where(and(eq(gr.userId, userId), eq(gr.kind, 'tournament'), this.inRange(gr.finishedAt, range)));
    const hands = Number(a?.hands ?? 0);
    const aggressive = Number(a?.aggressive ?? 0);
    const calls = Number(a?.calls ?? 0);
    return {
      hands,
      vpip: pct(Number(a?.vpip ?? 0), hands),
      pfr: pct(Number(a?.pfr ?? 0), hands),
      threeBet: pct(Number(a?.threeBet ?? 0), Number(a?.chances ?? 0)),
      wtsd: pct(Number(a?.showdown ?? 0), Number(a?.sawFlop ?? 0)),
      wsd: pct(Number(a?.wonShowdown ?? 0), Number(a?.showdown ?? 0)),
      aggressionFactor: calls > 0 ? Math.round((aggressive / calls) * 100) / 100 : null,
      cashNet: Number(cash?.net ?? 0) + Number(live?.net ?? 0),
      biggestPot: Math.floor(Number(cash?.biggest ?? 0)),
      bestHand,
      tournaments: {
        games: Number(tr?.games ?? 0),
        wins: Number(tr?.wins ?? 0),
        itm: Number(tr?.itm ?? 0),
        avgPlace: tr?.avg == null ? null : Math.round(Number(tr.avg) * 10) / 10,
        net: Number(tr?.net ?? 0),
        bounty: Number(tr?.bounty ?? 0),
        rebuys: Number(tr?.rebuys ?? 0),
      },
    };
  }

  /** Žebříček: čistý zisk v měně, cash a turnaje zvlášť i dohromady. */
  async leaderboard(range: StatsRange): Promise<LeaderRow[]> {
    const hp = schema.handPlayers;
    const cash = await this.deps.db
      .select({
        userId: hp.userId,
        hands: sql<number>`count(*)`,
        net: sql<string>`round(sum((${hp.won} - ${hp.invested})::numeric / ${schema.hands.chipsPerUnit}))`,
      })
      .from(hp)
      .innerJoin(schema.hands, eq(schema.hands.id, hp.handId))
      .where(and(eq(hp.kind, 'cash'), this.inRange(hp.playedAt, range)))
      .groupBy(hp.userId);
    const gr = schema.gameResults;
    const tour = await this.deps.db
      .select({
        userId: gr.userId,
        games: sql<number>`count(*)`,
        wins: sql<number>`count(*) filter (where ${gr.place} = 1)`,
        itm: sql<number>`count(*) filter (where ${gr.payout} > 0)`,
        avg: sql<string>`avg(${gr.place})`,
        net: sql<string>`sum(${gr.payout} + ${gr.bounty} - ${gr.spent})`,
        bounty: sql<string>`sum(${gr.bounty})`,
        rebuys: sql<string>`sum(${gr.rebuys})`,
      })
      .from(gr)
      .where(and(eq(gr.kind, 'tournament'), this.inRange(gr.finishedAt, range)))
      .groupBy(gr.userId);
    const liveRows = await this.deps.db
      .select({ userId: gr.userId, net: sql<string>`sum(${gr.payout} - ${gr.spent})` })
      .from(gr)
      .where(and(eq(gr.kind, 'live_cash'), this.inRange(gr.finishedAt, range)))
      .groupBy(gr.userId);
    const liveNet = new Map(liveRows.map((r) => [r.userId, Number(r.net)]));
    const minHands = Number(this.deps.settings()['stats.leaderboardMinHands'] ?? 0);
    const ids = [...new Set([...cash.map((c) => c.userId), ...tour.map((t) => t.userId), ...liveNet.keys()])];
    if (ids.length === 0) return [];
    const nicks = new Map((await this.deps.db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, ids))).map((u) => [u.id, u.nickname]));
    const rows: LeaderRow[] = [];
    for (const id of ids) {
      const c = cash.find((x) => x.userId === id);
      const t = tour.find((x) => x.userId === id);
      const cashHands = Number(c?.hands ?? 0);
      if (cashHands < minHands && !t && !liveNet.has(id)) continue;
      const cashNet = (cashHands >= minHands ? Number(c?.net ?? 0) : 0) + (liveNet.get(id) ?? 0);
      const tournamentNet = Number(t?.net ?? 0);
      rows.push({
        userId: id,
        nickname: nicks.get(id) ?? '?',
        cashHands,
        cashNet,
        games: Number(t?.games ?? 0),
        wins: Number(t?.wins ?? 0),
        itm: Number(t?.itm ?? 0),
        avgPlace: t ? Math.round(Number(t.avg) * 10) / 10 : null,
        rebuys: Number(t?.rebuys ?? 0),
        bounty: Number(t?.bounty ?? 0),
        tournamentNet,
        total: cashNet + tournamentNet,
      });
    }
    return rows.sort((x, y) => y.total - x.total || x.nickname.localeCompare(y.nickname, 'cs'));
  }

  // ---------- historie hand ----------

  async myHands(userId: string, opts: { limit?: number; before?: number; tableId?: string } = {}): Promise<
    { id: string; playedAt: number; kind: string; tableId: string; handNumber: number; board: string[]; hole: [string, string] | null; net: number; pot: number; chipsPerUnit: number; blinds: { sb: number; bb: number; ante: number }; showdown: boolean }[]
  > {
    const hp = schema.handPlayers;
    const rows = await this.deps.db
      .select({ h: schema.hands, p: hp })
      .from(hp)
      .innerJoin(schema.hands, eq(schema.hands.id, hp.handId))
      .where(and(eq(hp.userId, userId), opts.before ? lt(hp.playedAt, new Date(opts.before)) : undefined, opts.tableId ? eq(schema.hands.tableId, opts.tableId) : undefined))
      .orderBy(desc(hp.playedAt), desc(schema.hands.handNumber))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
    return rows.map(({ h, p }) => ({
      id: h.id,
      playedAt: h.playedAt.getTime(),
      kind: h.kind,
      tableId: h.tableId,
      handNumber: h.handNumber,
      board: h.board,
      hole: p.hole,
      net: p.won - p.invested,
      pot: h.pot,
      chipsPerUnit: h.chipsPerUnit,
      blinds: h.blinds,
      showdown: h.showdown,
    }));
  }

  /** Detail sdílené handy: bez kontroly účasti, karty jen ukázané při showdownu, dobrovolně odkryté, nebo vlastní. */
  handDetailShared(viewerId: string, handId: string, revealed: string[]) {
    return this.handDetail(viewerId, handId, { open: true, revealed });
  }

  /** Detail handy pro přehrání. Cizí karty se vrátí jen pokud byly odkryté; vlastní vždy. */
  async handDetail(viewerId: string, handId: string, opts: { open?: boolean; revealed?: string[] } = {}) {
    const [h] = await this.deps.db.select().from(schema.hands).where(eq(schema.hands.id, handId));
    if (!h) throw new StatsError('NOT_FOUND');
    const ps = await this.deps.db
      .select({ p: schema.handPlayers, nickname: schema.users.nickname })
      .from(schema.handPlayers)
      .innerJoin(schema.users, eq(schema.users.id, schema.handPlayers.userId))
      .where(eq(schema.handPlayers.handId, handId));
    const mine = ps.some((x) => x.p.userId === viewerId);
    if (!opts.open && !mine && !this.deps.perms.can(viewerId, 'statistiky.sezony').allowed) throw new StatsError('FORBIDDEN');
    return {
      id: h.id,
      kind: h.kind,
      tableId: h.tableId,
      handNumber: h.handNumber,
      playedAt: h.playedAt.getTime(),
      buttonSeat: h.buttonSeat,
      board: h.board,
      pot: h.pot,
      rake: h.rake,
      showdown: h.showdown,
      purged: h.purged,
      runs: h.runs,
      chipsPerUnit: h.chipsPerUnit,
      blinds: h.blinds,
      actions: h.actions,
      players: ps
        .map(({ p, nickname }) => ({
          userId: p.userId,
          nickname,
          seat: p.seat,
          startStack: p.startStack,
          invested: p.invested,
          won: p.won,
          net: p.won - p.invested,
          hole: p.userId === viewerId || p.revealed || (opts.revealed ?? []).includes(p.userId) ? p.hole : null,
          handKey: p.revealed ? p.handKey : null,
        }))
        .sort((a, b) => a.seat - b.seat),
    };
  }


  /** Po uplynutí doby uchování se smažou podrobnosti (akce, karty); součty pro statistiky a žebříček zůstanou. */
  async purgeOld(): Promise<number> {
    const days = Number(this.deps.settings()['stats.handRetentionDays'] ?? 0);
    if (days <= 0) return 0;
    const cutoff = new Date(this.deps.now() - days * 86_400_000);
    const old = await this.deps.db
      .update(schema.hands)
      .set({ actions: [], purged: true })
      .where(and(lt(schema.hands.playedAt, cutoff), eq(schema.hands.purged, false)))
      .returning({ id: schema.hands.id });
    if (old.length > 0) await this.deps.db.update(schema.handPlayers).set({ hole: null }).where(inArray(schema.handPlayers.handId, old.map((h) => h.id)));
    return old.length;
  }
}
