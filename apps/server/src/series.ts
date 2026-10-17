import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { TournamentError } from '@kb/game-core';
import { DEFAULT_SERIES, seriesStandings, validateSeriesConfig, type PermissionChecker, type SeriesConfig, type SeriesRow, type SeriesTournament } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';
import type { SchedMeta, TournamentManager } from './tournaments.js';
import type { TournamentState } from '@kb/game-core';

export interface SeriesView {
  id: string;
  name: string;
  ownerId: string | null;
  config: SeriesConfig;
  tournaments: { id: string; name: string; startAt: number | null; status: string; players: number }[];
  standings: (SeriesRow & { name: string })[];
  /** Hráči, kteří by podle žebříčku postoupili do finále. */
  finalists: string[];
  finalId: string | null;
}

/** Série a ligy: bodování z odehraných turnajů a finále pro nejlepší hráče. */
export class SeriesService {
  constructor(
    private deps: {
      db: Db;
      perms: PermissionChecker;
      audit?: AuditService;
      tournaments: TournamentManager;
    },
  ) {}

  private can(userId: string) {
    return this.deps.perms.can(userId, 'turnaj.naplanovat').allowed;
  }

  async create(actorId: string, input: { name: string; config?: Partial<SeriesConfig> }): Promise<{ id: string }> {
    if (!this.can(actorId)) throw new TournamentError('FORBIDDEN');
    const name = input.name?.trim() ?? '';
    if (name.length < 2 || name.length > 60) throw new TournamentError('INVALID', { field: 'name' });
    const config: SeriesConfig = { ...DEFAULT_SERIES, ...input.config };
    const bad = validateSeriesConfig(config);
    if (bad) throw new TournamentError('INVALID', { field: bad });
    const id = `serie-${randomBytes(4).toString('hex')}`;
    await this.deps.db.insert(schema.series).values({ id, name, ownerId: actorId, config });
    await this.deps.audit?.log({ actorId, action: 'serie.vytvorit', targetType: 'series', targetId: id, after: { name, config } });
    return { id };
  }

  async update(actorId: string, id: string, patch: { name?: string; config?: Partial<SeriesConfig> }): Promise<void> {
    const [row] = await this.deps.db.select().from(schema.series).where(eq(schema.series.id, id));
    if (!row) throw new TournamentError('NOT_FOUND');
    if (row.ownerId !== actorId && !this.deps.perms.can(actorId, 'turnaj.upravit_vse').allowed) throw new TournamentError('FORBIDDEN');
    const config: SeriesConfig = { ...(row.config as SeriesConfig), ...patch.config };
    const bad = validateSeriesConfig(config);
    if (bad) throw new TournamentError('INVALID', { field: bad });
    await this.deps.db.update(schema.series).set({ name: patch.name?.trim() || row.name, config }).where(eq(schema.series.id, id));
    await this.deps.audit?.log({ actorId, action: 'serie.upravit', targetType: 'series', targetId: id, after: { name: patch.name, config } });
  }

  async remove(actorId: string, id: string): Promise<void> {
    const [row] = await this.deps.db.select().from(schema.series).where(eq(schema.series.id, id));
    if (!row) throw new TournamentError('NOT_FOUND');
    if (row.ownerId !== actorId && !this.deps.perms.can(actorId, 'turnaj.zrusit_vse').allowed) throw new TournamentError('FORBIDDEN');
    await this.deps.db.delete(schema.series).where(eq(schema.series.id, id));
    await this.deps.audit?.log({ actorId, action: 'serie.smazat', targetType: 'series', targetId: id });
  }

  /** Turnaje série (z DB, včetně dohraných) s jejich výsledky. */
  private async members(id: string) {
    const rows = await this.deps.db.select().from(schema.tournaments);
    return rows
      .map((r) => ({ r, sched: r.sched as SchedMeta | null, state: r.state as TournamentState | null }))
      .filter((x) => x.sched?.seriesId === id);
  }

  async view(id: string): Promise<SeriesView> {
    const [row] = await this.deps.db.select().from(schema.series).where(eq(schema.series.id, id));
    if (!row) throw new TournamentError('NOT_FOUND');
    const config = row.config as SeriesConfig;
    const members = await this.members(id);
    const done: SeriesTournament[] = members
      .filter((m) => m.state?.status === 'finished' && m.state.results && !m.sched?.invited)
      .map((m) => ({ id: m.r.id, name: m.r.name, finishedAt: m.state!.finishedAt ?? 0, results: m.state!.results!.map((x) => ({ userId: x.userId, place: x.place })) }));
    const standings = seriesStandings(config, done);
    const users = await this.deps.db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users);
    const nick = new Map(users.map((u) => [u.id, u.nickname]));
    const final = members.find((m) => m.sched?.invited);
    return {
      id,
      name: row.name,
      ownerId: row.ownerId,
      config,
      tournaments: members
        .filter((m) => !m.sched?.invited)
        .map((m) => ({ id: m.r.id, name: m.r.name, startAt: m.sched?.startAt ?? null, status: m.state?.status ?? m.r.status, players: m.state?.players.length ?? 0 }))
        .sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0)),
      standings: standings.map((s) => ({ ...s, name: nick.get(s.userId) ?? '' })),
      finalists: config.finalTopN > 0 ? standings.slice(0, config.finalTopN).map((s) => s.userId) : [],
      finalId: final?.r.id ?? null,
    };
  }

  async list(): Promise<{ id: string; name: string; config: SeriesConfig }[]> {
    return (await this.deps.db.select().from(schema.series)).map((r) => ({ id: r.id, name: r.name, config: r.config as SeriesConfig }));
  }

  /** Finálový turnaj série: přihlásit se smějí jen nejlepší hráči žebříčku. */
  async createFinal(actorId: string, id: string, input: { templateId: string; settings?: Record<string, unknown>; startAt: number }): Promise<{ id: string }> {
    const view = await this.view(id);
    if (view.ownerId !== actorId && !this.deps.perms.can(actorId, 'turnaj.upravit_vse').allowed) throw new TournamentError('FORBIDDEN');
    if (view.config.finalTopN <= 0) throw new TournamentError('INVALID', { field: 'finalTopN' });
    if (view.finalId) throw new TournamentError('STATE', { reason: 'finalExists' });
    if (view.finalists.length < 2) throw new TournamentError('NOT_ENOUGH_PLAYERS');
    return this.deps.tournaments.scheduleTournament(actorId, { name: `${view.name}: finále`, templateId: input.templateId, settings: input.settings, startAt: input.startAt, seriesId: id, invited: view.finalists });
  }
}
