import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { dayKey, fromLocal, levelFor, levelTable, rankFor, weekKey, type Rank, type SettingValues } from '@kb/shared';
import { schema, type Db } from './db/index.js';

export interface HandInfo {
  handId: string;
  playedAt: number;
  kind: 'cash' | 'tournament';
  tableId: string;
  players: { userId: string; wonShowdown: boolean }[];
}

export interface ProgressDto {
  userId: string;
  xp: number;
  level: number;
  into: number;
  need: number;
  rank: Rank;
}

export interface XpRecomputeReport {
  /** Počet hráčů, kterým se XP změní. */
  changed: number;
  hands: number;
  tournaments: number;
  rows: { nickname: string; before: number; after: number; levelBefore: number; levelAfter: number }[];
}

class PreviewRollback extends Error {}

export interface BriefDto {
  userId: string;
  level: number;
  rank: { name: string; icon: string; color: string };
}

type Source = 'hand' | 'showdownWin' | 'cashSession' | 'tournamentPlayed' | 'placement' | 'itm' | 'tournamentWin' | 'knockout' | 'firstDaily' | 'firstWeekly' | 'series' | 'achievement';

const num = (s: SettingValues, k: string) => Number(s[k] ?? 0);

/**
 * Zkušenosti (XP) a level. Každý zisk je zapsán v `xp_events` s jedinečným klíčem (hráč, zdroj, odkaz),
 * takže stejná událost nikdy nepřidá XP dvakrát. Součet a level jsou v `player_progress` pro rychlé čtení.
 */
export class ProgressService {
  private queue: Promise<unknown> = Promise.resolve();
  /** Bonusy prvního dne / týdne a cash sezení, které už jsou zapsané (ušetří dotazy při každé handě). */
  private done = new Set<string>();

  constructor(
    private deps: {
      db: Db;
      settings: () => SettingValues;
      now: () => number;
      /** Hráč postoupil na vyšší level (upozornění, animace). */
      onLevelUp?: (userId: string, level: number, rank: Rank, rankChanged: boolean) => void;
      /** Po zápisu XP z hry nebo turnaje (vyhodnocení úspěchů). */
      onActivity?: (userIds: string[], trigger: 'hand' | 'tournament') => void;
      onError?: (e: unknown) => void;
    },
  ) {}

  /** Počká na dokončení všech zápisů (testy, vypnutí). */
  async idle(): Promise<void> {
    await this.queue;
  }

  private stopped = false;

  /** Vypnutí serveru: čekající zápisy se zahodí (jsou odvozené z uložených hand a dají se přepočítat). */
  stop(): void {
    this.stopped = true;
  }

  private enqueue(fn: () => Promise<unknown>): void {
    this.queue = this.queue.then(() => (this.stopped ? undefined : fn())).catch((e) => this.deps.onError?.(e));
  }

  private get s(): SettingValues {
    return this.deps.settings();
  }

  private curve() {
    return { base: num(this.s, 'xp.levelBase'), exponentPercent: num(this.s, 'xp.levelExponentPercent') };
  }

  // ---------- zápis XP ----------

  /**
   * Zapíše XP. `accumulate` sčítá do jednoho řádku (např. všechny handy dne). Vrací, kolik XP se skutečně připsalo
   * (0, pokud už zápis existuje nebo je překročený denní strop).
   */
  private async award(userId: string, source: Source, ref: string, day: string, amount: number, opts: { accumulate?: boolean; capped?: boolean } = {}): Promise<number> {
    if (!this.s['xp.enabled'] || amount <= 0) return 0;
    const cap = num(this.s, 'xp.dailyCap');
    let give = amount;
    if (cap > 0 && opts.capped !== false && source !== 'achievement') {
      const [d] = await this.deps.db
        .select({ total: sql<string>`coalesce(sum(${schema.xpEvents.amount}), 0)` })
        .from(schema.xpEvents)
        .where(and(eq(schema.xpEvents.userId, userId), eq(schema.xpEvents.day, day), sql`${schema.xpEvents.source} <> 'achievement'`));
      give = Math.max(0, Math.min(amount, cap - Number(d?.total ?? 0)));
      if (give <= 0) return 0;
    }
    const inserted = opts.accumulate
      ? await this.deps.db
          .insert(schema.xpEvents)
          .values({ userId, source, ref, day, amount: give, createdAt: new Date(this.deps.now()) })
          .onConflictDoUpdate({ target: [schema.xpEvents.userId, schema.xpEvents.source, schema.xpEvents.ref], set: { amount: sql`${schema.xpEvents.amount} + ${give}` } })
          .returning({ id: schema.xpEvents.id })
      : await this.deps.db
          .insert(schema.xpEvents)
          .values({ userId, source, ref, day, amount: give, createdAt: new Date(this.deps.now()) })
          .onConflictDoNothing()
          .returning({ id: schema.xpEvents.id });
    if (inserted.length === 0) return 0;
    await this.addTotal(userId, give);
    return give;
  }

  private async addTotal(userId: string, amount: number): Promise<void> {
    const [before] = await this.deps.db.select().from(schema.playerProgress).where(eq(schema.playerProgress.userId, userId));
    const xp = (before?.xp ?? 0) + amount;
    const info = levelFor(xp, this.curve());
    await this.deps.db
      .insert(schema.playerProgress)
      .values({ userId, xp, level: info.level, updatedAt: new Date(this.deps.now()) })
      .onConflictDoUpdate({ target: schema.playerProgress.userId, set: { xp, level: info.level, updatedAt: new Date(this.deps.now()) } });
    const oldLevel = before?.level ?? 1;
    if (info.level > oldLevel) {
      const ranks = String(this.s['xp.ranks']);
      const rank = rankFor(info.level, ranks);
      this.deps.onLevelUp?.(userId, info.level, rank, rankFor(oldLevel, ranks).name !== rank.name);
    }
  }

  /** XP za odměnu (úspěch); neomezuje ho denní strop. */
  grant(userId: string, ref: string, amount: number): void {
    this.enqueue(() => this.award(userId, 'achievement', ref, dayKey(this.deps.now()), amount, { capped: false }));
  }

  // ---------- zdroje XP ----------

  /** Po uložení handy: XP za handu, výhru na showdownu, cash sezení a první hru dne a týdne. */
  onHand(h: HandInfo): void {
    if (!this.s['xp.enabled'] || h.players.length < num(this.s, 'xp.minHumanPlayers')) return;
    this.enqueue(async () => {
      const day = dayKey(h.playedAt);
      const week = weekKey(h.playedAt);
      for (const p of h.players) {
        await this.award(p.userId, 'hand', day, day, num(this.s, 'xp.perHand'), { accumulate: true });
        if (p.wonShowdown) await this.award(p.userId, 'showdownWin', day, day, num(this.s, 'xp.showdownWin'), { accumulate: true });
        await this.once(p.userId, 'firstDaily', day, day, num(this.s, 'xp.firstDaily'));
        await this.once(p.userId, 'firstWeekly', week, day, num(this.s, 'xp.firstWeekly'));
        if (h.kind === 'cash') await this.cashSession(p.userId, h.tableId, h.playedAt, day);
      }
      this.deps.onActivity?.(h.players.map((p) => p.userId), 'hand');
    });
  }

  /** Jednorázový zápis; po prvním pokusu v daném dni / týdnu se už nedotazuje. */
  private async once(userId: string, source: Source, ref: string, day: string, amount: number): Promise<void> {
    const k = `${userId}|${source}|${ref}`;
    if (this.done.has(k)) return;
    await this.award(userId, source, ref, day, amount);
    if (this.done.size > 20_000) this.done.clear();
    this.done.add(k);
  }

  private async cashSession(userId: string, tableId: string, at: number, day: string): Promise<void> {
    const key = `${userId}|cashSession|${tableId}:${day}`;
    if (this.done.has(key)) return;
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    const from = new Date(fromLocal(y, m, d, 0, 0));
    const [c] = await this.deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.handPlayers)
      .innerJoin(schema.hands, eq(schema.hands.id, schema.handPlayers.handId))
      .where(and(eq(schema.handPlayers.userId, userId), eq(schema.hands.tableId, tableId), gte(schema.hands.playedAt, from)));
    if ((c?.n ?? 0) >= num(this.s, 'xp.cashSessionHands')) {
      await this.award(userId, 'cashSession', `${tableId}:${day}`, dayKey(at), num(this.s, 'xp.cashSession'));
      this.done.add(key);
    }
  }

  /** Vyřazení hráče v turnaji: zapíše se kdo koho vyřadil a vyřazujícím se připíše XP. */
  onElimination(tournamentId: string, e: { userId: string; remaining: number; by: { userId: string; weight: number; equity?: number | null }[] }): void {
    const at = this.deps.now();
    this.enqueue(async () => {
      const [known] = await this.deps.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, e.userId));
      if (!known) return;
      const killers = e.by.filter((k) => k.userId !== e.userId);
      await this.deps.db
        .insert(schema.tournamentEliminations)
        .values({ tournamentId, victimId: e.userId, place: e.remaining + 1, killers, at: new Date(at) })
        .onConflictDoNothing();
      for (const k of killers) await this.award(k.userId, 'knockout', `${tournamentId}:${e.userId}`, dayKey(at), num(this.s, 'xp.knockout'));
      this.deps.onActivity?.(killers.map((k) => k.userId), 'tournament');
    });
  }

  /** Po skončení turnaje: účast, umístění, peníze, výhra, série a bonus první hry dne a týdne. */
  onTournamentFinished(tournamentId: string, results: { userId: string; place: number; payout: number }[], seriesId: string | null, finishedAt: number | null): void {
    if (!this.s['xp.enabled'] || results.length < num(this.s, 'xp.minHumanPlayers')) return;
    const at = finishedAt ?? this.deps.now();
    this.enqueue(async () => {
      const day = dayKey(at);
      const week = weekKey(at);
      const field = results.length;
      for (const r of results) {
        await this.award(r.userId, 'tournamentPlayed', tournamentId, day, num(this.s, 'xp.tournamentPlayed'));
        await this.award(r.userId, 'placement', tournamentId, day, num(this.s, 'xp.placementPerBeaten') * Math.max(0, field - r.place));
        if (r.payout > 0) await this.award(r.userId, 'itm', tournamentId, day, num(this.s, 'xp.itm'));
        if (r.place === 1) await this.award(r.userId, 'tournamentWin', tournamentId, day, num(this.s, 'xp.tournamentWin'));
        if (seriesId) await this.award(r.userId, 'series', seriesId, day, num(this.s, 'xp.series'));
        await this.award(r.userId, 'firstDaily', day, day, num(this.s, 'xp.firstDaily'));
        await this.award(r.userId, 'firstWeekly', week, day, num(this.s, 'xp.firstWeekly'));
      }
      this.deps.onActivity?.(results.map((r) => r.userId), 'tournament');
    });
  }

  /** Živý cash skončil: hráči dostanou XP za sezení a bonus první hry dne a týdne. */
  onLiveCashClosed(gameId: string, userIds: string[], finishedAt: number | null): void {
    if (!this.s['xp.enabled'] || userIds.length < num(this.s, 'xp.minHumanPlayers')) return;
    const at = finishedAt ?? this.deps.now();
    this.enqueue(async () => {
      const day = dayKey(at);
      const week = weekKey(at);
      for (const userId of userIds) {
        await this.award(userId, 'cashSession', `live:${gameId}`, day, num(this.s, 'xp.cashSession'));
        await this.award(userId, 'firstDaily', day, day, num(this.s, 'xp.firstDaily'));
        await this.award(userId, 'firstWeekly', week, day, num(this.s, 'xp.firstWeekly'));
      }
      this.deps.onActivity?.(userIds, 'tournament');
    });
  }

  // ---------- zpětný přepočet ----------

  /**
   * Přepočítá XP všech hráčů z uložené historie (handy, turnaje, vyřazení) podle aktuálního nastavení.
   * Odměny za úspěchy zůstávají. Běží v jedné transakci: pro náhled se vrátí zpět, jinak se potvrdí.
   */
  recompute(preview: boolean): Promise<XpRecomputeReport> {
    let report: XpRecomputeReport = { changed: 0, hands: 0, tournaments: 0, rows: [] };
    this.enqueue(async () => {
      try {
        await this.deps.db.transaction(async (trx) => {
          report = await this.replay(trx as unknown as Db);
          if (preview) throw new PreviewRollback();
        });
      } catch (e) {
        if (!(e instanceof PreviewRollback)) throw e;
      }
    });
    return this.queue.then(() => report);
  }

  private async replay(db: Db): Promise<XpRecomputeReport> {
    const s = this.s;
    const minPlayers = num(s, 'xp.minHumanPlayers');
    type Award = { userId: string; source: Source; ref: string; day: string; amount: number; at: number; accumulate?: boolean; capped?: boolean };
    const awards: Award[] = [];
    const before = new Map((await db.select().from(schema.playerProgress)).map((r) => [r.userId, { xp: r.xp, level: r.level }]));

    // handy
    const rows = await db
      .select({ handId: schema.handPlayers.handId, userId: schema.handPlayers.userId, kind: schema.handPlayers.kind, at: schema.handPlayers.playedAt, tableId: schema.hands.tableId, wonShowdown: schema.handPlayers.wonShowdown })
      .from(schema.handPlayers)
      .innerJoin(schema.hands, eq(schema.hands.id, schema.handPlayers.handId))
      .orderBy(schema.handPlayers.playedAt);
    const perHand = new Map<string, number>();
    for (const r of rows) perHand.set(r.handId, (perHand.get(r.handId) ?? 0) + 1);
    const sessions = new Map<string, number>();
    let hands = 0;
    for (const r of rows) {
      if ((perHand.get(r.handId) ?? 0) < minPlayers) continue;
      hands++;
      const at = r.at.getTime();
      const day = dayKey(at);
      awards.push({ userId: r.userId, source: 'firstDaily', ref: day, day, amount: num(s, 'xp.firstDaily'), at });
      awards.push({ userId: r.userId, source: 'firstWeekly', ref: weekKey(at), day, amount: num(s, 'xp.firstWeekly'), at });
      awards.push({ userId: r.userId, source: 'hand', ref: day, day, amount: num(s, 'xp.perHand'), at, accumulate: true });
      if (r.wonShowdown) awards.push({ userId: r.userId, source: 'showdownWin', ref: day, day, amount: num(s, 'xp.showdownWin'), at, accumulate: true });
      if (r.kind === 'cash') {
        const key = `${r.userId}|${r.tableId}|${day}`;
        const n = (sessions.get(key) ?? 0) + 1;
        sessions.set(key, n);
        if (n === num(s, 'xp.cashSessionHands')) awards.push({ userId: r.userId, source: 'cashSession', ref: `${r.tableId}:${day}`, day, amount: num(s, 'xp.cashSession'), at });
      }
    }

    // turnaje
    const GR = schema.gameResults;
    const trs = await db.select().from(GR).where(eq(GR.kind, 'tournament'));
    const series = new Map((await db.select({ id: schema.tournaments.id, sched: schema.tournaments.sched }).from(schema.tournaments)).map((t) => [t.id, (t.sched as { seriesId?: string | null } | null)?.seriesId ?? null]));
    const byRef = new Map<string, typeof trs>();
    for (const r of trs) (byRef.get(r.ref) ?? byRef.set(r.ref, []).get(r.ref)!).push(r);
    for (const [ref, rs] of byRef) {
      if (rs.length < minPlayers) continue;
      const at = rs[0]!.finishedAt.getTime();
      const day = dayKey(at);
      for (const r of rs) {
        awards.push({ userId: r.userId, source: 'firstDaily', ref: day, day, amount: num(s, 'xp.firstDaily'), at });
        awards.push({ userId: r.userId, source: 'firstWeekly', ref: weekKey(at), day, amount: num(s, 'xp.firstWeekly'), at });
        awards.push({ userId: r.userId, source: 'tournamentPlayed', ref, day, amount: num(s, 'xp.tournamentPlayed'), at });
        awards.push({ userId: r.userId, source: 'placement', ref, day, amount: num(s, 'xp.placementPerBeaten') * Math.max(0, rs.length - r.place), at });
        if (r.payout > 0) awards.push({ userId: r.userId, source: 'itm', ref, day, amount: num(s, 'xp.itm'), at });
        if (r.place === 1) awards.push({ userId: r.userId, source: 'tournamentWin', ref, day, amount: num(s, 'xp.tournamentWin'), at });
        const sid = series.get(ref);
        if (sid) awards.push({ userId: r.userId, source: 'series', ref: sid, day, amount: num(s, 'xp.series'), at });
      }
    }
    // živý cash
    const lcs = await db.select().from(GR).where(eq(GR.kind, 'live_cash'));
    const lcByRef = new Map<string, typeof lcs>();
    for (const r of lcs) (lcByRef.get(r.ref) ?? lcByRef.set(r.ref, []).get(r.ref)!).push(r);
    for (const [ref, rs] of lcByRef) {
      if (rs.length < minPlayers) continue;
      const at = rs[0]!.finishedAt.getTime();
      const day = dayKey(at);
      for (const r of rs) {
        awards.push({ userId: r.userId, source: 'firstDaily', ref: day, day, amount: num(s, 'xp.firstDaily'), at });
        awards.push({ userId: r.userId, source: 'firstWeekly', ref: weekKey(at), day, amount: num(s, 'xp.firstWeekly'), at });
        awards.push({ userId: r.userId, source: 'cashSession', ref: `live:${ref}`, day, amount: num(s, 'xp.cashSession'), at });
      }
    }
    for (const e of await db.select().from(schema.tournamentEliminations)) {
      const at = e.at.getTime();
      for (const k of e.killers) if (k.userId !== e.victimId) awards.push({ userId: k.userId, source: 'knockout', ref: `${e.tournamentId}:${e.victimId}`, day: dayKey(at), amount: num(s, 'xp.knockout'), at });
    }

    // chronologicky, s denním stropem; zápis je jedinečný podle (hráč, zdroj, odkaz)
    awards.sort((a, b) => a.at - b.at);
    const cap = num(s, 'xp.dailyCap');
    const dayTotals = new Map<string, number>();
    const merged = new Map<string, Award>();
    const known = new Set((await db.select({ id: schema.users.id }).from(schema.users)).map((u) => u.id));
    const achievementDay = new Map<string, number>();
    for (const r of await db.select().from(schema.xpEvents).where(eq(schema.xpEvents.source, 'achievement'))) {
      achievementDay.set(r.userId, (achievementDay.get(r.userId) ?? 0) + r.amount);
    }
    for (const a of awards) {
      if (!known.has(a.userId) || a.amount <= 0) continue;
      const key = `${a.userId}|${a.source}|${a.ref}`;
      if (!a.accumulate && merged.has(key)) continue;
      let give = a.amount;
      if (cap > 0) {
        const dk = `${a.userId}|${a.day}`;
        give = Math.max(0, Math.min(a.amount, cap - (dayTotals.get(dk) ?? 0)));
        if (give <= 0) continue;
        dayTotals.set(dk, (dayTotals.get(dk) ?? 0) + give);
      }
      const cur = merged.get(key);
      if (cur) cur.amount += give;
      else merged.set(key, { ...a, amount: give });
    }

    await db.delete(schema.xpEvents).where(ne(schema.xpEvents.source, 'achievement'));
    const list = [...merged.values()];
    for (let i = 0; i < list.length; i += 500) {
      await db.insert(schema.xpEvents).values(list.slice(i, i + 500).map((a) => ({ userId: a.userId, source: a.source, ref: a.ref, day: a.day, amount: a.amount, createdAt: new Date(a.at) })));
    }
    // součty a levely ze všech zápisů (odměny za úspěchy zůstaly)
    const totals = await db.select({ userId: schema.xpEvents.userId, xp: sql<string>`sum(${schema.xpEvents.amount})` }).from(schema.xpEvents).groupBy(schema.xpEvents.userId);
    const curve = this.curve();
    const after = new Map(totals.map((t) => [t.userId, Number(t.xp)]));
    for (const id of before.keys()) if (!after.has(id)) after.set(id, 0);
    for (const [userId, xp] of after) {
      const level = levelFor(xp, curve).level;
      await db.insert(schema.playerProgress).values({ userId, xp, level, updatedAt: new Date(this.deps.now()) }).onConflictDoUpdate({ target: schema.playerProgress.userId, set: { xp, level, updatedAt: new Date(this.deps.now()) } });
    }
    const diffs = [...after].filter(([id, xp]) => (before.get(id)?.xp ?? 0) !== xp).sort((a, b) => Math.abs(b[1] - (before.get(b[0])?.xp ?? 0)) - Math.abs(a[1] - (before.get(a[0])?.xp ?? 0)));
    const ids = diffs.slice(0, 50).map(([id]) => id);
    const nicks = new Map(ids.length ? (await db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, ids))).map((u) => [u.id, u.n]) : []);
    return {
      changed: diffs.length,
      hands,
      tournaments: byRef.size,
      rows: diffs.slice(0, 50).map(([id, xp]) => ({ nickname: nicks.get(id) ?? '?', before: before.get(id)?.xp ?? 0, after: xp, levelBefore: before.get(id)?.level ?? 1, levelAfter: levelFor(xp, curve).level })),
    };
  }

  // ---------- čtení ----------

  async progressOf(userId: string): Promise<ProgressDto> {
    const [p] = await this.deps.db.select().from(schema.playerProgress).where(eq(schema.playerProgress.userId, userId));
    const xp = p?.xp ?? 0;
    const info = levelFor(xp, this.curve());
    return { userId, xp, level: info.level, into: info.into, need: info.need, rank: rankFor(info.level, String(this.s['xp.ranks'])) };
  }

  /** Hodnost a level více hráčů najednou (pro stůl a chat). */
  async brief(userIds: string[]): Promise<BriefDto[]> {
    const ids = [...new Set(userIds)].slice(0, 100);
    if (ids.length === 0) return [];
    const rows = await this.deps.db.select().from(schema.playerProgress).where(inArray(schema.playerProgress.userId, ids));
    const ranks = String(this.s['xp.ranks']);
    return ids.map((id) => {
      const level = rows.find((r) => r.userId === id)?.level ?? 1;
      const r = rankFor(level, ranks);
      return { userId: id, level, rank: { name: r.name, icon: r.icon, color: r.color } };
    });
  }

  async recent(userId: string, limit = 15): Promise<{ source: string; amount: number; day: string; ref: string }[]> {
    return this.deps.db
      .select({ source: schema.xpEvents.source, amount: schema.xpEvents.amount, day: schema.xpEvents.day, ref: schema.xpEvents.ref })
      .from(schema.xpEvents)
      .where(eq(schema.xpEvents.userId, userId))
      .orderBy(desc(schema.xpEvents.id))
      .limit(Math.min(limit, 50));
  }

  /** Tabulka levelů podle aktuálního nastavení (náhled v GUI). */
  table(count = 30) {
    const ranks = String(this.s['xp.ranks']);
    return levelTable(count, this.curve()).map((r) => ({ ...r, rank: rankFor(r.level, ranks).name }));
  }
}
