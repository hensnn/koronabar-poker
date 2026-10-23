import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Clock } from '@kb/game-core';
import { DEFAULT_TZ, nextOccurrences, validateRule, ScheduleError, type ScheduleRule } from '@kb/shared';
import type { PermissionChecker } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';
import { TournamentError } from '@kb/game-core';
import type { SchedMeta, TournamentManager, TournamentNotice } from './tournaments.js';

export interface ScheduleRow {
  id: string;
  name: string;
  ownerId: string | null;
  templateId: string;
  settings: Record<string, unknown>;
  rule: ScheduleRule;
  timezone: string;
  enabled: boolean;
  seriesId: string | null;
}

export interface SchedulerDeps {
  db: Db;
  clock: Clock;
  tournaments: TournamentManager;
  perms: PermissionChecker;
  audit?: AuditService;
  /** Upozornění: konkrétním hráčům, nebo všem aktivním uživatelům. */
  notify?: (to: string[] | 'all', notice: TournamentNotice) => void;
  /** Jak daleko dopředu se vytvářejí turnaje z opakovaných plánů. */
  horizonDays?: number;
  /** Jak často plánovač kontroluje čas (ms). */
  tickMs?: number;
  onError?: (e: unknown) => void;
  /** Pravidelná úloha mimo turnaje (např. roční souhrny); volá se při každém tiku, sama si hlídá frekvenci. */
  periodic?: () => Promise<void>;
}

const MIN = 60_000;
const DAY = 86_400_000;

const parseReminders = (text: unknown): number[] =>
  String(text ?? '')
    .split(/[\s,;]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a);

/**
 * Plánovač turnajů. Veškerý stav je v DB (plány i plán každého turnaje), takže po restartu serveru stačí
 * znovu tikat: co se mezitím mělo stát (otevření registrace, start), se při dalším tiku dožene.
 * Hodiny jsou vyměnitelné, takže testy mohou čas posunout.
 */
export class Scheduler {
  private timer: (() => void) | null = null;
  private running = false;
  private busy: Promise<void> | null = null;
  /** Turnaje bez plánu, které pojistka pozastavila (aby ruční pauzu nerušila). */
  private localAutoPaused = new Set<string>();

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.timer = this.deps.clock.setTimeout(() => {
        void this.tick()
          .catch((e) => this.deps.onError?.(e))
          .finally(loop);
      }, this.deps.tickMs ?? 5000);
    };
    loop();
  }

  stop(): void {
    this.running = false;
    this.timer?.();
    this.timer = null;
  }

  /** Počká na dokončení právě běžícího tiku (testy, vypnutí serveru). */
  async idle(): Promise<void> {
    await this.busy;
  }

  // ---------- správa plánů ----------

  private toRow(r: typeof schema.schedules.$inferSelect): ScheduleRow {
    return { id: r.id, name: r.name, ownerId: r.ownerId, templateId: r.templateId, settings: r.settings ?? {}, rule: r.rule as ScheduleRule, timezone: r.timezone, enabled: r.enabled, seriesId: r.seriesId };
  }

  async list(): Promise<ScheduleRow[]> {
    return (await this.deps.db.select().from(schema.schedules)).map((r) => this.toRow(r));
  }

  async createSchedule(actorId: string, input: { name: string; templateId: string; settings?: Record<string, unknown>; rule: ScheduleRule; timezone?: string; seriesId?: string | null }): Promise<{ id: string }> {
    if (!this.deps.perms.can(actorId, 'turnaj.naplanovat').allowed) throw new TournamentError('FORBIDDEN');
    const name = input.name?.trim() ?? '';
    if (name.length < 2 || name.length > 60) throw new TournamentError('INVALID', { field: 'name' });
    try {
      validateRule(input.rule);
    } catch (e) {
      if (e instanceof ScheduleError) throw new TournamentError('INVALID', { field: 'rule', code: e.code });
      throw e;
    }
    const id = `plan-${randomBytes(4).toString('hex')}`;
    await this.deps.db.insert(schema.schedules).values({ id, name, ownerId: actorId, templateId: input.templateId, settings: input.settings ?? {}, rule: input.rule, timezone: input.timezone ?? DEFAULT_TZ, seriesId: input.seriesId ?? null });
    await this.deps.audit?.log({ actorId, action: 'plan.vytvorit', targetType: 'schedule', targetId: id, after: { name, rule: input.rule } });
    // Nejbližší výskyty vzniknou hned, ne až při příštím tiku.
    await this.tick();
    return { id };
  }

  async setEnabled(actorId: string, id: string, enabled: boolean): Promise<void> {
    const [row] = await this.deps.db.select().from(schema.schedules).where(eq(schema.schedules.id, id));
    if (!row) throw new TournamentError('NOT_FOUND');
    if (row.ownerId !== actorId && !this.deps.perms.can(actorId, 'turnaj.upravit_vse').allowed) throw new TournamentError('FORBIDDEN');
    await this.deps.db.update(schema.schedules).set({ enabled }).where(eq(schema.schedules.id, id));
    await this.deps.audit?.log({ actorId, action: enabled ? 'plan.zapnout' : 'plan.vypnout', targetType: 'schedule', targetId: id });
  }

  async deleteSchedule(actorId: string, id: string): Promise<void> {
    const [row] = await this.deps.db.select().from(schema.schedules).where(eq(schema.schedules.id, id));
    if (!row) throw new TournamentError('NOT_FOUND');
    if (row.ownerId !== actorId && !this.deps.perms.can(actorId, 'turnaj.zrusit_vse').allowed) throw new TournamentError('FORBIDDEN');
    await this.deps.db.delete(schema.schedules).where(eq(schema.schedules.id, id));
    await this.deps.audit?.log({ actorId, action: 'plan.smazat', targetType: 'schedule', targetId: id });
  }

  // ---------- tik ----------

  /** Jeden průchod: nové výskyty, otevření registrace, upozornění, starty, pojistky. Tiky se nepřekrývají. */
  async tick(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.run().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async run(): Promise<void> {
    await this.deps.periodic?.().catch((e) => this.deps.onError?.(e));
    await this.generate();
    const now = this.deps.clock.now();
    for (const t of this.deps.tournaments.scheduled()) {
      try {
        await this.advance(t.id, t.sched, t.status, now);
      } catch (e) {
        this.deps.onError?.(e);
      }
    }
    // Pojistka „automatická pauza“ platí i pro ručně založené (neplánované) turnaje.
    const planned = new Set(this.deps.tournaments.scheduled().map((x) => x.id));
    for (const r of this.deps.tournaments.list()) {
      if (planned.has(r.id)) continue;
      try {
        if (this.deps.tournaments.get(r.id)?.state().status === 'running') {
          await this.watchPause(r.id, this.localAutoPaused.has(r.id), async (v) => {
            if (v) this.localAutoPaused.add(r.id);
            else this.localAutoPaused.delete(r.id);
          });
        } else this.localAutoPaused.delete(r.id);
      } catch (e) {
        this.deps.onError?.(e);
      }
    }
  }

  /** Z opakovaných plánů vytvoří turnaje na nejbližší dny dopředu (každý výskyt jen jednou, i po zrušení). */
  private async generate(): Promise<void> {
    const now = this.deps.clock.now();
    const horizon = now + (this.deps.horizonDays ?? 7) * DAY;
    const plans = (await this.list()).filter((p) => p.enabled);
    if (plans.length === 0) return;
    const rows = await this.deps.db.select({ sched: schema.tournaments.sched }).from(schema.tournaments);
    const done = new Set(rows.flatMap((r) => ((r.sched as SchedMeta | null)?.scheduleId ? [`${(r.sched as SchedMeta).scheduleId}:${(r.sched as SchedMeta).occurrence}`] : [])));
    for (const plan of plans) {
      let occurrences: number[] = [];
      try {
        occurrences = nextOccurrences(plan.rule, now - 1, 20, plan.timezone).filter((o) => o <= horizon);
      } catch (e) {
        this.deps.onError?.(e);
        continue;
      }
      for (const at of occurrences) {
        if (done.has(`${plan.id}:${at}`)) continue;
        await this.deps.tournaments.scheduleTournament(null, { name: plan.name, templateId: plan.templateId, settings: plan.settings, startAt: at, scheduleId: plan.id, seriesId: plan.seriesId, occurrence: at, ownerId: plan.ownerId });
        done.add(`${plan.id}:${at}`);
      }
    }
  }

  private async advance(id: string, sched: SchedMeta, status: string, now: number): Promise<void> {
    const m = this.deps.tournaments;
    const s = m.settingsOf(id);
    if (!s) return;
    const name = m.row(id)?.name ?? id;
    const notice = (kind: TournamentNotice['kind'], extra: Partial<TournamentNotice> = {}): TournamentNotice => ({ kind, tournamentId: id, name, startAt: sched.startAt, ...extra });

    if (status === 'registering') {
      // Otevření registrace (oznámí se všem).
      if (!sched.openedNotified && now >= sched.opensAt) {
        await m.patchSched(id, { openedNotified: true });
        this.deps.notify?.('all', notice('registrationOpened'));
      }
      // Připomenutí těm, kdo jsou přihlášení.
      const reminders = parseReminders(s['tournament.reminders']);
      const due = reminders.filter((min) => !sched.reminded.includes(min) && now >= sched.startAt - min * MIN && now < sched.startAt);
      if (due.length > 0) {
        const smallest = Math.min(...due);
        // Starší připomenutí, jejichž čas už dávno minul (turnaj vznikl pozdě), se přeskočí.
        await m.patchSched(id, { reminded: [...new Set([...sched.reminded, ...reminders.filter((x) => x >= smallest)])] });
        const users = m.registeredUsers(id);
        if (users.length > 0 && sched.startAt - smallest * MIN >= sched.opensAt) this.deps.notify?.(users, notice('reminder', { minutes: smallest }));
      }
      if (now >= sched.startAt) await this.startOrResolve(id, sched, s, now, notice);
      return;
    }

    if (status === 'running') await this.watchPause(id, sched.autoPaused, (v) => this.deps.tournaments.patchSched(id, { autoPaused: v }));
  }

  /** V čase startu: dost hráčů = start; jinak podle nastavení zrušit, odložit, nebo začít s menším počtem. */
  private async startOrResolve(id: string, sched: SchedMeta, s: Record<string, unknown>, now: number, notice: (k: TournamentNotice['kind'], x?: Partial<TournamentNotice>) => TournamentNotice): Promise<void> {
    const m = this.deps.tournaments;
    const tour = m.get(id)!;
    const players = tour.state().players.length;
    const min = Number(s['tournament.minPlayers']);
    const users = m.registeredUsers(id);
    if (players >= min) {
      m.startSystem(id);
      await this.deps.audit?.log({ action: 'turnaj.automaticky_start', targetType: 'tournament', targetId: id, after: { players } });
      this.deps.notify?.(users, notice('started'));
      return;
    }
    const action = String(s['tournament.minPlayersAction']);
    if (action === 'startAnyway' && players >= 2) {
      m.startSystem(id, true);
      this.deps.notify?.(users, notice('started'));
      return;
    }
    if (action === 'postpone' && sched.postponed < Number(s['tournament.postponeMax'])) {
      const startAt = sched.startAt + Number(s['tournament.postponeMinutes']) * MIN;
      const reminders = parseReminders(s['tournament.reminders']);
      await m.patchSched(id, { startAt, postponed: sched.postponed + 1, reminded: reminders.filter((x) => x * MIN > startAt - now) });
      this.deps.notify?.(users, notice('postponed', { minutes: Number(s['tournament.postponeMinutes']) }));
      await this.deps.audit?.log({ action: 'turnaj.odlozeni', targetType: 'tournament', targetId: id, after: { startAt } });
      return;
    }
    m.cancelSystem(id);
    await this.deps.audit?.log({ action: 'turnaj.zruseni_nedostatek_hracu', targetType: 'tournament', targetId: id, after: { players, min } });
    this.deps.notify?.(users, notice('cancelled', { reason: 'minPlayers' }));
  }

  /** Pojistka bez admina: málo připojených hráčů = pauza, po návratu pokračování (jen když pauzu způsobila pojistka). */
  private async watchPause(id: string, autoPaused: boolean, mark: (v: boolean) => Promise<void>): Promise<void> {
    const s = this.deps.tournaments.settingsOf(id);
    if (!s) return;
    const threshold = Number(s['tournament.autoPauseBelow']);
    // Živá hra nemá online stoly, takže „připojení hráči“ nedávají smysl.
    if (threshold <= 0 || s['tournament.live']) return;
    const tour = this.deps.tournaments.get(id)!;
    const st = tour.state();
    const alive = st.players.filter((p) => p.status === 'playing').length;
    const need = Math.min(threshold, alive);
    const connected = this.deps.tournaments.connectedPlayers(id);
    if (!st.paused && connected < need) {
      this.deps.tournaments.pauseSystem(id, false);
      await mark(true);
    } else if (st.paused && autoPaused && connected >= need) {
      this.deps.tournaments.pauseSystem(id, true);
      await mark(false);
    }
  }
}
