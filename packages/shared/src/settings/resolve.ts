import type { SettingsRegistry } from './registry.js';
import { SCOPES, type Scope, type SettingValue, type SettingValues } from './types.js';

export type Layer = { scope: Scope; scopeId?: string; values: Partial<SettingValues> };
export type Origin = 'default' | Scope;

export interface Resolved {
  values: SettingValues;
  origins: Record<string, Origin>;
}

export const DEFAULT_SCOPES: readonly Scope[] = ['global', 'template', 'game', 'table'];

export function scopeAllowed(scopes: readonly Scope[] | undefined, scope: Scope): boolean {
  return (scopes ?? DEFAULT_SCOPES).includes(scope);
}

/**
 * Spočítá efektivní hodnoty. Vrstvy se aplikují podle pořadí SCOPES
 * (global → template → game → table → user → userDevice); vrstva smí přepsat
 * jen klíče, které její rozsah u parametru povoluje.
 */
export function resolveSettings(reg: SettingsRegistry, layers: Layer[]): Resolved {
  const values: SettingValues = reg.defaults();
  const origins: Record<string, Origin> = Object.fromEntries(
    reg.all().map((d) => [d.key, 'default' as Origin]),
  );
  const ordered = [...layers].sort((a, b) => SCOPES.indexOf(a.scope) - SCOPES.indexOf(b.scope));
  for (const layer of ordered) {
    for (const [key, val] of Object.entries(layer.values)) {
      const def = reg.get(key);
      if (!def || val === undefined) continue;
      if (!scopeAllowed(def.scopes, layer.scope)) continue;
      values[key] = val as SettingValue;
      origins[key] = layer.scope;
    }
  }
  return { values, origins };
}

/** Zda je parametr v dané situaci viditelný (závislosti a typ hry). */
export function isVisible(
  reg: SettingsRegistry,
  key: string,
  values: SettingValues,
  gameKind?: 'cash' | 'tournament' | 'live',
): boolean {
  const def = reg.get(key);
  if (!def) return false;
  if (gameKind && def.appliesTo && def.appliesTo !== 'all' && def.appliesTo !== gameKind) return false;
  const dep = def.dependsOn;
  if (!dep) return true;
  const v = values[dep.key];
  if (dep.equals !== undefined) return v === dep.equals;
  if (dep.truthy) return Boolean(v);
  return true;
}
