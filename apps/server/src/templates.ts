import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { builtinTemplates, fillTemplate, scopeAllowed, validateValues, type PermissionChecker, type SettingsRegistry, type SettingsTemplate, type SettingValue, type SettingValues, type TemplateKind, type ValidationIssue } from '@kb/shared';
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

interface Deps {
  db: Db;
  registry: SettingsRegistry;
  perms: PermissionChecker;
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

  constructor(private deps: Deps) {}

  async load(): Promise<void> {
    this.custom.clear();
    for (const r of await this.deps.db.select().from(schema.settingsTemplates)) this.custom.set(r.id, this.fromRow(r));
  }

  private fromRow(r: typeof schema.settingsTemplates.$inferSelect): SettingsTemplate {
    return fillTemplate(this.deps.registry, { id: r.id, name: r.name, description: r.description, kind: r.kind as TemplateKind, tags: r.tags, builtin: false, values: r.values as Partial<SettingValues> });
  }

  list(kind?: TemplateKind): SettingsTemplate[] {
    const all = [...builtinTemplates(this.deps.registry), ...this.custom.values()];
    return kind ? all.filter((t) => t.kind === kind) : all;
  }

  get(id: string | null | undefined): SettingsTemplate | undefined {
    if (!id) return undefined;
    return this.custom.get(id) ?? builtinTemplates(this.deps.registry).find((t) => t.id === id);
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

  async update(actorId: string, id: string, input: TemplateInput, meta: Meta = {}): Promise<SettingsTemplate> {
    this.can(actorId);
    const cur = this.custom.get(id);
    if (!cur) throw new TemplateError(this.get(id) ? 'BUILTIN' : 'NOT_FOUND');
    const head = this.checkInput({ ...input, kind: cur.kind });
    const values = this.clean(input.values);
    const [row] = await this.deps.db.update(schema.settingsTemplates).set({ ...head, values, updatedBy: actorId, updatedAt: new Date() }).where(eq(schema.settingsTemplates.id, id)).returning();
    const tpl = this.fromRow(row!);
    this.custom.set(id, tpl);
    await this.deps.audit?.log({ actorId, action: 'sablona.upravit', targetType: 'template', targetId: id, before: { name: cur.name, values: cur.values }, after: { name: head.name, values }, ...meta });
    return tpl;
  }

  async remove(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    this.can(actorId);
    const cur = this.custom.get(id);
    if (!cur) throw new TemplateError(this.get(id) ? 'BUILTIN' : 'NOT_FOUND');
    if (this.deps.inUse?.(id)) throw new TemplateError('IN_USE');
    await this.deps.db.delete(schema.settingsTemplates).where(eq(schema.settingsTemplates.id, id));
    this.custom.delete(id);
    await this.deps.audit?.log({ actorId, action: 'sablona.smazat', targetType: 'template', targetId: id, before: { name: cur.name }, ...meta });
  }
}
