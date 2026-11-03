import type { SettingDef } from '@kb/shared';
import { and, eq } from 'drizzle-orm';
import {
  crossIssues,
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

/**
 * Hodnota z DB mimo povolený rozsah (definice se mezitím zpřísnila, ruční zásah do DB): číslo se ořízne na min/max,
 * ostatní typy se zahodí (platí zděděná hodnota). Vrací `undefined`, když se hodnota má zahodit.
 */
function clampLoaded(reg: SettingsRegistry, def: SettingDef, value: SettingValue): SettingValue | undefined {
  if (reg.schemaFor(def).safeParse(value).success) return value;
  if (def.type === 'int' && typeof value === 'number' && Number.isFinite(value)) {
    const clamped = Math.min(def.max, Math.max(def.min, Math.round(value)));
    return reg.schemaFor(def).safeParse(clamped).success ? clamped : undefined;
  }
  if (def.type === 'string' && typeof value === 'string') return value.slice(0, def.maxLength ?? 200);
  return undefined;
}

const EMPTY_LAYER: Readonly<Partial<SettingValues>> = Object.freeze({});

type Listener = (scope: Scope, scopeId: string, key: string, value: SettingValue | undefined) => void;

/**
 * Uložená nastavení po vrstvách (globální, šablona, stůl, hráč, zařízení). Hodnoty jsou v paměti
 * (čtou se často) a každá změna se zapisuje do DB a do audit logu. Hráčova nastavení se po změně
 * rozešlou na jeho další zařízení přes `onChange`.
 *
 * Objekty vrstev se při změně nahrazují novými (copy-on-write): `resolveSettings` si podle jejich identity
 * pamatuje výsledek, takže opakované čtení efektivních hodnot stojí jen kopii výsledku.
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

  /** Načte vrstvy z DB. Hodnoty mimo rozsah se oříznou nebo zahodí a zapíšou do logu (nesmí shodit start ani blokovat ukládání). */
  async load(): Promise<void> {
    const rows = await this.db.select().from(schema.settingsValues);
    const layers = new Map<string, Partial<SettingValues>>();
    for (const r of rows) {
      // Hodnota parametru, který už neexistuje (zrušená definice), se ignoruje; jinak by blokovala každé další uložení.
      const def = this.registry.get(r.key);
      if (!def) continue;
      const raw = coerce(def, r.value);
      const value = clampLoaded(this.registry, def, raw);
      if (value === undefined) {
        console.warn(`Nastavení ${r.scopeType}:${r.scopeId} ${r.key}: hodnota ${JSON.stringify(raw)} je neplatná, použije se zděděná hodnota.`);
        continue;
      }
      if (value !== raw) console.warn(`Nastavení ${r.scopeType}:${r.scopeId} ${r.key}: hodnota ${JSON.stringify(raw)} je mimo rozsah, oříznuta na ${JSON.stringify(value)}.`);
      const key = this.k(r.scopeType as Scope, r.scopeId);
      const layer = layers.get(key) ?? {};
      layer[r.key] = value;
      layers.set(key, layer);
    }
    this.layers = layers;
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

  /** Vnitřní (sdílený) objekt vrstvy pro resolve: stabilní identita, dokud se vrstva nezmění. */
  private stored(scope: Scope, scopeId = ''): Partial<SettingValues> {
    return this.layers.get(this.k(scope, scopeId)) ?? (EMPTY_LAYER as Partial<SettingValues>);
  }

  /** Efektivní hodnoty: výchozí → globální → šablona → stůl → hráč → zařízení. Vrací novou kopii. */
  resolve(extra: Layer[] = []): SettingValues {
    const layers: Layer[] = [{ scope: 'global', values: this.stored('global') }, ...extra];
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
    // Herní parametry se globálně nenastavují (šablony jsou úplné, hodnota by se u her neprojevila); formulář je nenabízí.
    if (scope === 'global' && def.globalHidden) throw new SettingsError('SCOPE_NOT_ALLOWED');
    this.authorize(actorId, scope, scopeId, key);
    if ((scope === 'user' || scope === 'userDevice') && def.userChoiceDependsOn) {
      // Osobní volba, kterou správce může zakázat (např. vlastní hlas hlasatele): rozhoduje efektivní globální hodnota.
      const dep = def.userChoiceDependsOn;
      const g = this.resolve()[dep.key];
      const allowed = dep.equals !== undefined ? g === dep.equals : dep.truthy ? Boolean(g) : true;
      if (!allowed) throw new SettingsError('DENIED', [], 'change.denied.lockedByAdmin');
    }
    // Samotná hodnota podle schématu (rozsah, typ); pravidla konzistence (`rule.*`) se hodnotí níže proti efektivním hodnotám.
    const own = validateValues(this.registry, { [key]: value }).filter((i) => i.messageKey.startsWith('validation.'));
    if (own.length) throw new SettingsError('INVALID', own);
    // Konzistence se kontroluje proti efektivním hodnotám vrstvy (ne proti výchozím): globální vrstva nad výchozími,
    // ostatní vrstvy nad globální. Hlásí se jen pravidla, kterých se měněný klíč týká.
    const effective = scope === 'global' ? this.resolve() : this.resolve([{ scope, scopeId, values: this.stored(scope, scopeId) }]);
    const issues = crossIssues(this.registry, { ...effective, [key]: value }).filter((i) => i.keys.includes(key));    if (issues.length) throw new SettingsError('INVALID', issues);
    if (opts.change) {
      const d = decideChange(this.registry, key, opts.change);
      if (d.result === 'denied') throw new SettingsError('DENIED', [], d.reasonKey);
    }
    const before = this.layers.get(this.k(scope, scopeId))?.[key];
    await this.db
      .insert(schema.settingsValues)
      .values({ scopeType: scope, scopeId, key, value, updatedBy: actorId })
      .onConflictDoUpdate({ target: [schema.settingsValues.scopeType, schema.settingsValues.scopeId, schema.settingsValues.key], set: { value, updatedBy: actorId, updatedAt: new Date() } });
    this.layers.set(this.k(scope, scopeId), { ...(this.layers.get(this.k(scope, scopeId)) ?? {}), [key]: value });
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
    if (layer) {
      const { [key]: _gone, ...rest } = layer;
      this.layers.set(this.k(scope, scopeId), rest);
    }
    await this.audit.log({ actorId, action: 'nastaveni.reset', targetType: scope, targetId: scopeId, before: { [key]: before }, ...meta });
    for (const l of this.listeners) l(scope, scopeId, key, undefined);
  }

  /** Odstraní všechny osobní vrstvy hráče (účet i zařízení), např. při anonymizaci účtu. Bez auditu po klíčích; volající loguje celek. */
  async dropUserLayers(userId: string): Promise<number> {
    const rows = await this.db
      .delete(schema.settingsValues)
      .where(and(eq(schema.settingsValues.scopeType, 'user'), eq(schema.settingsValues.scopeId, userId)))
      .returning({ key: schema.settingsValues.key });
    const deviceRows = await this.db.select({ scopeId: schema.settingsValues.scopeId }).from(schema.settingsValues).where(eq(schema.settingsValues.scopeType, 'userDevice'));
    const devices = [...new Set(deviceRows.map((r) => r.scopeId).filter((id) => id.split(':')[0] === userId))];
    for (const id of devices) await this.db.delete(schema.settingsValues).where(and(eq(schema.settingsValues.scopeType, 'userDevice'), eq(schema.settingsValues.scopeId, id)));
    this.layers.delete(this.k('user', userId));
    for (const id of devices) this.layers.delete(this.k('userDevice', id));
    for (const key of [...this.layers.keys()]) if (key.startsWith('userDevice:') && key.slice('userDevice:'.length).split(':')[0] === userId) this.layers.delete(key);
    return rows.length + devices.length;
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
