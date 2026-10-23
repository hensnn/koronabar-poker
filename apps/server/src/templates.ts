import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { builtinTemplates, fillTemplate, RETIRED_SETTING_KEYS, scopeAllowed, validateValues, type PermissionChecker, type SettingsRegistry, type SettingsTemplate, type SettingValue, type SettingValues, type TemplateKind, type ValidationIssue } from '@kb/shared';
import type { AuditService, AuditSource } from './auth/audit.js';
import { schema, type Db } from './db/index.js';

export class TemplateError extends Error {
  constructor(
    public readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'BUILTIN' | 'INVALID' | 'IN_USE',
    public readonly issues: ValidationIssue[] = [],
  ) {
    super(code);
  }
}

const DELETED_TAG = '__deleted';

interface Deps {
  db: Db;
  registry: SettingsRegistry;
  perms: PermissionChecker;
  /** Pořadí šablon v nabídce (seznam id uložený v nastavení `templates.order`). */
  order?: () => string[];
  setOrder?: (actorId: string, ids: string[]) => Promise<void>;
  audit?: AuditService;
  /** Zda šablonu právě používá otevřený stůl nebo běžící turnaj (pak se nedá smazat). */
  inUse?: (id: string) => boolean;
}

type Meta = { ip?: string | null; source?: AuditSource; reason?: string | null };

export interface TemplateInput {
  name: string;
  description?: string;
  kind: TemplateKind;
  tags?: string[];
  /** Hodnoty vrstvy „šablona“ (jen klíče, které smí šablona nastavit); chybějící se doplní výchozími. */
  values: Record<string, unknown>;
}

/**
 * Šablony nastavení: vestavěné (z kódu, jen ke čtení) a vlastní (v DB, správce je zakládá, upravuje a maže).
 * Hra založená z vlastní šablony si její hodnoty uloží jako snímek, takže pozdější úprava šablony běžící hru nemění.
 */
export class TemplateService {
  private custom = new Map<string, SettingsTemplate>();
  /** Smazané vestavěné šablony (v DB jako záznam se značkou, aby přežily restart; jdou obnovit). */
  private deleted = new Set<string>();

  constructor(private deps: Deps) {}

  async load(): Promise<void> {
    this.custom.clear();
    this.deleted.clear();
    for (const r of await this.deps.db.select().from(schema.settingsTemplates)) {
      if ((r.tags ?? []).includes(DELETED_TAG)) this.deleted.add(r.id);
      else this.custom.set(r.id, this.fromRow(r));
    }
  }

  private fromRow(r: typeof schema.settingsTemplates.$inferSelect): SettingsTemplate {
    return fillTemplate(this.deps.registry, { id: r.id, name: r.name, description: r.description, kind: r.kind as TemplateKind, tags: r.tags, builtin: false, values: r.values as Partial<SettingValues> });
  }

  /** Vestavěné (přepsané správcem se nahradí jeho verzí) a za nimi vlastní. */
  list(kind?: TemplateKind): SettingsTemplate[] {
    const builtin = builtinTemplates(this.deps.registry).filter((t) => !this.deleted.has(t.id)).map((t) => this.custom.get(t.id) ?? t);
    const own = [...this.custom.values()].filter((t) => !this.isBuiltinId(t.id));
    const order = this.deps.order?.() ?? [];
    const rank = (id: string) => {
      const i = order.indexOf(id);
      // Prázdný základ pro vlastní turnaj má být při prvním zobrazení nahoře, dokud ho správce neposune jinam.
      if (i < 0) return id === 'tour-vlastni' ? -1 : Number.MAX_SAFE_INTEGER;
      return i;
    };
    const all = [...builtin, ...own].map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.i - b.i).map((x) => x.t);
    return kind ? all.filter((t) => t.kind === kind) : all;
  }

  /** Šablona pro zakládání nových her (smazaná vestavěná se nenabízí). */
  get(id: string | null | undefined): SettingsTemplate | undefined {
    if (!id || this.deleted.has(id)) return undefined;
    return this.getAny(id);
  }

  /** Šablona i smazaná vestavěná: už běžící hry si hodnoty berou odsud, smazání šablony jim nic nemění. */
  getAny(id: string | null | undefined): SettingsTemplate | undefined {
    if (!id) return undefined;
    return this.custom.get(id) ?? builtinTemplates(this.deps.registry).find((t) => t.id === id);
  }

  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  /** Smazané vestavěné šablony (nabízejí se k obnovení). */
  deletedBuiltin(): SettingsTemplate[] {
    return builtinTemplates(this.deps.registry).filter((t) => this.deleted.has(t.id));
  }

  isBuiltinId(id: string): boolean {
    return builtinTemplates(this.deps.registry).some((t) => t.id === id);
  }

  /** Vestavěná šablona přepsaná správcem (jde obnovit na původní). */
  isOverridden(id: string): boolean {
    return this.isBuiltinId(id) && this.custom.has(id);
  }

  private can(userId: string): void {
    if (!this.deps.perms.can(userId, 'nastaveni.globalni').allowed) throw new TemplateError('FORBIDDEN');
  }

  /** Ověří hodnoty šablony: jen známé, nesoukromé klíče povolené pro vrstvu „šablona“, všechny platné. */
  private clean(values: Record<string, unknown>): Record<string, SettingValue> {
    const out: Record<string, SettingValue> = {};
    const issues: ValidationIssue[] = [];
    for (const [k, v] of Object.entries(values)) {
      const def = this.deps.registry.get(k);
      if (!def && RETIRED_SETTING_KEYS.has(k)) continue;
      if (!def || def.secret || !scopeAllowed(def.scopes, 'template')) {
        issues.push({ keys: [k], messageKey: 'validation.unknownKey', params: { key: k } });
        continue;
      }
      out[k] = v as SettingValue;
    }
    if (issues.length) throw new TemplateError('INVALID', issues);
    const bad = validateValues(this.deps.registry, out);
    if (bad.length) throw new TemplateError('INVALID', bad);
    return out;
  }

  private checkInput(input: TemplateInput): { name: string; description: string; tags: string[] } {
    const name = input.name?.trim() ?? '';
    if (name.length < 2 || name.length > 60) throw new TemplateError('INVALID', [{ keys: ['name'], messageKey: 'lobby.invalidName' }]);
    if (!['cash', 'tournament', 'live'].includes(input.kind)) throw new TemplateError('INVALID', [{ keys: ['kind'], messageKey: 'validation.unknownKey', params: { key: 'kind' } }]);
    return { name, description: (input.description ?? '').trim().slice(0, 300), tags: (input.tags ?? []).map((x) => String(x).slice(0, 30)).slice(0, 20) };
  }

  async create(actorId: string, input: TemplateInput, meta: Meta = {}): Promise<SettingsTemplate> {
    this.can(actorId);
    const head = this.checkInput(input);
    const values = this.clean(input.values);
    const id = `vl-${head.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'sablona'}-${randomBytes(3).toString('hex')}`;
    const [row] = await this.deps.db.insert(schema.settingsTemplates).values({ id, kind: input.kind, ...head, values, updatedBy: actorId }).returning();
    const tpl = this.fromRow(row!);
    this.custom.set(id, tpl);
    await this.deps.audit?.log({ actorId, action: 'sablona.vytvorit', targetType: 'template', targetId: id, after: { name: head.name, kind: input.kind, values }, ...meta });
    return tpl;
  }

  /** Úprava vlastní šablony; u vestavěné vznikne její přepsání (uložené pod stejným id, jde obnovit). */
  async update(actorId: string, id: string, input: TemplateInput, meta: Meta = {}): Promise<SettingsTemplate> {
    this.can(actorId);
    const cur = this.get(id);
    if (!cur) throw new TemplateError('NOT_FOUND');
    const head = this.checkInput({ ...input, kind: cur.kind });
    const values = this.clean(input.values);
    const [row] = this.custom.has(id)
      ? await this.deps.db.update(schema.settingsTemplates).set({ ...head, values, updatedBy: actorId, updatedAt: new Date() }).where(eq(schema.settingsTemplates.id, id)).returning()
      : await this.deps.db.insert(schema.settingsTemplates).values({ id, kind: cur.kind, ...head, values, updatedBy: actorId }).returning();
    const tpl = this.fromRow(row!);
    this.custom.set(id, tpl);
    await this.deps.audit?.log({ actorId, action: 'sablona.upravit', targetType: 'template', targetId: id, before: { name: cur.name, values: cur.values }, after: { name: head.name, values }, ...meta });
    return tpl;
  }

  /** Nové pořadí šablon daného druhu (id v pořadí, jak mají být v nabídce); ostatní druhy se nemění. */
  async reorder(actorId: string, kind: TemplateKind, ids: string[]): Promise<void> {
    this.can(actorId);
    const known = new Set(this.list(kind).map((t) => t.id));
    const clean = ids.filter((id) => known.has(id));
    const rest = this.list(kind).map((t) => t.id).filter((id) => !clean.includes(id));
    const others = this.list().filter((t) => t.kind !== kind).map((t) => t.id);
    await this.deps.setOrder?.(actorId, [...others, ...clean, ...rest]);
  }

  /**
   * Smazání šablony. Vlastní se smaže, vestavěná se skryje (smazání se zapíše jako značka a jde vrátit přes `restore`).
   * Hry si své hodnoty nesou dál, smazání šablony jim nic nemění.
   */
  async remove(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    this.can(actorId);
    const tpl = this.get(id);
    if (!tpl) throw new TemplateError('NOT_FOUND');
    const builtin = this.isBuiltinId(id);
    if (!builtin && this.deps.inUse?.(id)) throw new TemplateError('IN_USE');
    await this.deps.db.delete(schema.settingsTemplates).where(eq(schema.settingsTemplates.id, id));
    this.custom.delete(id);
    if (builtin) {
      await this.deps.db.insert(schema.settingsTemplates).values({ id, kind: tpl.kind, name: id, description: '', tags: [DELETED_TAG], values: {}, updatedBy: actorId });
      this.deleted.add(id);
    }
    await this.deps.audit?.log({ actorId, action: 'sablona.smazat', targetType: 'template', targetId: id, before: { name: tpl.name, builtin }, ...meta });
  }

  /** Vrátí vestavěnou šablonu do původní podoby: zruší vlastní úpravu a obnoví i smazanou. */
  async restore(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    this.can(actorId);
    if (!this.isBuiltinId(id)) throw new TemplateError('NOT_FOUND');
    await this.deps.db.delete(schema.settingsTemplates).where(eq(schema.settingsTemplates.id, id));
    this.custom.delete(id);
    this.deleted.delete(id);
    await this.deps.audit?.log({ actorId, action: 'sablona.obnovit', targetType: 'template', targetId: id, ...meta });
  }
}
