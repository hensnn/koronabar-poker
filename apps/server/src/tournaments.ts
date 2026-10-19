import { randomBytes } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import { accounts, Ledger, TournamentMoney, type CashService } from '@kb/ledger';
import { poolPart, LiveTable, Tournament, TournamentError, TournamentTableSet, TableActor, type TableSetEvent, type Clock, type PersistedTable, type TableEvent, type TournamentEvent, type TournamentState } from '@kb/game-core';
import {
  decideChange,
  scopeAllowed,
  validateValues,
  t,
  type PermissionChecker,
  type SettingValue,
  type SettingValues,
  type SettingsRegistry,
} from '@kb/shared';
import type { AuditService, AuditSource } from './auth/audit.js';
import type { BetFacts } from './bets.js';
import { schema, type Db } from './db/index.js';
import { Journal, loadTableState, tableStateOp, tournamentStateOp } from './db/journal.js';
import type { SettingsStore } from './settings-store.js';
import type { TemplateService } from './templates.js';
import type { SettingsTemplate } from '@kb/shared';

/** Plánování turnaje: kdy začíná, kdy se otevírá registrace, kolikrát se odložil a co už bylo oznámeno. */
export interface SchedMeta {
  startAt: number;
  opensAt: number;
  /** Původně plánovaný okamžik (nemění se při odložení; slouží k poznání, že výskyt už vznikl). */
  occurrence: number;
  scheduleId: string | null;
  seriesId: string | null;
  postponed: number;
  /** Připomenutí (minuty před startem), která už byla odeslána. */
  reminded: number[];
  openedNotified: boolean;
  autoPaused: boolean;
  /** Finále série: smí se přihlásit jen tito hráči. */
  invited?: string[];
}

interface Row {
  id: string;
  name: string;
  ownerId: string | null;
  templateId: string | null;
  /** Snímek hodnot vlastní šablony při založení (vestavěné se berou z kódu). */
  templateValues?: Record<string, unknown> | null;
  settings: Record<string, unknown>;
  sched: SchedMeta | null;
}

/** Upozornění hráčům (aplikace, e-mail). */
export interface TournamentNotice {
  kind: 'registrationOpened' | 'reminder' | 'postponed' | 'cancelled' | 'started';
  tournamentId: string;
  name: string;
  startAt: number;
  minutes?: number;
  reason?: string;
}

interface Deps {
  db: Db;
  journal: Journal;
  registry: SettingsRegistry;
  settings: SettingsStore;
  templates: TemplateService;
  ledger: Ledger;
  cash: CashService;
  clock: Clock;
  perms: PermissionChecker;
  audit?: AuditService;
  /** Stoly turnajů se přidávají do společné mapy, kterou používá Socket.IO brána. */
  actors: Map<string, TableActor>;
  /** Změna stolu (rozeslání pohledů hráčům). */
  onTableChange: (tableId: string) => void;
  /** Změna turnaje (klienti si načtou nový stav). */
  onChanged?: (id: string) => void;
  /** Událost turnaje pro chat (zahájení, level, přestávka, vyřazení, konec). */
  onEvent?: (id: string, e: TournamentEvent) => void;
  /** Událost turnajového stolu (záznam hand do statistik); nastavení stolu je aktuální nastavení turnaje. */
  onTableEvent?: (tournamentId: string, tableId: string, e: TableEvent, settings: SettingValues) => void;
  /** Součet odměn na hlavu hráče v turnaji (štítek „hledaný“ u stolu). */
  seatWanted?: (tournamentId: string, userId: string) => number;
  /** Ředitel živého turnaje přesadil hráče: upozornění hráči a zpráva do chatu. */
  onLiveMove?: (tournamentId: string, m: { userId: string; name: string; fromNo: number; toNo: number; seat: number }) => void;
  /** Přesazení hráče, zrušení stolu, finálový stůl, hand-for-hand (chat a hlasatel). */
  onSetEvent?: (tournamentId: string, e: SetEventInfo) => void;
  /** Turnaj vznikl nebo se obnovil (např. založení chatového kanálu). */
  onSpawn?: (row: { id: string; name: string }) => void;
  /** Nový naplánovaný turnaj (automatická zpráva do chatu). */
  onScheduled?: (id: string, name: string, startAt: number) => void;
  /** Hráč byl vyplacen nebo mu byla vrácena platba (aktualizace zůstatku v prohlížeči). */
  onWallet?: (userId: string) => void;
  nickOf: (userId: string) => Promise<string>;
  /** Zda je hráč právě připojený (kvůli sit outu neonline hráčů při automatickém startu). */
  isOnline?: (userId: string) => boolean;
  /** Upozornění registrovaným hráčům (plánované turnaje). */
  notify?: (userIds: string[], notice: TournamentNotice) => void;
}

/** Událost stolů turnaje s čísly stolů (stůl turnaje se číslují od 1, zrušené se nepřečíslují). */
export type SetEventInfo =
  | { type: 'moved'; userId: string; name: string; fromNo: number; toNo: number; seat: number }
  | { type: 'tableBroken'; no: number; moved: { userId: string; name: string; toNo: number; seat: number }[] }
  | { type: 'finalTable'; no: number }
  | { type: 'handForHand'; active: boolean };

/** Systémová zpráva do chatu stolu turnaje (null = událost se do chatu nepíše). */
export function tournamentChatText(e: TournamentEvent): string | null {
  switch (e.type) {
    case 'started':
      return t('chat.sys.tStarted');
    case 'level':
      return e.level > 1 ? t('chat.sys.tLevel', { level: e.level, sb: e.smallBlind, bb: e.bigBlind, ante: e.ante }) : null;
    case 'break':
      return t('chat.sys.tBreak', { minutes: e.minutes });
    case 'breakEnd':
      return t('chat.sys.tBreakEnd');
    case 'paused':
      return t('chat.sys.tPaused');
    case 'resumed':
      return t('chat.sys.tResumed');
    case 'eliminated':
      return t('chat.sys.tEliminated', { nick: e.name, remaining: e.remaining });
    case 'finished':
      return t('chat.sys.tFinished', { winner: e.results[0]?.name ?? '' });
    case 'cancelled':
      return t('chat.sys.tCancelled');
    case 'bubble':
      return t('chat.sys.tBubble');
    case 'dealProposed':
      return t('chat.sys.tDealProposed', { method: t(`deal.method.${e.method}`) });
    case 'dealAccepted':
      return t('chat.sys.tDealAccepted', { method: t(`deal.method.${e.method}`) });
    case 'dealRejected':
      return t('chat.sys.tDealRejected');
    case 'knockout':
      return t(e.secret ? 'chat.sys.tKnockoutSecret' : 'chat.sys.tKnockout', { killer: e.by.join(', '), victim: e.victim, amount: e.amount });
  }
}

type Meta = { ip?: string | null; source?: AuditSource; reason?: string | null };

const ACTIVE = ['registering', 'running'];

/**
 * Správa turnajů: záznam v DB, běžící `Tournament` + jeho stůl (`TableActor` v turnajovém režimu)
 * a uložený stav. Peníze (buy-in, rebuy, výplaty) jdou jen přes účetní knihu, žetony jen u stolu.
 */
export class TournamentManager {
  private rows = new Map<string, Row>();
  private tours = new Map<string, Tournament>();
  private sets = new Map<string, TournamentTableSet>();
  private pending = new Map<string, Record<string, SettingValue>>();
  private money: TournamentMoney;

  constructor(private deps: Deps) {
    this.money = new TournamentMoney(deps.ledger);
  }

  private resolve(row: Row): SettingValues {
    const values = (row.templateValues as Record<string, SettingValue> | null | undefined) ?? this.deps.templates.getAny(row.templateId)?.values;
    return this.deps.settings.resolve([
      ...(values ? [{ scope: 'template' as const, values }] : []),
      { scope: 'table', values: row.settings as Record<string, SettingValue> },
    ]);
  }

  private spawn(row: Row, state?: TournamentState, snaps: Map<string, PersistedTable | undefined> = new Map()): Tournament {
    this.rows.set(row.id, row);
    const settings = () => this.resolve(this.rows.get(row.id)!);
    const tour = new Tournament({
      id: row.id,
      settings,
      clock: this.deps.clock,
      money: this.money,
      restore: state,
      persist: (st) => this.deps.journal.push(`tournament:${row.id}`, tournamentStateOp(row.id, st.status, st)),
      onChange: () => {
        this.deps.onChanged?.(row.id);
        this.deps.onTableChange(row.id);
      },
      onEvent: (e) => {
        if (e.type === 'finished' || e.type === 'cancelled') for (const p of tour.state().players) this.deps.onWallet?.(p.userId);
        this.deps.onEvent?.(row.id, e);
      },
    });
    if (settings()['tournament.live']) {
      // Živá hra: žádné stoly s kartami, jen evidence míst. Sada stolů jen radí, přesazení potvrzuje ředitel.
      const liveSet: TournamentTableSet = new TournamentTableSet({
        tournamentId: row.id,
        advisory: true,
        seatsPerTable: () => Number(settings()['table.seats']),
        maxTables: () => Math.max(1, Number(settings()['tournament.maxTables']) || 1),
        balanceMaxDiff: () => Math.max(1, Number(settings()['tournament.balanceMaxDiff']) || 1),
        handForHand: () => false,
        handForHandActive: () => false,
        createTable: () => new LiveTable(),
        destroyTable: () => undefined,
        onTablesChanged: (ids) => tour.recordTables(ids),
        onEvent: (e: TableSetEvent) => {
          if (e.type === 'seated') {
            tour.noteSeat(e.userId, e.tableId, e.seat);
            return;
          }
          if (e.type === 'tableBroken') this.deps.onSetEvent?.(row.id, { type: 'tableBroken', no: this.tableNo(row.id, e.tableId), moved: [] });
          else if (e.type === 'finalTable') this.deps.onSetEvent?.(row.id, { type: 'finalTable', no: this.tableNo(row.id, e.tableId) });
          this.deps.onChanged?.(row.id);
        },
      });
      this.sets.set(row.id, liveSet);
      this.tours.set(row.id, tour);
      if (state?.tableIds?.length) liveSet.restore(state.tableIds);
      else liveSet.init();
      for (const p of state?.players ?? []) {
        if (p.seat === undefined || (p.status !== 'playing' && p.status !== 'deciding')) continue;
        liveSet.get(p.tableId ?? row.id)?.seatTournamentPlayer(p.userId, p.name, p.seat, 1);
      }
      tour.attachTable(liveSet);
      this.deps.onSpawn?.(row);
      return tour;
    }
    // Stoly turnaje (jeden, nebo víc): sadu stolů vlastní turnaj, správce jen zakládá jednotlivé `TableActor`.
    const num = (id: string) => this.tableNo(row.id, id);
    const set: TournamentTableSet = new TournamentTableSet({
      tournamentId: row.id,
      seatsPerTable: () => Number(settings()['table.seats']),
      maxTables: () => Math.max(1, Number(settings()['tournament.maxTables']) || 1),
      balanceMaxDiff: () => Math.max(1, Number(settings()['tournament.balanceMaxDiff']) || 1),
      handForHand: () => !!settings()['tournament.handForHand'],
      handForHandActive: () => tour.handForHandActive(),
      createTable: (tableId) => {
        const table = new TableActor({
          tableId,
          tournament: true,
          tournamentId: row.id,
          settings: () => tour.tableSettings(),
          clock: this.deps.clock,
          cash: this.deps.cash,
          seatBounty: (userId) => tour.headOf(userId),
          seatWanted: (userId) => this.deps.seatWanted?.(row.id, userId) ?? 0,
          persist: (snap) => this.deps.journal.push(`table:${tableId}`, tableStateOp(tableId, snap)),
          onChange: () => this.deps.onTableChange(tableId),
          userPref: (userId, key) => this.deps.settings.layer('user', userId)[key] as string | number | boolean | undefined,
          onEvent: (e: TableEvent) => {
            tour.onTableEvent(e, { lead: set.isLead(tableId) });
            this.deps.onTableEvent?.(row.id, tableId, e, tour.tableSettings());
            if (e.type === 'handEnd') this.applyPending(row.id);
          },
          onBoundary: () => set.onBoundary(tableId),
          restore: snaps.get(tableId),
        });
        this.deps.actors.set(tableId, table);
        return table;
      },
      destroyTable: (tableId) => {
        this.deps.actors.get(tableId)?.stop();
        this.deps.actors.delete(tableId);
        this.deps.onTableChange(tableId);
      },
      onTablesChanged: (ids) => tour.recordTables(ids),
      onEvent: (e: TableSetEvent) => {
        if (e.type === 'seated') {
          tour.noteSeat(e.userId, e.tableId, e.seat);
          return;
        }
        const info: SetEventInfo | null =
          e.type === 'moved'
            ? { type: 'moved', userId: e.userId, name: e.name, fromNo: num(e.fromTable), toNo: num(e.toTable), seat: e.seat + 1 }
            : e.type === 'tableBroken'
              ? { type: 'tableBroken', no: num(e.tableId), moved: e.moved.map((m) => ({ userId: m.userId, name: m.name, toNo: num(m.toTable), seat: m.seat + 1 })) }
              : e.type === 'finalTable'
                ? { type: 'finalTable', no: num(e.tableId) }
                : { type: 'handForHand', active: e.active };
        this.deps.onSetEvent?.(row.id, info);
        this.deps.onChanged?.(row.id);
      },
    });
    this.sets.set(row.id, set);
    this.tours.set(row.id, tour);
    if (state?.tableIds?.length || snaps.size > 0) set.restore(state?.tableIds ?? [row.id]);
    else set.init();
    tour.attachTable(set);
    this.deps.onSpawn?.(row);
    return tour;
  }

  /** Číslo stolu v rámci turnaje: první stůl má id turnaje, další „id~N“. */
  private tableNo(tournamentId: string, tableId: string): number {
    if (tableId === tournamentId) return 1;
    return Number(tableId.slice(tournamentId.length + 1)) || 1;
  }

  /** Všechna id stolů turnaje, které teď existují (u živého turnaje žádné). */
  tableIdsOf(id: string): string[] {
    return this.sets.get(id)?.tableIds() ?? [];
  }

  /** Popisek stolu pro TV a přehledy: „Název turnaje · stůl N“. */
  tableLabel(tableId: string): string | undefined {
    for (const [tid, set] of this.sets) {
      if (!set.tableIds().includes(tableId)) continue;
      const name = this.rows.get(tid)?.name ?? tid;
      return set.tableCount() > 1 ? `${name} · ${t('tournament.tableNo', { n: this.tableNo(tid, tableId) })}` : name;
    }
    return undefined;
  }

  /** Hraje hráč ještě v turnaji? (Přístup do chatu turnaje i bez rozehraného stolu.) */
  isPlaying(id: string, userId: string): boolean {
    return !!this.tours.get(id)?.state().players.some((p) => p.userId === userId && (p.status === 'playing' || p.status === 'deciding'));
  }

  /** Stůl hráče v turnaji (pro odkaz „Můj stůl“). */
  tableOfPlayer(id: string, userId: string): string | null {
    return this.sets.get(id)?.tableOf(userId) ?? null;
  }

  /** Při startu: rozběhnuté a otevřené turnaje se obnoví z DB. */
  async load(): Promise<void> {
    const rows = await this.deps.db.select().from(schema.tournaments).where(inArray(schema.tournaments.status, ACTIVE));
    for (const r of rows) {
      const state = (r.state ?? undefined) as TournamentState | undefined;
      const snaps = new Map<string, PersistedTable | undefined>();
      for (const tableId of state?.tableIds?.length ? state.tableIds : [r.id]) {
        const snap = (await loadTableState(this.deps.db, tableId)) as PersistedTable | undefined;
        if (snap) snaps.set(tableId, snap);
      }
      this.spawn({ id: r.id, name: r.name, ownerId: r.ownerId, templateId: r.templateId, templateValues: r.templateValues ?? null, settings: r.settings ?? {}, sched: (r.sched ?? null) as SchedMeta | null }, state, snaps);
    }
  }

  /** Vypnutí serveru: zastaví hodiny a stoly (stav zůstává uložený). */
  stop(): void {
    for (const t of this.tours.values()) t.stop();
    for (const id of this.tours.keys()) for (const tableId of this.tableIdsOf(id)) this.deps.actors.get(tableId)?.stop();
  }

  /** Stav turnaje pro sázky a odměny na hlavu. */
  facts(id: string): BetFacts | null {
    const tour = this.tours.get(id);
    const row = this.rows.get(id);
    if (!tour || !row) return null;
    const st = tour.state();
    const s = this.settingsOf(id)!;
    const rebuyOpen = st.status === 'registering' ? true : st.status === 'running' && !!s['tournament.rebuyEnabled'] && tour.levelNumber() <= Number(s['tournament.rebuyUntilLevel']);
    return {
      status: st.status,
      name: row.name,
      results: st.results ? st.results.map((r) => ({ userId: r.userId, place: r.place })) : null,
      firstOut: st.eliminations[0] ?? null,
      participants: st.players.filter((p) => p.status !== 'out' || st.status === 'registering').map((p) => p.userId),
      rebuyOpen,
      winnerId: st.results?.[0]?.userId ?? null,
    };
  }

  /** Živá hra (skutečné karty u stolu): turnaj bez stolu, řídí ho ředitel. */
  isLive(id: string): boolean {
    const row = this.rows.get(id);
    return !!row && !!this.resolve(row)['tournament.live'];
  }

  get(id: string): Tournament | undefined {
    return this.tours.get(id);
  }
  row(id: string): Row | undefined {
    return this.rows.get(id);
  }
  list(): Row[] {
    return [...this.rows.values()];
  }
  settingsOf(id: string): SettingValues | undefined {
    const row = this.rows.get(id);
    return row ? this.resolve(row) : undefined;
  }

  /** Zda některý aktivní turnaj vznikl z dané šablony (šablona se pak nedá smazat). */
  usesTemplate(templateId: string): boolean {
    return this.list().some((r) => r.templateId === templateId && ACTIVE.includes(this.tours.get(r.id)?.state().status ?? ''));
  }

  private can(userId: string, key: string, ctx = {}) {
    return this.deps.perms.can(userId, key, ctx);
  }

  private must(id: string): { row: Row; tour: Tournament } {
    const row = this.rows.get(id);
    const tour = this.tours.get(id);
    if (!row || !tour) throw new TournamentError('NOT_FOUND');
    return { row, tour };
  }

  private canManage(userId: string, row: Row): boolean {
    return (row.ownerId === userId && this.can(userId, 'turnaj.upravit_vlastni').allowed) || this.can(userId, 'turnaj.upravit_vse').allowed || (this.isLive(row.id) && this.can(userId, 'zivahra.rizeni').allowed);
  }

  /** Jen parametry, které smí přepsat vrstva stolu, a platné hodnoty. */
  private checkSettings(templateId: string | null, values: Record<string, unknown>): Record<string, SettingValue> {
    const clean: Record<string, SettingValue> = {};
    for (const [k, v] of Object.entries(values)) {
      const def = this.deps.registry.get(k);
      if (!def || !scopeAllowed(def.scopes, 'table') || def.secret) throw new TournamentError('INVALID', { key: k });
      clean[k] = v as SettingValue;
    }
    const template = this.deps.templates.get(templateId);
    const issues = validateValues(this.deps.registry, { ...(template?.values ?? {}), ...clean });
    if (issues.length) throw new TournamentError('INVALID', { issues });
    return clean;
  }

  // ---------- zakládání a úpravy ----------

  async create(actorId: string, input: { name: string; templateId: string; settings?: Record<string, unknown> }, meta: Meta = {}): Promise<{ id: string }> {
    const d = this.can(actorId, 'turnaj.vytvorit');
    if (!d.allowed) throw new TournamentError('FORBIDDEN');
    const name = input.name?.trim() ?? '';
    if (name.length < 2 || name.length > 60) throw new TournamentError('INVALID', { field: 'name' });
    const template = this.deps.templates.get(input.templateId);
    if (!template || template.kind !== 'tournament') throw new TournamentError('INVALID', { field: 'templateId' });
    const clean = this.checkSettings(template.id, input.settings ?? {});
    const merged = this.deps.settings.resolve([{ scope: 'template', values: template.values }, { scope: 'table', values: clean }]);
    const mine = this.list().filter((r) => r.ownerId === actorId && ACTIVE.includes(this.tours.get(r.id)!.state().status)).length;
    if (d.limits?.maxConcurrent !== undefined && mine >= d.limits.maxConcurrent) throw new TournamentError('LIMIT_EXCEEDED', { limit: 'maxConcurrent', value: d.limits.maxConcurrent });
    if (d.limits?.maxBuyIn !== undefined && Number(merged['tournament.buyIn']) > d.limits.maxBuyIn) throw new TournamentError('LIMIT_EXCEEDED', { limit: 'maxBuyIn', value: d.limits.maxBuyIn });
    if (Number(merged['tournament.minPlayers']) > Number(merged['table.seats'])) throw new TournamentError('INVALID', { field: 'tournament.minPlayers' });

    return this.insert(actorId, name, template, clean, merged, null, meta);
  }

  /** Uloží nový turnaj (a případně jeho plán) a rozběhne ho. */
  private async insert(ownerId: string | null, name: string, template: SettingsTemplate, clean: Record<string, SettingValue>, merged: SettingValues, sched: SchedMeta | null, meta: Meta): Promise<{ id: string }> {
    const templateId = template.id;
    const templateValues = template.builtin ? null : template.values;
    const id = `t-${name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'turnaj'}-${randomBytes(3).toString('hex')}`;
    if (merged['tournament.live']) {
      if (!this.deps.settings.resolve()['live.enabled']) throw new TournamentError('INVALID', { field: 'tournament.live' });
      if (ownerId && !this.can(ownerId, 'zivahra.rizeni').allowed) throw new TournamentError('FORBIDDEN');
    }
    const row: Row = { id, name, ownerId, templateId, templateValues, settings: clean, sched };
    // Struktura blindů a výplatní procenta se ověří dřív, než se turnaj uloží.
    const probe = new Tournament({ id, settings: () => merged, clock: this.deps.clock, money: this.money });
    probe.validate();
    await this.deps.db.insert(schema.tournaments).values({ id, name, ownerId, templateId, templateValues, settings: clean, status: 'registering', sched });
    this.spawn(row);
    await this.deps.audit?.log({ actorId: ownerId ?? undefined, action: sched ? 'turnaj.naplanovat' : 'turnaj.vytvorit', targetType: 'tournament', targetId: id, after: { name, templateId, settings: clean, sched }, ...meta });
    this.persistNow(id);
    return { id };
  }

  /** Naplánování turnaje na daný okamžik. Uživatel potřebuje oprávnění „turnaj.naplanovat“, plánovač (actorId null) ne. */
  async scheduleTournament(
    actorId: string | null,
    input: { name: string; templateId: string; settings?: Record<string, unknown>; startAt: number; scheduleId?: string | null; seriesId?: string | null; occurrence?: number; ownerId?: string | null; invited?: string[] },
    meta: Meta = {},
  ): Promise<{ id: string }> {
    if (actorId && !this.can(actorId, 'turnaj.naplanovat').allowed) throw new TournamentError('FORBIDDEN');
    const name = input.name?.trim() ?? '';
    if (name.length < 2 || name.length > 60) throw new TournamentError('INVALID', { field: 'name' });
    if (!Number.isFinite(input.startAt) || input.startAt < this.deps.clock.now() - 60_000) throw new TournamentError('INVALID', { field: 'startAt' });
    const template = this.deps.templates.get(input.templateId);
    if (!template || template.kind !== 'tournament') throw new TournamentError('INVALID', { field: 'templateId' });
    const clean = this.checkSettings(template.id, input.settings ?? {});
    const merged = this.deps.settings.resolve([{ scope: 'template', values: template.values }, { scope: 'table', values: clean }]);
    if (Number(merged['tournament.minPlayers']) > Number(merged['table.seats'])) throw new TournamentError('INVALID', { field: 'tournament.minPlayers' });
    const opensAt = input.startAt - Number(merged['tournament.registerOpensMinutes']) * 60_000;
    const sched: SchedMeta = { startAt: input.startAt, opensAt, occurrence: input.occurrence ?? input.startAt, scheduleId: input.scheduleId ?? null, seriesId: input.seriesId ?? null, postponed: 0, reminded: [], openedNotified: false, autoPaused: false, ...(input.invited ? { invited: input.invited } : {}) };
    const created = await this.insert(actorId ?? input.ownerId ?? null, name, template, clean, merged, sched, meta);
    this.deps.onScheduled?.(created.id, name, input.startAt);
    return created;
  }

  nameOf(id: string): string | undefined {
    return this.rows.get(id)?.name;
  }

  // ---------- plánování ----------

  schedOf(id: string): SchedMeta | null {
    return this.rows.get(id)?.sched ?? null;
  }

  /** Změní plán turnaje a uloží ho do DB. */
  async patchSched(id: string, patch: Partial<SchedMeta>): Promise<void> {
    const row = this.rows.get(id);
    if (!row?.sched) return;
    row.sched = { ...row.sched, ...patch };
    await this.deps.db.update(schema.tournaments).set({ sched: row.sched }).where(eq(schema.tournaments.id, id));
    this.deps.onChanged?.(id);
  }

  /** Je registrace právě otevřená? (Neplánovaný turnaj: vždy, dokud se nehraje.) */
  registrationOpen(id: string): boolean {
    const sched = this.rows.get(id)?.sched;
    return !sched || this.deps.clock.now() >= sched.opensAt;
  }

  /** Spuštění plánovačem; hráči, kteří nejsou online, začínají v sit outu. */
  startSystem(id: string, force = false): void {
    const { tour } = this.must(id);
    tour.start({ force });
    if (!this.deps.isOnline) return;
    for (const p of tour.state().players) {
      if (this.deps.isOnline(p.userId)) continue;
      const actor = this.deps.actors.get(this.tableOfPlayer(id, p.userId) ?? id);
      if (!actor) continue;
      try {
        actor.setConnected(p.userId, false);
        actor.sitOut(p.userId);
      } catch {
        // hráč u stolu není
      }
    }
  }

  /** Zrušení plánovačem (nedostatek hráčů…): všem se vrátí platby. */
  cancelSystem(id: string): void {
    this.must(id).tour.cancel();
  }

  /** Automatická pauza a pokračování podle počtu připojených hráčů. */
  pauseSystem(id: string, resume: boolean): void {
    const { tour } = this.must(id);
    if (resume) tour.resume();
    else tour.pause();
  }

  /** Počet hráčů, kteří jsou u stolu a připojení. */
  connectedPlayers(id: string): number {
    const tour = this.tours.get(id);
    if (!tour) return 0;
    const alive = new Set(tour.state().players.filter((p) => p.status === 'playing').map((p) => p.userId));
    let n = 0;
    for (const tableId of this.tableIdsOf(id)) n += this.deps.actors.get(tableId)?.playersSeated().filter((s) => alive.has(s.userId) && s.connected).length ?? 0;
    return n;
  }

  /** Všechny turnaje, které mají plán (pro plánovač). */
  scheduled(): { id: string; sched: SchedMeta; status: TournamentState['status'] }[] {
    return this.list().flatMap((r) => (r.sched ? [{ id: r.id, sched: r.sched, status: this.tours.get(r.id)!.state().status }] : []));
  }

  /** Hráči přihlášení do turnaje (pro upozornění). */
  registeredUsers(id: string): string[] {
    return (this.tours.get(id)?.state().players ?? []).filter((p) => p.status !== 'out' || this.tours.get(id)!.state().status === 'registering').map((p) => p.userId);
  }

  private persistNow(id: string): void {
    const t = this.tours.get(id);
    if (t) this.deps.journal.push(`tournament:${id}`, tournamentStateOp(id, t.state().status, t.state()));
  }

  /** Náhled změny nastavení turnaje bez provedení. */
  previewSettings(actorId: string, id: string, changes: Record<string, unknown>): { before: SettingValues; clean: Record<string, SettingValue>; rows: { key: string; timing: 'now' | 'nextHand' | 'denied'; reasonKey?: string }[] } {
    const { row, tour } = this.must(id);
    if (!this.canManage(actorId, row)) throw new TournamentError('FORBIDDEN');
    const st = tour.state();
    if (st.status === 'finished' || st.status === 'cancelled') throw new TournamentError('STATE');
    const clean = this.checkSettings(row.templateId, { ...row.settings, ...changes });
    const ctx = { gameStarted: st.status !== 'registering', handInProgress: this.tableIdsOf(id).some((tableId) => this.deps.actors.get(tableId)?.handInProgress()), isAdmin: this.can(actorId, 'nastaveni.globalni').allowed };
    const rows = Object.keys(changes).map((key) => {
      const dec = decideChange(this.deps.registry, key, ctx);
      return dec.result === 'denied' ? { key, timing: 'denied' as const, reasonKey: dec.reasonKey } : { key, timing: dec.result === 'pending' ? ('nextHand' as const) : ('now' as const) };
    });
    return { before: this.settingsOf(id) ?? {}, clean: clean as Record<string, SettingValue>, rows };
  }

  /** Změna nastavení turnaje podle pravidla „kdy lze měnit“. */
  async updateSettings(actorId: string, id: string, changes: Record<string, unknown>, meta: Meta = {}): Promise<{ applied: string[]; pending: string[] }> {
    const { row, tour } = this.must(id);
    if (!this.canManage(actorId, row)) throw new TournamentError('FORBIDDEN');
    const st = tour.state();
    if (st.status === 'finished' || st.status === 'cancelled') throw new TournamentError('STATE');
    const clean = this.checkSettings(row.templateId, { ...row.settings, ...changes });
    const ctx = { gameStarted: st.status !== 'registering', handInProgress: this.tableIdsOf(id).some((tableId) => this.deps.actors.get(tableId)?.handInProgress()), isAdmin: this.can(actorId, 'nastaveni.globalni').allowed };
    const now: Record<string, SettingValue> = {};
    const later: Record<string, SettingValue> = {};
    for (const k of Object.keys(changes)) {
      const dec = decideChange(this.deps.registry, k, ctx);
      if (dec.result === 'denied') throw new TournamentError('INVALID', { key: k, reasonKey: dec.reasonKey });
      if (dec.result === 'pending') later[k] = clean[k]!;
      else now[k] = clean[k]!;
    }
    const before = { ...row.settings };
    row.settings = { ...row.settings, ...now };
    try {
      tour.validate();
    } catch (e) {
      row.settings = before;
      throw e;
    }
    if (Object.keys(now).length) await this.deps.db.update(schema.tournaments).set({ settings: row.settings }).where(eq(schema.tournaments.id, id));
    if (Object.keys(later).length) this.pending.set(id, { ...(this.pending.get(id) ?? {}), ...later });
    await this.deps.audit?.log({ actorId, action: 'nastaveni.zmena', targetType: 'tournament', targetId: id, before, after: { applied: now, pending: later }, ...meta });
    this.deps.onChanged?.(id);
    this.deps.onTableChange(id);
    return { applied: Object.keys(now), pending: Object.keys(later) };
  }

  private applyPending(id: string): void {
    const later = this.pending.get(id);
    const row = this.rows.get(id);
    if (!later || !row) return;
    this.pending.delete(id);
    row.settings = { ...row.settings, ...later };
    void this.deps.db.update(schema.tournaments).set({ settings: row.settings }).where(eq(schema.tournaments.id, id));
    this.deps.onChanged?.(id);
  }

  pendingChanges(id: string): Record<string, SettingValue> {
    return { ...(this.pending.get(id) ?? {}) };
  }

  // ---------- akce hráčů a organizátora ----------

  private async actAs(actorId: string, id: string, perm: string): Promise<{ row: Row; tour: Tournament }> {
    const r = this.must(id);
    if (!this.can(actorId, perm).allowed) throw new TournamentError('FORBIDDEN');
    return r;
  }

  async register(userId: string, id: string, meta: Meta = {}): Promise<void> {
    const { tour } = await this.actAs(userId, id, 'turnaj.hrat');
    if (!this.registrationOpen(id)) throw new TournamentError('REGISTRATION_CLOSED', { reason: 'notYet' });
    const invited = this.rows.get(id)?.sched?.invited;
    if (invited && !invited.includes(userId)) throw new TournamentError('FORBIDDEN', { reason: 'invited' });
    tour.register(userId, await this.deps.nickOf(userId));
    this.deps.onWallet?.(userId);
    await this.deps.audit?.log({ actorId: userId, action: 'turnaj.prihlaska', targetType: 'tournament', targetId: id, ...meta });
  }

  async unregister(userId: string, id: string, meta: Meta = {}): Promise<void> {
    const { tour } = await this.actAs(userId, id, 'turnaj.hrat');
    const sched = this.rows.get(id)?.sched;
    if (sched && this.deps.clock.now() > sched.startAt - Number(this.settingsOf(id)!['tournament.unregisterUntilMinutes']) * 60_000) throw new TournamentError('STATE', { reason: 'unregisterClosed' });
    tour.unregister(userId);
    this.deps.onWallet?.(userId);
    await this.deps.audit?.log({ actorId: userId, action: 'turnaj.odhlaska', targetType: 'tournament', targetId: id, ...meta });
  }

  async rebuy(userId: string, id: string): Promise<void> {
    const { tour } = await this.actAs(userId, id, 'turnaj.hrat');
    tour.rebuy(userId);
    this.deps.onWallet?.(userId);
  }

  async addon(userId: string, id: string): Promise<void> {
    const { tour } = await this.actAs(userId, id, 'turnaj.hrat');
    tour.addon(userId);
    this.deps.onWallet?.(userId);
  }

  async declineAddon(userId: string, id: string): Promise<void> {
    const { tour } = await this.actAs(userId, id, 'turnaj.hrat');
    tour.declineAddon(userId);
  }

  async reenter(userId: string, id: string): Promise<void> {
    const { tour } = await this.actAs(userId, id, 'turnaj.hrat');
    tour.reenter(userId);
    this.deps.onWallet?.(userId);
  }

  // ---------- dohoda (deal) ----------

  dealOptions(id: string, viewerId: string): ReturnType<Tournament['dealOptions']> {
    return this.must(id).tour.dealOptions(viewerId);
  }

  /** Dohodu může navrhnout zbývající hráč, nebo organizátor (jeho návrh je bez automatického souhlasu). */
  async proposeDeal(userId: string, id: string, input: { method: 'icm' | 'chipChop' | 'equal' | 'custom'; keep?: number; custom?: Record<string, number> }, meta: Meta = {}): Promise<void> {
    const { row, tour } = this.must(id);
    const manage = this.canManage(userId, row);
    const player = this.can(userId, 'turnaj.hrat').allowed && tour.state().players.some((p) => p.userId === userId && p.status === 'playing');
    if (!manage && !player) throw new TournamentError('FORBIDDEN');
    tour.proposeDeal(player ? userId : null, input);
    await this.deps.audit?.log({ actorId: userId, action: 'turnaj.dohoda_navrh', targetType: 'tournament', targetId: id, after: { method: input.method, keep: input.keep ?? 0 }, ...meta });
  }

  async voteDeal(userId: string, id: string, yes: boolean): Promise<void> {
    const { tour } = await this.actAs(userId, id, 'turnaj.hrat');
    tour.voteDeal(userId, yes);
  }

  async cancelDeal(userId: string, id: string): Promise<void> {
    const { row, tour } = this.must(id);
    const v = tour.dealOptions(userId).vote;
    if (!v) throw new TournamentError('NO_VOTE');
    if (v.proposer !== userId && !this.canManage(userId, row)) throw new TournamentError('FORBIDDEN');
    tour.cancelDealVote();
  }

  async start(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    const { row, tour } = this.must(id);
    if (!this.canManage(actorId, row)) throw new TournamentError('FORBIDDEN');
    tour.start();
    await this.deps.audit?.log({ actorId, action: 'turnaj.start', targetType: 'tournament', targetId: id, ...meta });
  }

  async pause(actorId: string, id: string, resume: boolean, meta: Meta = {}): Promise<void> {
    const { row, tour } = this.must(id);
    if (!this.canManage(actorId, row) && !this.can(actorId, 'zasah.pauza').allowed) throw new TournamentError('FORBIDDEN');
    if (resume) tour.resume();
    else tour.pause();
    await this.deps.audit?.log({ actorId, action: resume ? 'turnaj.pokracovat' : 'turnaj.pauza', targetType: 'tournament', targetId: id, ...meta });
  }

  // ---------- živá hra: ředitel zapisuje za hráče ----------

  private liveDirector(actorId: string, id: string): { row: Row; tour: Tournament } {
    const { row, tour } = this.must(id);
    if (!this.isLive(id)) throw new TournamentError('INVALID', { field: 'live' });
    if (!this.canManage(actorId, row)) throw new TournamentError('FORBIDDEN');
    return { row, tour };
  }

  private async liveAudit(actorId: string, id: string, action: string, after: Record<string, unknown>, meta: Meta): Promise<void> {
    await this.deps.audit?.log({ actorId, action, targetType: 'tournament', targetId: id, after, ...meta });
  }

  /** Ředitel přihlásí hráče (buy-in jde z jeho peněženky). */
  async liveRegister(actorId: string, id: string, userId: string, meta: Meta = {}): Promise<void> {
    const { tour } = this.liveDirector(actorId, id);
    if (!this.can(userId, 'turnaj.hrat').allowed) throw new TournamentError('FORBIDDEN');
    tour.register(userId, await this.deps.nickOf(userId));
    this.deps.onWallet?.(userId);
    await this.liveAudit(actorId, id, 'zivahra.prihlasit', { userId }, meta);
  }

  async liveUnregister(actorId: string, id: string, userId: string, meta: Meta = {}): Promise<void> {
    const { tour } = this.liveDirector(actorId, id);
    tour.unregister(userId);
    this.deps.onWallet?.(userId);
    await this.liveAudit(actorId, id, 'zivahra.odhlasit', { userId }, meta);
  }

  async liveBuy(actorId: string, id: string, userId: string, what: 'rebuy' | 'addon' | 'reenter', meta: Meta = {}): Promise<void> {
    const { tour } = this.liveDirector(actorId, id);
    if (what === 'rebuy') tour.rebuy(userId, { busted: true });
    else if (what === 'addon') tour.addon(userId);
    else tour.reenter(userId);
    this.deps.onWallet?.(userId);
    await this.liveAudit(actorId, id, 'zivahra.' + what, { userId }, meta);
  }

  /** Ředitel potvrdí přesazení hráče k jinému stolu (server ho navrhl podle počtu hráčů u stolů). */
  async liveMove(actorId: string, id: string, userId: string, toTable: string, meta: Meta = {}): Promise<void> {
    const { row } = this.liveDirector(actorId, id);
    const set = this.sets.get(id);
    if (!set) throw new TournamentError('INVALID', { field: 'tables' });
    const name = this.must(id).tour.state().players.find((p) => p.userId === userId)?.name ?? '';
    let r: { seat: number; fromTable: string };
    try {
      r = set.applyMove(userId, toTable);
    } catch (e) {
      throw new TournamentError('INVALID', { field: 'move', reason: e instanceof Error ? e.message : 'INVALID_MOVE' });
    }
    this.deps.onLiveMove?.(id, { userId, name, fromNo: this.tableNo(id, r.fromTable), toNo: this.tableNo(id, toTable), seat: r.seat + 1 });
    await this.liveAudit(actorId, id, 'zivahra.presadit', { userId, toTable }, meta);
    void row;
  }

  /** Zápis vyřazení: kdo vypadl a (nepovinně) kdo ho vyřadil, kvůli bounty, ratingu a XP. */
  async liveEliminate(actorId: string, id: string, victimId: string, killers: string[], meta: Meta = {}): Promise<void> {
    const { tour } = this.liveDirector(actorId, id);
    tour.eliminateManually(victimId, killers);
    for (const p of tour.state().players) if (p.userId === victimId || killers.includes(p.userId)) this.deps.onWallet?.(p.userId);
    await this.liveAudit(actorId, id, 'zivahra.vyradit', { victimId, killers }, meta);
  }

  async cancel(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    const { row, tour } = this.must(id);
    const own = row.ownerId === actorId && this.can(actorId, 'turnaj.zrusit_vlastni').allowed;
    if (!own && !this.can(actorId, 'turnaj.zrusit_vse').allowed) throw new TournamentError('FORBIDDEN');
    tour.cancel();
    await this.deps.audit?.log({ actorId, action: 'turnaj.zrusit', targetType: 'tournament', targetId: id, ...meta });
  }

  // ---------- pohledy ----------

  /**
   * Smaže ukončený nebo zrušený turnaj z historie (nevratné, jen hlavní správce): záznam turnaje, výsledky,
   * vyřazení, handy jeho stolů, sázky, odměny na hlavu, zařazení do večera a chat stolu.
   * Rating a XP, které z turnaje vznikly, zůstávají (rating jde přepočítat z historie ve Statistikách).
   */
  async deleteFromHistory(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    if (!this.can(actorId, 'historie.spravovat').allowed && !this.can(actorId, 'nastaveni.globalni').allowed) throw new TournamentError('FORBIDDEN');
    const db = this.deps.db;
    const [row] = await db.select().from(schema.tournaments).where(eq(schema.tournaments.id, id));
    if (!row) throw new TournamentError('NOT_FOUND');
    const live = this.tours.get(id);
    const status = live?.state().status ?? row.status;
    if (status !== 'finished' && status !== 'cancelled') throw new TournamentError('STATE');
    const state = (live?.state() ?? row.state) as TournamentState | null;
    const tableIds = [...new Set([id, ...(state?.tableIds ?? [])])];
    this.archive(id);
    await db.delete(schema.tournamentEliminations).where(eq(schema.tournamentEliminations.tournamentId, id));
    await db.delete(schema.gameResults).where(and(eq(schema.gameResults.kind, 'tournament'), eq(schema.gameResults.ref, id)));
    await db.delete(schema.hands).where(or(eq(schema.hands.tournamentId, id), inArray(schema.hands.tableId, tableIds)));
    await db.delete(schema.tableState).where(inArray(schema.tableState.tableId, tableIds));
    await db.delete(schema.bets).where(eq(schema.bets.tournamentId, id));
    await db.delete(schema.headBounties).where(eq(schema.headBounties.tournamentId, id));
    await db.delete(schema.eveningGames).where(and(eq(schema.eveningGames.kind, 'tournament'), eq(schema.eveningGames.ref, id)));
    await db.delete(schema.chatChannels).where(eq(schema.chatChannels.key, `table:${id}`));
    await db.delete(schema.tournaments).where(eq(schema.tournaments.id, id));
    await this.deps.audit?.log({ actorId, action: 'turnaj.smazat_historii', targetType: 'tournament', targetId: id, before: { name: row.name, status }, ...meta });
  }

  /** Odstraní ukončený turnaj z paměti (po čase), stůl už je zavřený. */
  private archive(id: string): void {
    for (const tableId of this.tableIdsOf(id)) this.deps.actors.delete(tableId);
    this.deps.actors.delete(id);
    this.sets.delete(id);
    this.tours.delete(id);
    this.rows.delete(id);
  }

  async lobby(): Promise<TournamentSummary[]> {
    const rows = await this.deps.db.select().from(schema.tournaments);
    const owners = await this.deps.db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users);
    const nick = new Map(owners.map((o) => [o.id, o.nickname]));
    return rows
      .map((r) => {
        const live = this.tours.get(r.id);
        const state = (live?.state() ?? r.state) as TournamentState | null;
        const s = live ? this.resolve(this.rows.get(r.id)!) : this.deps.settings.resolve([{ scope: 'table', values: (r.settings ?? {}) as Record<string, SettingValue> }]);
        return {
          id: r.id,
          name: r.name,
          owner: r.ownerId ? (nick.get(r.ownerId) ?? null) : null,
          ownerId: r.ownerId,
          status: (state?.status ?? r.status) as TournamentState['status'],
          players: state?.players.length ?? 0,
          alive: state?.players.filter((p) => p.status === 'playing' || p.status === 'deciding').length ?? 0,
          seats: Number(s['table.seats']),
          buyIn: Number(s['tournament.buyIn']),
          fee: Number(s['tournament.fee']),
          startingStack: Number(s['tournament.startingStack']),
          live: !!s['tournament.live'],
          startAt: this.rows.get(r.id)?.sched?.startAt ?? null,
          createdAt: r.createdAt.getTime(),
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100);
  }

  /** Úplný přehled turnaje pro konkrétního uživatele (včetně toho, co smí dělat). */
  async view(id: string, userId: string): Promise<TournamentView> {
    const live = this.tours.get(id);
    if (!live) {
      const [r] = await this.deps.db.select().from(schema.tournaments).where(eq(schema.tournaments.id, id));
      if (!r) throw new TournamentError('NOT_FOUND');
      return this.archivedView(r);
    }
    const row = this.rows.get(id)!;
    const s = this.resolve(row);
    const st = live.state();
    const level = live.currentLevel();
    const levels = live.levels();
    const nextIdx = Math.min(st.levelIndex + 1, levels.length - 1);
    const me = live.state().players.find((p) => p.userId === userId);
    const manage = this.canManage(userId, row);
    const owner = row.ownerId ? await this.deps.nickOf(row.ownerId).catch(() => null) : null;
    const results = st.results;
    const isLive = !!s['tournament.live'];
    const chipsInPlay = st.payments
      .filter((p) => !p.refunded)
      .reduce((a, p) => a + Number(s[p.kind === 'turnaj_buyin' ? 'tournament.startingStack' : p.kind === 'turnaj_rebuy' ? 'tournament.rebuyChips' : 'tournament.addonChips']), 0);
    const aliveNow = st.players.filter((p) => p.status === 'playing' || p.status === 'deciding').length;
    const standings = live.standings().map((p) => ({ ...p, chips: isLive ? null : p.chips, seat: st.players.find((x) => x.userId === p.userId)?.seat ?? null, tableNo: ((tb) => (tb ? this.tableNo(id, tb) : null))(st.players.find((x) => x.userId === p.userId)?.tableId), payout: results?.find((r) => r.userId === p.userId)?.payout ?? null, head: live.headOf(p.userId), bounty: st.players.find((x) => x.userId === p.userId)?.bountyEarned ?? 0 }));
    return {
      id,
      name: row.name,
      owner,
      ownerId: row.ownerId,
      status: st.status,
      paused: st.paused,
      onBreak: st.onBreak,
      startedAt: st.startedAt,
      serverTime: Date.now(),
      buyIn: Number(s['tournament.buyIn']),
      fee: Number(s['tournament.fee']),
      startingStack: Number(s['tournament.startingStack']),
      seats: Number(s['table.seats']),
      minPlayers: Number(s['tournament.minPlayers']),
      players: st.players.length,
      alive: standings.filter((p) => p.status === 'playing' || p.status === 'deciding').length,
      bubble: live.isBubble(),
      levelNumber: live.levelNumber(),
      level,
      nextLevel: st.levelIndex < levels.length - 1 ? levels[nextIdx]! : null,
      levels,
      levelMode: String(s['tournament.levelMode']),
      levelMinutes: Number(s['tournament.levelMinutes']),
      levelHands: Number(s['tournament.levelHands']),
      handsInLevel: st.handsInLevel,
      clockKind: st.clock.kind,
      clockMs: live.clockRemainingMs(),
      lateRegLevels: Number(s['tournament.lateRegLevels']),
      lateRegOpen: live.lateRegOpen(),
      rebuy: { enabled: !!s['tournament.rebuyEnabled'], untilLevel: Number(s['tournament.rebuyUntilLevel']), cost: Number(s['tournament.rebuyCost']), chips: Number(s['tournament.rebuyChips']), max: Number(s['tournament.rebuyMax']) },
      addon: { enabled: !!s['tournament.addonEnabled'], fromLevel: Number(s['tournament.addonFromLevel']), untilLevel: Number(s['tournament.addonUntilLevel']), cost: Number(s['tournament.addonCost']), chips: Number(s['tournament.addonChips']) },
      reentry: { enabled: !!s['tournament.reentryEnabled'], max: Number(s['tournament.reentryMax']) },
      breakEveryLevels: Number(s['tournament.breakEveryLevels']),
      breakMinutes: Number(s['tournament.breakMinutes']),
      prizePool: live.prizePool() || st.payments.filter((p) => !p.refunded).reduce((a, p) => a + poolPart(p), 0),
      fees: feesOf(s, st),
      bounty: { type: String(s['tournament.bountyType']), percent: Number(s['tournament.bountyPercent']), pkoCash: Number(s['tournament.pkoCashPercent']), payout: String(s['tournament.bountyPayout']), bank: this.deps.ledger.balance(accounts.bounty(id)) },
      deal: { enabled: !!s['tournament.dealEnabled'], open: live.dealOptions(userId).vote?.status === 'open', done: st.deal ? { method: st.deal.method, keep: st.deal.keep } : null, blocked: live.dealBlocker() },
      schedule: row.sched ? { startAt: row.sched.startAt, opensAt: row.sched.opensAt, registrationOpen: this.registrationOpen(id), postponed: row.sched.postponed, seriesId: row.sched.seriesId, unregisterUntil: row.sched.startAt - Number(s['tournament.unregisterUntilMinutes']) * 60_000, autoPaused: row.sched.autoPaused, invited: row.sched.invited ?? null } : null,
      payouts: live.payoutPreview(),
      payoutPreset: String(s['tournament.payoutPreset']),
      standings,
      results,
      summary: results ? results.map((r) => resultSummary(st, r)) : null,
      pending: this.pending.get(id) ?? {},
      tables: this.sets.get(id)?.overview().map((tb) => ({ id: tb.id, no: this.tableNo(id, tb.id), players: tb.players.map((p) => ({ userId: p.userId, name: p.name, seat: p.seat + 1, chips: p.chips })) })) ?? [],
      maxTables: Math.max(1, Number(s['tournament.maxTables']) || 1),
      live: isLive ? { suggestions: manage && st.status === 'running' ? (this.sets.get(id)?.suggest() ?? []).map((m) => ({ userId: m.userId, name: m.name, fromNo: this.tableNo(id, m.fromTable), toTable: m.toTable, toNo: this.tableNo(id, m.toTable), reason: m.reason })) : [], chipsInPlay: st.status === 'running' ? chipsInPlay : 0, avgStack: st.status === 'running' && aliveNow > 0 ? Math.floor(chipsInPlay / aliveNow) : null, director: manage } : null,
      me: {
        registered: !!me,
        status: me?.status ?? null,
        entries: me?.entries ?? 0,
        rebuys: me?.rebuys ?? 0,
        addon: me?.addon ?? false,
        decideUntil: me?.decideUntil ?? null,
        tableId: this.tableOfPlayer(id, userId),
        canRegister: live.canRegister(userId) && this.can(userId, 'turnaj.hrat').allowed && this.registrationOpen(id) && (!row.sched?.invited || row.sched.invited.includes(userId)),
        canUnregister: st.status === 'registering' && !!me,
        canRebuy: live.canRebuy(userId) && this.can(userId, 'turnaj.hrat').allowed,
        canAddon: live.canAddon(userId) && this.can(userId, 'turnaj.hrat').allowed,
        addonOfferUntil: live.addonOffered(userId) ? live.addonOfferUntil() : null,
        canReenter: (live.canReenter(userId) || live.canReenterNowPublic(userId)) && this.can(userId, 'turnaj.hrat').allowed,
      },
      can: {
        manage,
        start: manage && st.status === 'registering',
        pause: (manage || this.can(userId, 'zasah.pauza').allowed) && st.status === 'running',
        cancel: ((row.ownerId === userId && this.can(userId, 'turnaj.zrusit_vlastni').allowed) || this.can(userId, 'turnaj.zrusit_vse').allowed) && (st.status === 'registering' || st.status === 'running'),
      },
    };
  }

  private archivedView(r: typeof schema.tournaments.$inferSelect): TournamentView {
    const st = r.state as TournamentState | null;
    const s = this.deps.settings.resolve([{ scope: 'table', values: (r.settings ?? {}) as Record<string, SettingValue> }]);
    return {
      id: r.id,
      name: r.name,
      owner: null,
      ownerId: r.ownerId,
      status: (st?.status ?? (r.status as TournamentState['status'])),
      paused: false,
      onBreak: false,
      startedAt: st?.startedAt ?? null,
      serverTime: Date.now(),
      buyIn: Number(s['tournament.buyIn']),
      fee: Number(s['tournament.fee']),
      startingStack: Number(s['tournament.startingStack']),
      seats: Number(s['table.seats']),
      minPlayers: Number(s['tournament.minPlayers']),
      players: st?.players.length ?? 0,
      alive: 0,
      bubble: false,
      levelNumber: (st?.levelIndex ?? 0) + 1,
      level: null,
      nextLevel: null,
      levels: st?.levels ?? [],
      levelMode: String(s['tournament.levelMode']),
      levelMinutes: Number(s['tournament.levelMinutes']),
      levelHands: Number(s['tournament.levelHands']),
      handsInLevel: 0,
      clockKind: null,
      clockMs: null,
      lateRegLevels: Number(s['tournament.lateRegLevels']),
      lateRegOpen: false,
      rebuy: { enabled: !!s['tournament.rebuyEnabled'], untilLevel: Number(s['tournament.rebuyUntilLevel']), cost: Number(s['tournament.rebuyCost']), chips: Number(s['tournament.rebuyChips']), max: Number(s['tournament.rebuyMax']) },
      addon: { enabled: !!s['tournament.addonEnabled'], fromLevel: Number(s['tournament.addonFromLevel']), untilLevel: Number(s['tournament.addonUntilLevel']), cost: Number(s['tournament.addonCost']), chips: Number(s['tournament.addonChips']) },
      reentry: { enabled: !!s['tournament.reentryEnabled'], max: Number(s['tournament.reentryMax']) },
      breakEveryLevels: Number(s['tournament.breakEveryLevels']),
      breakMinutes: Number(s['tournament.breakMinutes']),
      prizePool: (st?.results ?? []).reduce((a, x) => a + x.payout, 0),
      fees: feesOf(s, st ?? undefined),
      payouts: [],
      payoutPreset: String(s['tournament.payoutPreset']),
      bounty: { type: String(s['tournament.bountyType']), percent: Number(s['tournament.bountyPercent']), pkoCash: Number(s['tournament.pkoCashPercent']), payout: String(s['tournament.bountyPayout']), bank: 0 },
      deal: { enabled: !!s['tournament.dealEnabled'], open: false, done: st?.deal ? { method: st.deal.method, keep: st.deal.keep } : null, blocked: 'STATE' },
      schedule: null,
      tables: [],
      maxTables: 1,
      standings: (st?.results ?? []).map((x) => ({ userId: x.userId, name: x.name, chips: null, seat: null, tableNo: null, place: x.place, status: 'out' as const, payout: x.payout, head: null, bounty: x.bounty ?? 0 })),
      results: st?.results ?? null,
      summary: st?.results ? st.results.map((r) => resultSummary(st, r)) : null,
      live: null,
      pending: {},
      me: { registered: false, status: null, entries: 0, rebuys: 0, addon: false, decideUntil: null, tableId: null, canRegister: false, canUnregister: false, canRebuy: false, canAddon: false, addonOfferUntil: null, canReenter: false },
      can: { manage: false, start: false, pause: false, cancel: false },
    };
  }

  /** Přehled financí turnajů pro pokladníka: kolik se vybralo, kam to šlo a kolik zbylo domu a fondům. */
  async finance(): Promise<FinanceOverview> {
    const rows = await this.deps.db.select().from(schema.tournaments);
    const list = rows.map((r) => {
      const st = ((this.tours.get(r.id)?.state() ?? r.state) as TournamentState | null) ?? null;
      const live = (st?.payments ?? []).filter((p) => !p.refunded);
      return {
        id: r.id,
        name: r.name,
        status: (st?.status ?? r.status) as TournamentState['status'],
        entries: live.filter((p) => p.kind === 'turnaj_buyin').length,
        gross: live.reduce((a, p) => a + p.cost + p.fee, 0),
        pool: live.reduce((a, p) => a + poolPart(p), 0),
        fees: live.reduce((a, p) => a + p.fee, 0),
        houseCut: live.reduce((a, p) => a + (p.house ?? 0), 0),
        fund: live.reduce((a, p) => a + (p.fund ?? 0), 0),
        overlay: st?.overlay ?? 0,
        bounty: live.reduce((a, p) => a + (p.bounty ?? 0), 0),
        paidOut: (st?.results ?? []).reduce((a, x) => a + x.payout, 0),
        createdAt: r.createdAt.getTime(),
      };
    });
    const fundIds = new Set<string>(['sezona', 'jackpot']);
    fundIds.add(String(this.deps.settings.resolve()['rake.jackpotFundId'] || 'jackpot'));
    for (const r of rows) for (const p of ((r.state as TournamentState | null)?.payments ?? [])) if (p.fundId) fundIds.add(p.fundId);
    return {
      house: this.deps.ledger.balance(accounts.house()),
      funds: [...fundIds].map((id) => ({ id, balance: this.deps.ledger.balance(accounts.fund(id)) })),
      tournaments: list.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
    };
  }

  /** Ukončené turnaje se po čase uvolní z paměti (zůstávají v DB). */
  sweep(olderThanMs: number): void {
    const now = this.deps.clock.now();
    for (const [id, t] of this.tours) {
      const st = t.state();
      if ((st.status === 'finished' || st.status === 'cancelled') && st.finishedAt !== null && now - st.finishedAt > olderThanMs) this.archive(id);
    }
  }
}

export interface FinanceOverview {
  house: number;
  funds: { id: string; balance: number }[];
  tournaments: { id: string; name: string; status: TournamentState['status']; entries: number; gross: number; pool: number; fees: number; houseCut: number; fund: number; overlay: number; bounty: number; paidOut: number; createdAt: number }[];
}

export interface Fees {
  fee: number;
  houseCutPercent: number;
  fundPercent: number;
  fundId: string;
  guarantee: number;
  /** Zatím vybráno: do poolu, domu (poplatky + odvod), do fondu. */
  collected: { pool: number; house: number; fund: number };
  /** Kolik doplatila garance (po skončení turnaje). */
  overlay: number;
}

function feesOf(s: SettingValues, st?: TournamentState): Fees {
  const live = (st?.payments ?? []).filter((p) => !p.refunded);
  return {
    fee: Number(s['tournament.fee']),
    houseCutPercent: Number(s['tournament.houseCutPercent']),
    fundPercent: Number(s['tournament.fundPercent']),
    fundId: String(s['tournament.fundId']),
    guarantee: Number(s['tournament.guarantee']),
    collected: {
      pool: live.reduce((a, p) => a + poolPart(p), 0),
      house: live.reduce((a, p) => a + p.fee + (p.house ?? 0), 0),
      fund: live.reduce((a, p) => a + (p.fund ?? 0), 0),
    },
    overlay: st?.overlay ?? 0,
  };
}

export interface TournamentSummary {
  id: string;
  name: string;
  owner: string | null;
  ownerId: string | null;
  status: TournamentState['status'];
  players: number;
  alive: number;
  seats: number;
  buyIn: number;
  fee: number;
  startingStack: number;
  live: boolean;
  /** Plánovaný start (epoch ms) u turnaje s plánem, jinak null. */
  startAt: number | null;
  createdAt: number;
}

export interface TournamentView {
  id: string;
  name: string;
  owner: string | null;
  ownerId: string | null;
  status: TournamentState['status'];
  paused: boolean;
  onBreak: boolean;
  startedAt: number | null;
  serverTime: number;
  buyIn: number;
  fee: number;
  startingStack: number;
  seats: number;
  minPlayers: number;
  players: number;
  alive: number;
  bubble: boolean;
  levelNumber: number;
  level: { smallBlind: number; bigBlind: number; ante: number } | null;
  nextLevel: { smallBlind: number; bigBlind: number; ante: number } | null;
  levels: { smallBlind: number; bigBlind: number; ante: number }[];
  levelMode: string;
  levelMinutes: number;
  levelHands: number;
  handsInLevel: number;
  clockKind: 'level' | 'break' | null;
  clockMs: number | null;
  lateRegLevels: number;
  lateRegOpen: boolean;
  rebuy: { enabled: boolean; untilLevel: number; cost: number; chips: number; max: number };
  addon: { enabled: boolean; fromLevel: number; untilLevel: number; cost: number; chips: number };
  reentry: { enabled: boolean; max: number };
  breakEveryLevels: number;
  breakMinutes: number;
  prizePool: number;
  /** Průhlednost: kam jdou peníze ze vstupů. */
  fees: Fees;
  payouts: { place: number; amount: number }[];
  payoutPreset: string;
  /** Plánování: kdy turnaj začíná, od kdy je registrace, do kdy se lze odhlásit. */
  schedule: { startAt: number; opensAt: number; registrationOpen: boolean; postponed: number; seriesId: string | null; unregisterUntil: number; autoPaused: boolean; invited: string[] | null } | null;
  /** Dohoda: povolená, probíhá hlasování, uzavřená; proč ji nejde navrhnout. */
  deal: { enabled: boolean; open: boolean; done: { method: string; keep: number } | null; blocked: string | null };
  /** Bounty: typ, podíl z buy-inu, zůstatek na účtu bounty (hlavy hráčů a nevyplacené odměny). */
  bounty: { type: string; percent: number; pkoCash: number; payout: string; bank: number };
  standings: { userId: string; name: string; chips: number | null; seat: number | null; tableNo: number | null; place: number; status: string; payout: number | null; head: number | null; bounty: number }[];
  /** Živá hra: žetony v oběhu, průměrný stack a zda smí uživatel zapisovat za hráče; jinak null. */
  live: { chipsInPlay: number; avgStack: number | null; director: boolean; suggestions: { userId: string; name: string; fromNo: number; toTable: string; toNo: number; reason: 'balance' | 'break' }[] } | null;
  /** Stoly turnaje a hráči u nich (u živého turnaje a před startem prázdné). */
  tables: { id: string; no: number; players: { userId: string; name: string; seat: number; chips: number }[] }[];
  maxTables: number;
  results: { userId: string; name: string; place: number; payout: number; bounty?: number }[] | null;
  /** Po konci turnaje: pro každého hráče vstupy, rebuy, add-ony, zaplaceno, výhra a zisk. */
  summary: ReturnType<typeof resultSummary>[] | null;
  pending: Record<string, SettingValue>;
  me: {
    registered: boolean;
    status: string | null;
    entries: number;
    rebuys: number;
    addon: boolean;
    decideUntil: number | null;
    /** Stůl, u kterého hráč sedí (u turnaje na více stolech). */
    tableId: string | null;
    canRegister: boolean;
    canUnregister: boolean;
    canRebuy: boolean;
    canAddon: boolean;
    addonOfferUntil: number | null;
    canReenter: boolean;
  };
  can: { manage: boolean; start: boolean; pause: boolean; cancel: boolean };
}

/** Přehled jednoho hráče po konci turnaje: kolikrát vstoupil, rebuy, add-on, kolik zaplatil, kolik dostal a zisk. */
export function resultSummary(st: Pick<TournamentState, 'payments' | 'players'>, r: { userId: string; name: string; place: number; payout: number; bounty?: number }) {
  const mine = st.payments.filter((p) => p.userId === r.userId && !p.refunded);
  const count = (kind: 'turnaj_buyin' | 'turnaj_rebuy' | 'turnaj_addon') => mine.filter((p) => p.kind === kind).length;
  const spent = mine.reduce((n, p) => n + p.cost + p.fee, 0);
  const bounty = r.bounty ?? 0;
  return { userId: r.userId, name: r.name, place: r.place, entries: count('turnaj_buyin'), rebuys: count('turnaj_rebuy'), addons: count('turnaj_addon'), spent, payout: r.payout, bounty, profit: r.payout + bounty - spent };
}
