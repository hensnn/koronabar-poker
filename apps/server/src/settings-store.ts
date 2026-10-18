import type { SettingDef } from '@kb/shared';
import { and, eq } from 'drizzle-orm';
import {
  decideChange,
  resolveSettings,
  scopeAllowed,
  validateValues,
  type ChangeContext,
  type Layer,
  type PermissionChecker,
  type Scope,
  type SettingValue,
  type SettingValues,
  type SettingsRegistry,
  type ValidationIssue,
} from '@kb/shared';
import type { AuditService, AuditSource } from './auth/audit.js';
import { schema, type Db } from './db/index.js';

export class SettingsError extends Error {
  constructor(
    public readonly code: 'FORBIDDEN' | 'UNKNOWN_KEY' | 'SCOPE_NOT_ALLOWED' | 'INVALID' | 'DENIED',
    public readonly issues: ValidationIssue[] = [],
    public readonly reasonKey?: string,
  ) {
    super(code);
  }
}

/**
 * Hodnota z jsonb sloupce přijde podle ovladače někdy „dvakrát rozparsovaná“ (text „[1,2]“ jako pole, „12“ jako číslo).
 * Podle definice parametru se vrátí do správného typu, aby validace neodmítla celé nastavení.
 */
function coerce(def: SettingDef | undefined, raw: unknown): SettingValue {
  if (!def) return raw as SettingValue;
  if (def.type === 'string' || def.type === 'color') return typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (def.type === 'int') return typeof raw === 'number' ? raw : Number.isFinite(Number(raw)) ? Number(raw) : (raw as SettingValue);
  if (def.type === 'bool') return typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : (raw as SettingValue);
  return raw as SettingValue;
}

type Listener = (scope: Scope, scopeId: string, key: string, value: SettingValue | undefined) => void;

/**
 * Uložená nastavení po vrstvách (globální, šablona, hra/stůl, hráč, zařízení). Hodnoty jsou v paměti
 * (čtou se často) a každá změna se zapisuje do DB a do audit logu. Hráčova nastavení se po změně
 * rozešlou na jeho další zařízení přes `onChange`.
 */
export class SettingsStore {
  private layers = new Map<string, Partial<SettingValues>>();
  private listeners = new Set<Listener>();

  constructor(
    private db: Db,
    private registry: SettingsRegistry,
    private audit: AuditService,
    private perms: PermissionChecker,
  ) {}

  private k = (scope: Scope, scopeId: string) => `${scope}:${scopeId}`;

  async load(): Promise<void> {
    const rows = await this.db.select().from(schema.settingsValues);
    this.layers = new Map();
    for (const r of rows) {
      // Hodnota parametru, který už neexistuje (zrušená definice), se ignoruje; jinak by blokovala každé další uložení.
      if (!this.registry.get(r.key)) continue;
      const key = this.k(r.scopeType as Scope, r.scopeId);
      const layer = this.layers.get(key) ?? {};
      layer[r.key] = coerce(this.registry.get(r.key), r.value);
      this.layers.set(key, layer);
    }
  }

  /** Nastaví vrstvu přímo v paměti bez zápisu a auditu (testy, vývoj). */
  preset(scope: Scope, scopeId: string, values: Partial<SettingValues>): void {
    this.layers.set(this.k(scope, scopeId), { ...(this.layers.get(this.k(scope, scopeId)) ?? {}), ...values });
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  layer(scope: Scope, scopeId = ''): Partial<SettingValues> {
    return { ...(this.layers.get(this.k(scope, scopeId)) ?? {}) };
  }

  /** Efektivní hodnoty: výchozí → globální → šablona → hra → stůl → hráč → zařízení. */
  resolve(extra: Layer[] = []): SettingValues {
    const layers: Layer[] = [{ scope: 'global', values: this.layer('global') }, ...extra];
    return resolveSettings(this.registry, layers).values;
  }

  /** Změna hodnoty v dané vrstvě. Hráč smí měnit jen své osobní vrstvy, ostatní vyžadují oprávnění. */
  async set(
    actorId: string,
    scope: Scope,
    scopeId: string,
    key: string,
    value: SettingValue,
    opts: { change?: ChangeContext; meta?: { ip?: string | null; source?: AuditSource; reason?: string | null } } = {},
  ): Promise<void> {
    const def = this.registry.get(key);
    if (!def) throw new SettingsError('UNKNOWN_KEY');
    if (!scopeAllowed(def.scopes, scope)) throw new SettingsError('SCOPE_NOT_ALLOWED');
    this.authorize(actorId, scope, scopeId, key);
    const known = Object.fromEntries(Object.entries(this.layer(scope, scopeId)).filter(([k]) => this.registry.get(k)));
    const issues = validateValues(this.registry, { ...known, [key]: value });
    // Kontrola konzistence se týká složených hodnot (výchozí + vrstva); chyby u jiných klíčů se nehlásí.
    const mine = issues.filter((i) => i.keys.includes(key) || i.messageKey.startsWith('validation.'));
    if (mine.length) throw new SettingsError('INVALID', mine);
    if (opts.change) {
      const d = decideChange(this.registry, key, opts.change);
      if (d.result === 'denied') throw new SettingsError('DENIED', [], d.reasonKey);
    }
    const before = this.layers.get(this.k(scope, scopeId))?.[key];
    await this.db
      .insert(schema.settingsValues)
      .values({ scopeType: scope, scopeId, key, value, updatedBy: actorId })
      .onConflictDoUpdate({ target: [schema.settingsValues.scopeType, schema.settingsValues.scopeId, schema.settingsValues.key], set: { value, updatedBy: actorId, updatedAt: new Date() } });
    const layer = this.layers.get(this.k(scope, scopeId)) ?? {};
    layer[key] = value;
    this.layers.set(this.k(scope, scopeId), layer);
    await this.audit.log({ actorId, action: 'nastaveni.zmena', targetType: scope, targetId: scopeId, before: { [key]: before }, after: { [key]: value }, ...opts.meta });
    for (const l of this.listeners) l(scope, scopeId, key, value);
  }

  /** Vrácení na zděděnou hodnotu (smazání z vrstvy). */
  async reset(actorId: string, scope: Scope, scopeId: string, key: string, meta: { ip?: string | null; source?: AuditSource } = {}): Promise<void> {
    if (!this.registry.get(key)) throw new SettingsError('UNKNOWN_KEY');
    this.authorize(actorId, scope, scopeId, key);
    const before = this.layers.get(this.k(scope, scopeId))?.[key];
    await this.db.delete(schema.settingsValues).where(and(eq(schema.settingsValues.scopeType, scope), eq(schema.settingsValues.scopeId, scopeId), eq(schema.settingsValues.key, key)));
    const layer = this.layers.get(this.k(scope, scopeId));
    if (layer) delete layer[key];
    await this.audit.log({ actorId, action: 'nastaveni.reset', targetType: scope, targetId: scopeId, before: { [key]: before }, ...meta });
    for (const l of this.listeners) l(scope, scopeId, key, undefined);
  }

  private authorize(actorId: string, scope: Scope, scopeId: string, key: string): void {
    if (scope === 'user' || scope === 'userDevice') {
      // Osobní nastavení smí měnit jen vlastník (scopeId = id uživatele, u zařízení `id:zařízení`).
      if (scopeId.split(':')[0] !== actorId) throw new SettingsError('FORBIDDEN');
      return;
    }
    const def = this.registry.get(key);
    if (scope === 'global') {
      if (!this.perms.can(actorId, 'nastaveni.globalni').allowed) throw new SettingsError('FORBIDDEN');
      return;
    }
    if (def?.mutability === 'adminOnly' && !this.perms.can(actorId, 'nastaveni.globalni').allowed) throw new SettingsError('FORBIDDEN');
    if (!this.perms.can(actorId, 'nastaveni.hra.upravit', { scopeType: 'table', scopeId }).allowed) throw new SettingsError('FORBIDDEN');
  }
}
