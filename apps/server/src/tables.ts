import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { CashService } from '@kb/ledger';
import { TableActor, type Clock, type PersistedTable, type TableEvent } from '@kb/game-core';
import {
  builtinTemplates,
  decideChange,
  scopeAllowed,
  validateValues,
  type PermissionChecker,
  type SettingValue,
  type SettingValues,
  type SettingsRegistry,
  type ValidationIssue,
} from '@kb/shared';
import type { AuditService, AuditSource } from './auth/audit.js';
import { PermissionError } from './auth/permissions.js';
import { schema, type Db } from './db/index.js';
import { Journal, loadTableState, tableStateOp } from './db/journal.js';
import type { SettingsStore } from './settings-store.js';

export interface TableRow {
  id: string;
  name: string;
  kind: string;
  ownerId: string | null;
  templateId: string | null;
  settings: Record<string, unknown>;
  status: string;
}

export class TableError extends Error {
  constructor(
    public readonly code: 'INVALID' | 'NOT_FOUND' | 'FORBIDDEN' | 'LIMIT_EXCEEDED' | 'DENIED',
    public readonly issues: ValidationIssue[] = [],
    public readonly params?: Record<string, unknown>,
  ) {
    super(code);
  }
}

interface Deps {
  db: Db;
  journal: Journal;
  registry: SettingsRegistry;
  settings: SettingsStore;
  cash: CashService;
  clock: Clock;
  onChange: (tableId: string) => void;
  perms?: PermissionChecker;
  audit?: AuditService;
  onEvent?: (tableId: string, e: TableEvent) => void;
  /** Stůl vznikl nebo se obnovil (např. založení chatového kanálu). */
  onSpawn?: (row: TableRow) => void;
  /** Změna nastavení stolu (`pending` = použije se od další handy, jinak platí hned). */
  onSettingsChanged?: (tableId: string, changes: Record<string, SettingValue>, pending: boolean) => void;
}

type Meta = { ip?: string | null; source?: AuditSource; reason?: string | null };

/**
 * Správa stolů: záznam v DB (`game_tables`), běžící instance (`TableActor`) a její uložený stav.
 * Nastavení stolu = globální → šablona → vrstva stolu (přepsání uložená u stolu).
 */
export class TableManager {
  readonly actors = new Map<string, TableActor>();
  private rows = new Map<string, TableRow>();
  /** Změny čekající na konec handy (parametry „jen mezi handami“). */
  private pending = new Map<string, Record<string, SettingValue>>();

  constructor(private deps: Deps) {}

  private resolve(row: TableRow): SettingValues {
    const template = builtinTemplates(this.deps.registry).find((t) => t.id === row.templateId);
    return this.deps.settings.resolve([
      ...(template ? [{ scope: 'template' as const, values: template.values }] : []),
      { scope: 'table', values: row.settings as Record<string, SettingValue> },
    ]);
  }

  settingsOf(id: string): SettingValues | undefined {
    const row = this.rows.get(id);
    return row ? this.resolve(row) : undefined;
  }

  private spawn(row: TableRow, restore?: PersistedTable): TableActor {
    this.rows.set(row.id, row);
    const settings = () => this.resolve(this.rows.get(row.id)!);
    const actor = new TableActor({
      tableId: row.id,
      settings,
      clock: this.deps.clock,
      cash: this.deps.cash,
      chipsPerCurrencyUnit: Number(settings()['cash.chipsPerCurrencyUnit']),
      persist: (snap) => this.deps.journal.push(`table:${row.id}`, tableStateOp(row.id, snap)),
      onChange: () => this.deps.onChange(row.id),
      onEvent: (e) => {
        if (e.type === 'handEnd') void this.applyPending(row.id);
        this.deps.onEvent?.(row.id, e);
      },
      restore,
    });
    this.actors.set(row.id, actor);
    this.deps.onSpawn?.(row);
    return actor;
  }

  /** Při startu: všechny otevřené stoly se obnoví z DB (rozehraná handa se vrací na poslední předěl). */
  async load(): Promise<void> {
    const rows = await this.deps.db.select().from(schema.gameTables).where(eq(schema.gameTables.status, 'open'));
    for (const r of rows) {
      const snap = (await loadTableState(this.deps.db, r.id)) as PersistedTable | undefined;
      this.spawn({ ...r, settings: r.settings ?? {} }, snap);
    }
  }

  /** Vytvoření stolu bez kontrol oprávnění (první start, import). */
  async create(input: { id: string; name: string; ownerId?: string | null; templateId?: string | null; settings?: Record<string, unknown> }): Promise<TableActor> {
    const [row] = await this.deps.db
      .insert(schema.gameTables)
      .values({ id: input.id, name: input.name, ownerId: input.ownerId ?? null, templateId: input.templateId ?? null, settings: input.settings ?? {}, status: 'open' })
      .returning();
    return this.spawn({ ...row!, settings: row!.settings ?? {} });
  }

  list(): TableRow[] {
    return [...this.rows.values()];
  }
  get(id: string): TableActor | undefined {
    return this.actors.get(id);
  }
  row(id: string): TableRow | undefined {
    return this.rows.get(id);
  }

  // ---------- lobby: zakládání a úprava s oprávněními ----------

  private can(userId: string, key: string, ctx = {}) {
    if (!this.deps.perms) throw new Error('TableManager nemá službu oprávnění');
    return this.deps.perms.can(userId, key, ctx);
  }

  /** Jen parametry, které smí přepsat vrstva stolu, a platné hodnoty. */
  private checkSettings(templateId: string | null, values: Record<string, unknown>): { clean: Record<string, SettingValue>; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];
    const clean: Record<string, SettingValue> = {};
    for (const [k, v] of Object.entries(values)) {
      const def = this.deps.registry.get(k);
      if (!def || !scopeAllowed(def.scopes, 'table') || def.secret) {
        issues.push({ keys: [k], messageKey: 'validation.unknownKey', params: { key: k } });
        continue;
      }
      clean[k] = v as SettingValue;
    }
    if (issues.length) return { clean, issues };
    const template = builtinTemplates(this.deps.registry).find((t) => t.id === templateId);
    issues.push(...validateValues(this.deps.registry, { ...(template?.values ?? {}), ...clean }));
    return { clean, issues };
  }

  async createTable(actorId: string, input: { name: string; templateId: string; settings?: Record<string, unknown> }, meta: Meta = {}): Promise<{ id: string }> {
    const d = this.can(actorId, 'cash.vytvorit_vlastni');
    if (!d.allowed) throw new TableError('FORBIDDEN');
    const name = input.name?.trim() ?? '';
    if (name.length < 2 || name.length > 60) throw new TableError('INVALID', [{ keys: ['name'], messageKey: 'lobby.invalidName' }]);
    const template = builtinTemplates(this.deps.registry).find((t) => t.id === input.templateId && t.kind === 'cash');
    if (!template) throw new TableError('INVALID', [{ keys: ['templateId'], messageKey: 'lobby.unknownTemplate' }]);
    const { clean, issues } = this.checkSettings(template.id, input.settings ?? {});
    if (issues.length) throw new TableError('INVALID', issues);

    // Limity z oprávnění: počet současných stolů a největší buy-in.
    const mine = this.list().filter((r) => r.ownerId === actorId).length;
    if (d.limits?.maxConcurrent !== undefined && mine >= d.limits.maxConcurrent) throw new TableError('LIMIT_EXCEEDED', [], { limit: 'maxConcurrent', value: d.limits.maxConcurrent });
    const merged = this.deps.settings.resolve([{ scope: 'template', values: template.values }, { scope: 'table', values: clean }]);
    const maxBuyIn = (Number(merged['cash.maxBuyInBb']) * Number(merged['table.bigBlind'])) / Number(merged['cash.chipsPerCurrencyUnit']);
    if (d.limits?.maxBuyIn !== undefined && maxBuyIn > d.limits.maxBuyIn) throw new TableError('LIMIT_EXCEEDED', [], { limit: 'maxBuyIn', value: d.limits.maxBuyIn });

    const id = `${name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'stul'}-${randomBytes(3).toString('hex')}`;
    await this.create({ id, name, ownerId: actorId, templateId: template.id, settings: clean });
    await this.deps.audit?.log({ actorId, action: 'stul.vytvorit', targetType: 'table', targetId: id, after: { name, templateId: template.id, settings: clean }, ...meta });
    return { id };
  }

  private canEdit(actorId: string, row: TableRow): boolean {
    if (this.can(actorId, 'cash.upravit_vse').allowed) return true;
    return row.ownerId === actorId && this.can(actorId, 'cash.upravit_vlastni').allowed;
  }

  /** Náhled změny nastavení stolu bez provedení: kdy by se projevila, nebo proč nejde. */
  previewSettings(actorId: string, tableId: string, changes: Record<string, unknown>): { before: SettingValues; clean: Record<string, SettingValue>; rows: { key: string; timing: 'now' | 'nextHand' | 'denied'; reasonKey?: string }[] } {
    const row = this.rows.get(tableId);
    const actor = this.actors.get(tableId);
    if (!row || !actor) throw new TableError('NOT_FOUND');
    if (!this.canEdit(actorId, row)) throw new TableError('FORBIDDEN');
    const { clean, issues } = this.checkSettings(row.templateId, { ...row.settings, ...changes });
    if (issues.length) throw new TableError('INVALID', issues);
    const ctx = { gameStarted: actor.hasStarted(), handInProgress: actor.handInProgress(), isAdmin: this.can(actorId, 'nastaveni.globalni').allowed };
    const rows = Object.keys(changes).map((key) => {
      const dec = decideChange(this.deps.registry, key, ctx);
      return dec.result === 'denied' ? { key, timing: 'denied' as const, reasonKey: dec.reasonKey } : { key, timing: dec.result === 'pending' ? ('nextHand' as const) : ('now' as const) };
    });
    return { before: this.settingsOf(tableId) ?? {}, clean: clean as Record<string, SettingValue>, rows };
  }

  /** Změna nastavení stolu. Parametry se řídí příznakem „kdy lze měnit“ (hned / od další handy / jen před startem). */
  async updateSettings(actorId: string, tableId: string, changes: Record<string, unknown>, meta: Meta = {}): Promise<{ applied: string[]; pending: string[] }> {
    const row = this.rows.get(tableId);
    const actor = this.actors.get(tableId);
    if (!row || !actor) throw new TableError('NOT_FOUND');
    if (!this.canEdit(actorId, row)) throw new TableError('FORBIDDEN');
    const { clean, issues } = this.checkSettings(row.templateId, { ...row.settings, ...changes });
    if (issues.length) throw new TableError('INVALID', issues);
    const isAdmin = this.can(actorId, 'nastaveni.globalni').allowed;
    const ctx = { gameStarted: actor.hasStarted(), handInProgress: actor.handInProgress(), isAdmin };
    const applied: string[] = [];
    const queued: string[] = [];
    const now: Record<string, SettingValue> = {};
    const later: Record<string, SettingValue> = {};
    for (const [k, v] of Object.entries(changes)) {
      const dec = decideChange(this.deps.registry, k, ctx);
      if (dec.result === 'denied') throw new TableError('DENIED', [{ keys: [k], messageKey: dec.reasonKey }]);
      if (dec.result === 'pending') later[k] = clean[k]!;
      else now[k] = clean[k]!;
      void v;
    }
    const before = { ...row.settings };
    if (Object.keys(now).length) {
      row.settings = { ...row.settings, ...now };
      await this.deps.db.update(schema.gameTables).set({ settings: row.settings }).where(eq(schema.gameTables.id, tableId));
      applied.push(...Object.keys(now));
    }
    if (Object.keys(later).length) {
      this.pending.set(tableId, { ...(this.pending.get(tableId) ?? {}), ...later });
      queued.push(...Object.keys(later));
    }
    await this.deps.audit?.log({ actorId, action: 'nastaveni.zmena', targetType: 'table', targetId: tableId, before, after: { applied: now, pending: later }, ...meta });
    this.deps.onChange(tableId);
    if (applied.length) this.deps.onSettingsChanged?.(tableId, now, false);
    if (queued.length) this.deps.onSettingsChanged?.(tableId, later, true);
    return { applied, pending: queued };
  }

  private async applyPending(tableId: string): Promise<void> {
    const later = this.pending.get(tableId);
    const row = this.rows.get(tableId);
    if (!later || !row) return;
    this.pending.delete(tableId);
    row.settings = { ...row.settings, ...later };
    await this.deps.db.update(schema.gameTables).set({ settings: row.settings }).where(eq(schema.gameTables.id, tableId));
    this.deps.onChange(tableId);
    this.deps.onSettingsChanged?.(tableId, later, false);
  }

  /** Podrobnosti pro okno úprav: efektivní hodnoty, přepsání, čekající změny a stav hry. */
  details(tableId: string) {
    const row = this.rows.get(tableId);
    const actor = this.actors.get(tableId);
    if (!row || !actor) return undefined;
    return {
      id: row.id,
      name: row.name,
      ownerId: row.ownerId,
      templateId: row.templateId,
      values: this.resolve(row),
      overrides: row.settings,
      pending: this.pending.get(tableId) ?? {},
      started: actor.hasStarted(),
      handInProgress: actor.handInProgress(),
    };
  }

  pendingChanges(tableId: string): Record<string, SettingValue> {
    return { ...(this.pending.get(tableId) ?? {}) };
  }

  /** Zrušení stolu zakladatelem nebo správcem; hráčům se vrátí žetony. */
  async closeTable(actorId: string, tableId: string, meta: Meta = {}): Promise<void> {
    const row = this.rows.get(tableId);
    if (!row) throw new TableError('NOT_FOUND');
    const own = row.ownerId === actorId && this.can(actorId, 'cash.zrusit_vlastni').allowed;
    if (!own && !this.can(actorId, 'cash.zrusit_vse').allowed) throw new TableError('FORBIDDEN');
    await this.close(tableId);
    await this.deps.audit?.log({ actorId, action: 'stul.zrusit', targetType: 'table', targetId: tableId, ...meta });
  }

  /** Přehled pro lobby. */
  async lobby() {
    const owners = await this.deps.db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users);
    const nick = new Map(owners.map((o) => [o.id, o.nickname]));
    return this.list().map((r) => {
      const s = this.resolve(r);
      const actor = this.actors.get(r.id)!;
      const seated = actor.playersSeated().length;
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        templateId: r.templateId,
        owner: r.ownerId ? (nick.get(r.ownerId) ?? null) : null,
        ownerId: r.ownerId,
        seats: Number(s['table.seats']),
        seated,
        smallBlind: Number(s['table.smallBlind']),
        bigBlind: Number(s['table.bigBlind']),
        minBuyInBb: Number(s['cash.minBuyInBb']),
        maxBuyInBb: Number(s['cash.maxBuyInBb']),
        straddle: s['table.straddleEnabled'] ? (s['table.straddleMandatory'] ? 'mandatory' : 'optional') : 'off',
        bbAnte: !!s['table.bbAnte'],
        ante: Number(s['table.ante']),
        turnSeconds: Number(s['time.turnSeconds']),
        rakePercent: s['rake.enabled'] ? Number(s['rake.percent']) : 0,
        rakeCap: s['rake.enabled'] ? Number(s['rake.cap']) : 0,
        jackpot: s['jackpot.royalFlushEnabled'] || s['jackpot.badBeatEnabled'] ? this.deps.cash.fundBalance(String(s['rake.jackpotFundId'] || 'jackpot')) : null,
        playing: actor.handInProgress(),
      };
    });
  }

  /** Zruší stůl: hráčům se vrátí žetony do peněženek a stůl se označí jako uzavřený. */
  async close(id: string): Promise<void> {
    const actor = this.actors.get(id);
    if (!actor) return;
    actor.close();
    this.actors.delete(id);
    this.rows.delete(id);
    this.pending.delete(id);
    await this.deps.db.update(schema.gameTables).set({ status: 'closed' }).where(eq(schema.gameTables.id, id));
    this.deps.journal.push(`table:${id}`, tableStateOp(id, { seats: [], recentLeaves: [] }));
  }
}

export { PermissionError };
