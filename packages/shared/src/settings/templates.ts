import { z } from 'zod';
import type { SettingsRegistry } from './registry.js';
import { validateValues, type ValidationIssue } from './validate.js';
import type { SettingValues } from './types.js';

/** Aktuální verze schématu nastavení. Při změně přidej migraci do MIGRATIONS. */
export const SETTINGS_SCHEMA_VERSION = 1;

export type TemplateKind = 'cash' | 'tournament' | 'live';

export interface SettingsTemplate {
  schemaVersion: number;
  id: string;
  /** Překladový klíč (vestavěné) nebo vlastní text. */
  name: string;
  description: string;
  kind: TemplateKind;
  tags: string[];
  /** Retro šablony mají každou novou funkci vypnutou. */
  retro?: boolean;
  /** Vestavěné šablony jsou jen pro čtení. */
  builtin?: boolean;
  values: Partial<SettingValues>;
}

/** Migrace z verze N na N+1. Čisté funkce nad nezpracovaným objektem. */
export const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrateTemplate(raw: Record<string, unknown>): Record<string, unknown> {
  let cur = raw;
  let v = Number(cur.schemaVersion ?? 1);
  while (v < SETTINGS_SCHEMA_VERSION) {
    const fn = MIGRATIONS[v];
    if (!fn) throw new Error(`Chybí migrace šablony z verze ${v}`);
    cur = { ...fn(cur), schemaVersion: v + 1 };
    v += 1;
  }
  return cur;
}

const templateEnvelope = z.object({
  schemaVersion: z.number().int().min(1).max(SETTINGS_SCHEMA_VERSION),
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  description: z.string().max(300).default(''),
  kind: z.enum(['cash', 'tournament', 'live']),
  tags: z.array(z.string().max(30)).max(20).default([]),
  retro: z.boolean().optional(),
  values: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])),
});

/** Doplní všechny parametry (kompletní nastavení šablony), u retro šablon retroDefault. */
export function fillTemplate(
  reg: SettingsRegistry,
  tpl: Omit<SettingsTemplate, 'schemaVersion' | 'values'> & { values: Partial<SettingValues> },
): SettingsTemplate {
  const full: SettingValues = {};
  for (const d of reg.all()) {
    if (d.scopes && !d.scopes.includes('template')) continue;
    if (d.secret) continue;
    let val = d.default;
    if (tpl.retro && d.retroDefault !== undefined) val = d.retroDefault as typeof val;
    full[d.key] = val;
  }
  return { ...tpl, schemaVersion: SETTINGS_SCHEMA_VERSION, values: { ...full, ...tpl.values } };
}

/** Export do JSON: bez tajných údajů a bez osobních (uživatelských) parametrů. */
export function exportTemplate(reg: SettingsRegistry, tpl: SettingsTemplate): string {
  const values: SettingValues = {};
  for (const [k, v] of Object.entries(tpl.values)) {
    const d = reg.get(k);
    if (!d || d.secret) continue;
    values[k] = v as SettingValues[string];
  }
  return JSON.stringify({ ...tpl, builtin: undefined, values }, null, 2);
}

export type ImportResult =
  | { ok: true; template: SettingsTemplate; dropped: string[] }
  | { ok: false; errors: ValidationIssue[] };

/** Import: migrace na aktuální verzi, vyřazení neznámých klíčů, validace. */
export function importTemplate(reg: SettingsRegistry, json: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, errors: [{ keys: [], messageKey: 'import.invalidJson' }] };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: [{ keys: [], messageKey: 'import.invalidJson' }] };
  }
  let migrated: Record<string, unknown>;
  try {
    migrated = migrateTemplate(raw as Record<string, unknown>);
  } catch {
    return { ok: false, errors: [{ keys: [], messageKey: 'import.unsupportedVersion' }] };
  }
  const parsed = templateEnvelope.safeParse(migrated);
  if (!parsed.success) {
    return { ok: false, errors: [{ keys: [], messageKey: 'import.invalidStructure' }] };
  }
  const dropped: string[] = [];
  const values: SettingValues = {};
  for (const [k, v] of Object.entries(parsed.data.values)) {
    const d = reg.get(k);
    if (!d || d.secret) {
      dropped.push(k);
      continue;
    }
    values[k] = v;
  }
  const errors = validateValues(reg, values);
  if (errors.length) return { ok: false, errors };
  const { schemaVersion: _sv, ...rest } = parsed.data;
  return {
    ok: true,
    dropped,
    template: { ...rest, schemaVersion: SETTINGS_SCHEMA_VERSION, values, builtin: false },
  };
}
