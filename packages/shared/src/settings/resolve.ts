import type { SettingsRegistry } from './registry.js';
import { SCOPES, type Scope, type SettingValue, type SettingValues } from './types.js';

export type Layer = { scope: Scope; scopeId?: string; values: Partial<SettingValues> };
export type Origin = 'default' | Scope;

export interface Resolved {
  values: SettingValues;
  origins: Record<string, Origin>;
}

export const DEFAULT_SCOPES: readonly Scope[] = ['global', 'template', 'table'];

export function scopeAllowed(scopes: readonly Scope[] | undefined, scope: Scope): boolean {
  return (scopes ?? DEFAULT_SCOPES).includes(scope);
}

const SCOPE_RANK: Record<Scope, number> = Object.fromEntries(SCOPES.map((s, i) => [s, i])) as Record<Scope, number>;

/** Vrstvy v pořadí SCOPES; už seřazený seznam se nekopíruje. */
function ordered(layers: Layer[]): Layer[] {
  for (let i = 1; i < layers.length; i++) if (SCOPE_RANK[layers[i]!.scope] < SCOPE_RANK[layers[i - 1]!.scope]) return [...layers].sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]);
  return layers;
}

/**
 * Paměť výsledků podle identity vrstev: strom klíčovaný registrem → (rozsah, objekt hodnot) → … Protože objekt
 * vrstvy může někdo změnit „na místě“, u zásahu se ještě porovná obsah vrstvy se snímkem z doby výpočtu
 * (mělké porovnání, u šablony stovky položek = jednotky µs, výpočet od nuly stojí stovky µs).
 */
interface MemoNode {
  next: Map<Scope, WeakMap<object, MemoNode>>;
  hit?: { snapshots: Partial<SettingValues>[]; result: Resolved };
}
const memo = new WeakMap<SettingsRegistry, MemoNode>();
const originsCache = new WeakMap<SettingsRegistry, { size: number; origins: Readonly<Record<string, Origin>> }>();

function sameLayer(a: Partial<SettingValues>, b: Partial<SettingValues>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

function defaultOrigins(reg: SettingsRegistry): Readonly<Record<string, Origin>> {
  const all = reg.all();
  const c = originsCache.get(reg);
  if (c && c.size === all.length) return c.origins;
  const origins = Object.freeze(Object.fromEntries(all.map((d) => [d.key, 'default' as Origin])));
  originsCache.set(reg, { size: all.length, origins });
  return origins;
}

function compute(reg: SettingsRegistry, layers: Layer[]): Resolved {
  const values: SettingValues = { ...reg.defaults() };
  const origins: Record<string, Origin> = { ...defaultOrigins(reg) };
  for (const layer of layers) {
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

/**
 * Spočítá efektivní hodnoty. Vrstvy se aplikují podle pořadí SCOPES
 * (global → template → table → user → userDevice); vrstva smí přepsat
 * jen klíče, které její rozsah u parametru povoluje. Výsledek je vždy nová kopie (volající ho smí měnit).
 */
export function resolveSettings(reg: SettingsRegistry, layers: Layer[]): Resolved {
  const sorted = ordered(layers);
  let node: MemoNode | undefined = memo.get(reg);
  if (!node) memo.set(reg, (node = { next: new Map() }));
  for (const layer of sorted) {
    let byScope: WeakMap<object, MemoNode> | undefined = node.next.get(layer.scope);
    if (!byScope) node.next.set(layer.scope, (byScope = new WeakMap()));
    let child: MemoNode | undefined = byScope.get(layer.values);
    if (!child) byScope.set(layer.values, (child = { next: new Map() }));
    node = child;
  }
  let hit = node.hit;
  if (!hit || !hit.snapshots.every((s, i) => sameLayer(s, sorted[i]!.values))) {
    hit = node.hit = { snapshots: sorted.map((l) => ({ ...l.values })), result: compute(reg, sorted) };
  }
  return { values: { ...hit.result.values }, origins: { ...hit.result.origins } };
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
