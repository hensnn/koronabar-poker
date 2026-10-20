import { and, eq, gte, sql } from 'drizzle-orm';
import { BUILTIN_ACHIEVEMENTS, handRankAtLeast, longestStreak, validateCondition, type Condition, type PermissionChecker } from '@kb/shared';
import { schema, type Db } from './db/index.js';
import type { ProgressService } from './progress.js';

export type Trigger = 'hand' | 'tournament' | 'level';

const TRIGGER_OF: Record<string, Trigger> = {
  handsPlayed: 'hand',
  showdownWins: 'hand',
  handRank: 'hand',
  longshotWin: 'hand',
  biggestPot: 'hand',
  streakDays: 'hand',
  tournamentsPlayed: 'tournament',
  tournamentWins: 'tournament',
  knockouts: 'tournament',
  knockoutsInSeries: 'tournament',
  seriesParticipation: 'tournament',
  level: 'level',
};

export class AchievementError extends Error {
  constructor(
    public code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'KEY_TAKEN' | 'BUILTIN',
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export interface AchievementDto {
  key: string;
  name: string;
  icon: string;
  description: string;
  condition: Condition;
  xp: number;
  builtin: boolean;
  enabled: boolean;
  earned: boolean;
  earnedAt: number | null;
  holders?: number;
}

export interface AchievementInput {
  key?: string;
  name?: string;
  icon?: string;
  description?: string;
  xp?: number;
  enabled?: boolean;
  condition?: unknown;
}

/**
 * Úspěchy (odznaky). Podmínky se vyhodnocují po hře, po turnaji a po postupu na level; udělení je
 * jednorázové (hráč + úspěch) a odměna jde přes zápis XP, takže se nikdy nezdvojí.
 */
export class AchievementService {
  constructor(
    private deps: {
      db: Db;
      perms: PermissionChecker;
      progress: ProgressService;
      onEarned?: (userId: string, a: { key: string; name: string; icon: string; xp: number }) => void;
      /** Úspěchy se vyhodnocují jen při zapnutých zkušenostech (XP); bez toho se nic neodemyká ani neoznamuje. */
      enabled?: () => boolean;
      onError?: (e: unknown) => void;
      /** Jak dlouho se události slučují před vyhodnocením (ms). */
      debounceMs?: number;
    },
  ) {}

  /** Doplní vestavěné úspěchy, které v databázi ještě nejsou (upravené hodnoty správce zůstanou). */
  async init(): Promise<void> {
    const have = new Set((await this.deps.db.select({ k: schema.achievements.key }).from(schema.achievements)).map((r) => r.k));
    for (const a of BUILTIN_ACHIEVEMENTS) {
      if (have.has(a.key)) continue;
      await this.deps.db.insert(schema.achievements).values({ key: a.key, name: a.name, icon: a.icon, description: a.description, condition: a.condition, xp: a.xp, builtin: true }).onConflictDoNothing();
    }
  }

  private manage(actorId: string): void {
    if (!this.deps.perms.can(actorId, 'statistiky.uspechy').allowed) throw new AchievementError('FORBIDDEN');
  }

  // ---------- čtení ----------

  async list(userId: string, opts: { all?: boolean } = {}): Promise<AchievementDto[]> {
    const defs = await this.deps.db.select().from(schema.achievements);
    const mine = await this.deps.db.select().from(schema.playerAchievements).where(eq(schema.playerAchievements.userId, userId));
    const holders = opts.all
      ? await this.deps.db.select({ key: schema.playerAchievements.key, n: sql<number>`count(*)::int` }).from(schema.playerAchievements).groupBy(schema.playerAchievements.key)
      : [];
    return defs
      .filter((d) => opts.all || d.enabled)
      .map((d) => {
        const m = mine.find((x) => x.key === d.key);
        return {
          key: d.key,
          name: d.name,
          icon: d.icon,
          description: d.description,
          condition: d.condition as Condition,
          xp: d.xp,
          builtin: d.builtin,
          enabled: d.enabled,
          earned: !!m,
          earnedAt: m?.earnedAt.getTime() ?? null,
          ...(opts.all ? { holders: holders.find((h) => h.key === d.key)?.n ?? 0 } : {}),
        };
      })
      .sort((a, b) => Number(b.earned) - Number(a.earned) || a.xp - b.xp || a.name.localeCompare(b.name, 'cs'));
  }

  // ---------- správa ----------

  private clean(input: AchievementInput, creating: boolean): { name?: string; icon?: string; description?: string; xp?: number; enabled?: boolean; condition?: Condition } {
    const out: ReturnType<AchievementService['clean']> = {};
    if (input.name !== undefined || creating) {
      const n = (input.name ?? '').trim();
      if (!n || n.length > 40) throw new AchievementError('INVALID', { field: 'name' });
      out.name = n;
    }
    if (input.icon !== undefined || creating) {
      const i = (input.icon ?? '').trim();
      if (!i || i.length > 8) throw new AchievementError('INVALID', { field: 'icon' });
      out.icon = i;
    }
    if (input.description !== undefined || creating) {
      const d = (input.description ?? '').trim();
      if (d.length > 200) throw new AchievementError('INVALID', { field: 'description' });
      out.description = d;
    }
    if (input.xp !== undefined || creating) {
      const xp = Number(input.xp ?? 0);
      if (!Number.isInteger(xp) || xp < 0 || xp > 10_000) throw new AchievementError('INVALID', { field: 'xp' });
      out.xp = xp;
    }
    if (input.enabled !== undefined) out.enabled = !!input.enabled;
    if (input.condition !== undefined || creating) {
      const v = validateCondition(input.condition);
      if (!v.ok) throw new AchievementError('INVALID', { field: v.field });
      out.condition = v.condition;
    }
    return out;
  }

  async create(actorId: string, input: AchievementInput): Promise<string> {
    this.manage(actorId);
    const key = (input.key ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_]{2,30}$/.test(key)) throw new AchievementError('INVALID', { field: 'key' });
    const c = this.clean(input, true);
    const [taken] = await this.deps.db.select({ k: schema.achievements.key }).from(schema.achievements).where(eq(schema.achievements.key, key));
    if (taken) throw new AchievementError('KEY_TAKEN');
    await this.deps.db.insert(schema.achievements).values({ key, name: c.name!, icon: c.icon!, description: c.description ?? '', condition: c.condition!, xp: c.xp ?? 0, enabled: c.enabled ?? true, builtin: false });
    this.evaluateEveryone();
    return key;
  }

  async update(actorId: string, key: string, input: AchievementInput): Promise<void> {
    this.manage(actorId);
    const [cur] = await this.deps.db.select().from(schema.achievements).where(eq(schema.achievements.key, key));
    if (!cur) throw new AchievementError('NOT_FOUND');
    const c = this.clean(cur.builtin ? { ...input, condition: undefined } : input, false);
    if (Object.keys(c).length === 0) return;
    await this.deps.db.update(schema.achievements).set(c).where(eq(schema.achievements.key, key));
    if (c.condition || c.enabled) this.evaluateEveryone();
  }

  async remove(actorId: string, key: string): Promise<void> {
    this.manage(actorId);
    const [cur] = await this.deps.db.select().from(schema.achievements).where(eq(schema.achievements.key, key));
    if (!cur) throw new AchievementError('NOT_FOUND');
    if (cur.builtin) throw new AchievementError('BUILTIN');
    await this.deps.db.delete(schema.achievements).where(eq(schema.achievements.key, key));
  }

  // ---------- vyhodnocení ----------

  private queue: Promise<unknown> = Promise.resolve();

  async idle(): Promise<void> {
    this.flush();
    await this.queue;
  }

  /** Po změně katalogu zkontroluje všechny hráče se zápisem postupu. */
  private evaluateEveryone(): void {
    this.queue = this.queue
      .then(async () => {
        const ids = await this.deps.db.select({ id: schema.playerProgress.userId }).from(schema.playerProgress);
        for (const u of ids) await this.evaluate([u.id], ['hand', 'tournament', 'level']);
      })
      .catch((e) => this.deps.onError?.(e));
  }

  private waiting = new Map<Trigger, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Naplánuje vyhodnocení po události. Události se na pár vteřin slučují, aby se při rychlé hře
   * nevyhodnocovalo po každé handě (dotazy do historie jsou dražší než samotná hra).
   */
  trigger(userIds: string[], triggers: Trigger[]): void {
    if (this.deps.enabled && !this.deps.enabled()) return;
    for (const t of triggers) {
      const set = this.waiting.get(t) ?? new Set<string>();
      for (const u of userIds) set.add(u);
      this.waiting.set(t, set);
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.deps.debounceMs ?? 3000);
      this.timer.unref?.();
    }
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = [...this.waiting.entries()];
    this.waiting.clear();
    for (const [trigger, users] of batch) this.queue = this.queue.then(() => this.evaluate([...users], [trigger])).catch((e) => this.deps.onError?.(e));
  }

  /** Zastaví odložené vyhodnocení (vypnutí serveru). */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.waiting.clear();
  }

  async evaluate(userIds: string[], triggers: Trigger[]): Promise<void> {
    const defs = (await this.deps.db.select().from(schema.achievements).where(eq(schema.achievements.enabled, true))).filter((d) => triggers.includes(TRIGGER_OF[(d.condition as Condition).type] as Trigger));
    if (defs.length === 0) return;
    for (const userId of new Set(userIds)) {
      const have = new Set((await this.deps.db.select({ k: schema.playerAchievements.key }).from(schema.playerAchievements).where(eq(schema.playerAchievements.userId, userId))).map((r) => r.k));
      const metrics = new Metrics(this.deps.db, userId);
      for (const d of defs) {
        if (have.has(d.key)) continue;
        if (!(await metrics.satisfies(d.condition as Condition))) continue;
        const inserted = await this.deps.db.insert(schema.playerAchievements).values({ userId, key: d.key }).onConflictDoNothing().returning({ k: schema.playerAchievements.key });
        if (inserted.length === 0) continue;
        if (d.xp > 0) this.deps.progress.grant(userId, d.key, d.xp);
        this.deps.onEarned?.(userId, { key: d.key, name: d.name, icon: d.icon, xp: d.xp });
      }
    }
  }
}

/** Vypočítá hodnoty pro podmínky jen když jsou potřeba a každou jen jednou. */
class Metrics {
  private cache = new Map<string, number | boolean>();

  constructor(
    private db: Db,
    private userId: string,
  ) {}

  private async memo<T extends number | boolean>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) this.cache.set(key, await fn());
    return this.cache.get(key) as T;
  }

  async satisfies(c: Condition): Promise<boolean> {
    switch (c.type) {
      case 'handsPlayed':
        return (await this.memo('hands', () => this.count(schema.handPlayers, eq(schema.handPlayers.userId, this.userId)))) >= c.value;
      case 'showdownWins':
        return (await this.memo('sdw', () => this.count(schema.handPlayers, and(eq(schema.handPlayers.userId, this.userId), eq(schema.handPlayers.wonShowdown, true))))) >= c.value;
      case 'tournamentsPlayed':
        return (await this.memo('tp', () => this.count(schema.gameResults, and(eq(schema.gameResults.userId, this.userId), eq(schema.gameResults.kind, 'tournament'))))) >= c.value;
      case 'tournamentWins':
        return (await this.memo('tw', () => this.count(schema.gameResults, and(eq(schema.gameResults.userId, this.userId), eq(schema.gameResults.kind, 'tournament'), eq(schema.gameResults.place, 1))))) >= c.value;
      case 'knockouts':
        return (await this.memo('ko', () => this.count(schema.tournamentEliminations, this.killedBy()))) >= c.value;
      case 'knockoutsInSeries':
        return (await this.memo('kos', () => this.bestSeriesKnockouts())) >= c.value;
      case 'seriesParticipation':
        return (await this.memo('sp', () => this.count(schema.xpEvents, and(eq(schema.xpEvents.userId, this.userId), eq(schema.xpEvents.source, 'series'))))) >= c.value;
      case 'streakDays':
        return (await this.memo('streak', () => this.streak())) >= c.value;
      case 'biggestPot':
        return (await this.memo('pot', () => this.biggestPot())) >= c.value;
      case 'handRank':
        return this.handRank(c.rank!);
      case 'longshotWin':
        return (await this.memo(`ls${c.value}`, () => this.count(schema.handPlayers, and(eq(schema.handPlayers.userId, this.userId), gte(schema.handPlayers.won, 1), sql`${schema.handPlayers.allInEquity} < ${c.value / 100}`)))) >= 1;
      case 'level': {
        const [p] = await this.db.select({ level: schema.playerProgress.level }).from(schema.playerProgress).where(eq(schema.playerProgress.userId, this.userId));
        return (p?.level ?? 1) >= c.value;
      }
    }
  }

  private async count(table: typeof schema.handPlayers | typeof schema.gameResults | typeof schema.tournamentEliminations | typeof schema.xpEvents, where: ReturnType<typeof and> | ReturnType<typeof sql>): Promise<number> {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(table as typeof schema.handPlayers).where(where);
    return r?.n ?? 0;
  }

  private killedBy() {
    return sql`${schema.tournamentEliminations.killers} @> ${JSON.stringify([{ userId: this.userId }])}::jsonb`;
  }

  private async bestSeriesKnockouts(): Promise<number> {
    const rows = await this.db
      .select({ sched: schema.tournaments.sched })
      .from(schema.tournamentEliminations)
      .innerJoin(schema.tournaments, eq(schema.tournaments.id, schema.tournamentEliminations.tournamentId))
      .where(this.killedBy());
    const per = new Map<string, number>();
    for (const r of rows) {
      const sid = (r.sched as { seriesId?: string | null } | null)?.seriesId;
      if (sid) per.set(sid, (per.get(sid) ?? 0) + 1);
    }
    return Math.max(0, ...per.values());
  }

  private async streak(): Promise<number> {
    const days = await this.db.select({ d: schema.xpEvents.ref }).from(schema.xpEvents).where(and(eq(schema.xpEvents.userId, this.userId), eq(schema.xpEvents.source, 'firstDaily')));
    return longestStreak(days.map((x) => x.d));
  }

  private async biggestPot(): Promise<number> {
    const [r] = await this.db
      .select({ v: sql<string>`coalesce(max((${schema.handPlayers.won} - ${schema.handPlayers.invested})::numeric / ${schema.hands.chipsPerUnit}), 0)` })
      .from(schema.handPlayers)
      .innerJoin(schema.hands, eq(schema.hands.id, schema.handPlayers.handId))
      .where(and(eq(schema.handPlayers.userId, this.userId), eq(schema.handPlayers.kind, 'cash'), gte(schema.handPlayers.won, 1)));
    return Math.floor(Number(r?.v ?? 0));
  }

  private async handRank(rank: NonNullable<Condition['rank']>): Promise<boolean> {
    const rows = await this.db
      .select({ k: schema.handPlayers.handKey })
      .from(schema.handPlayers)
      .where(and(eq(schema.handPlayers.userId, this.userId), gte(schema.handPlayers.won, 1), sql`${schema.handPlayers.handKey} is not null`));
    return rows.some((r) => handRankAtLeast(r.k, rank));
  }
}
