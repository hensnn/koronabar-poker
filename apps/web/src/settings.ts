import { useSyncExternalStore } from 'react';
import { createDefaultRegistry, resolveSettings, scopeAllowed, validateValues, type SettingValue, type SettingValues } from '@kb/shared';
import { del, get, put } from './api';
import { onSocket } from './net';

export const registry = createDefaultRegistry();

const CACHE = 'kb.settings.cache.v1';
const DEVICE = 'kb.device';
const DEVICE_MIGRATED = 'kb.device.migrated';

/** Starší identifikátor konkrétního prohlížeče (dřívější „jen toto zařízení“); dnes slouží jen k jednorázovému převzetí hodnot. */
function legacyDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE);
  } catch {
    return null;
  }
}

/**
 * Typ zařízení pro vlastní nastavení: 'phone' (telefon a tablet s dotykovým ovládáním) nebo 'desktop' (počítač).
 * Každý typ má u hráče vlastní profil osobního nastavení, který se použije automaticky na všech zařízeních toho typu.
 */
export function deviceId(): 'phone' | 'desktop' {
  const forced = deviceKindOverride();
  if (forced !== 'auto') return forced;
  try {
    return window.matchMedia('(pointer: coarse)').matches ? 'phone' : 'desktop';
  } catch {
    return 'desktop';
  }
}

const KIND = 'kb.deviceKind';

/** Ruční volba typu zařízení (Nastavení → Osobní nastavení); „auto“ = podle dotykového ovládání. */
export function deviceKindOverride(): 'auto' | 'phone' | 'desktop' {
  try {
    const v = localStorage.getItem(KIND);
    return v === 'phone' || v === 'desktop' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Uloží ruční volbu typu zařízení a načte aplikaci znovu, aby se použil správný profil nastavení. */
export function setDeviceKindOverride(v: 'auto' | 'phone' | 'desktop'): void {
  try {
    if (v === 'auto') localStorage.removeItem(KIND);
    else localStorage.setItem(KIND, v);
  } catch {
    /* bez úložiště jde jen automatika */
  }
  window.location.reload();
}

interface State {
  global: Partial<SettingValues>;
  user: Partial<SettingValues>;
  device: Partial<SettingValues>;
  loaded: boolean;
}

function readCache(): State {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE) ?? '{}') as Partial<State>;
    return { global: c.global ?? {}, user: c.user ?? {}, device: c.device ?? {}, loaded: false };
  } catch {
    return { global: {}, user: {}, device: {}, loaded: false };
  }
}

let state: State = readCache();
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(CACHE, JSON.stringify({ global: state.global, user: state.user, device: state.device }));
  } catch {
    /* mezipaměť není dostupná */
  }
  listeners.forEach((l) => l());
};

// Klíče změněné od začátku posledního načtení: pomalá odpověď serveru nesmí přepsat čerstvou místní změnu
// (na telefonu přepínač „probliknul“ zpět, než doběhl GET rozběhnutý před uložením).
let loadToken = 0;
const written: Record<'user' | 'device' | 'global', Set<string>> = { user: new Set(), device: new Set(), global: new Set() };

/** Server je zdroj pravdy; localStorage je jen mezipaměť pro rychlé načtení. */
export async function loadSettings(): Promise<void> {
  const token = ++loadToken;
  written.user.clear();
  written.device.clear();
  written.global.clear();
  const [mine, glob] = await Promise.all([get<{ user: Partial<SettingValues>; device: Partial<SettingValues> }>(`/api/me/settings?device=${deviceId()}`), get<{ values: Partial<SettingValues> }>('/api/settings/global')]);
  await adoptLegacyDevice(mine);
  if (token !== loadToken) return; // mezitím začalo novější načtení
  const overlay = (layer: 'user' | 'device' | 'global', fresh: Partial<SettingValues>) => {
    const out: Partial<SettingValues> = { ...fresh };
    for (const k of written[layer]) {
      if (k in state[layer]) out[k] = state[layer][k];
      else delete out[k];
    }
    return out;
  };
  set({ user: overlay('user', mine.user), device: overlay('device', mine.device), global: overlay('global', glob.values), loaded: true });
}

/** Jednorázově převezme hodnoty „jen toto zařízení“ ze starého identifikátoru prohlížeče do profilu typu zařízení, pokud je ten ještě prázdný. */
async function adoptLegacyDevice(mine: { device: Partial<SettingValues> }): Promise<void> {
  const old = legacyDeviceId();
  if (!old || old === deviceId()) return;
  try {
    if (localStorage.getItem(DEVICE_MIGRATED)) return;
    localStorage.setItem(DEVICE_MIGRATED, '1');
  } catch {
    return;
  }
  if (Object.keys(mine.device).length > 0) return;
  try {
    const legacy = await get<{ user: Partial<SettingValues>; device: Partial<SettingValues> }>(`/api/me/settings?device=${encodeURIComponent(old)}`);
    for (const [k, v] of Object.entries(legacy.device)) {
      await put('/api/me/settings', { key: k, value: v, device: deviceId() });
      (mine.device as Record<string, unknown>)[k] = v;
    }
  } catch {
    /* převzetí je jen pohodlí, bez něj se začne s prázdným profilem */
  }
}

export function clearSettings() {
  state = { global: {}, user: {}, device: {}, loaded: false };
  try {
    localStorage.removeItem(CACHE);
  } catch {
    /* nic */
  }
  listeners.forEach((l) => l());
}

/** Efektivní hodnoty a jejich původ z aktuálního stavu (mimo React, např. v testech). */
export function resolveFor(s: State = state) {
  const resolved = resolveSettings(registry, [
    { scope: 'global', values: s.global },
    { scope: 'user', values: s.user },
    { scope: 'userDevice', values: s.device },
  ]);
  return { ...s, values: resolved.values, origins: resolved.origins };
}

export function useSettings() {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  return resolveFor(s);
}

/** Uloží osobní hodnotu na server; `deviceOnly` = jen pro toto zařízení. */
export async function saveUserSetting(key: string, value: SettingValue, deviceOnly = false): Promise<void> {
  const layer = deviceOnly ? 'device' : 'user';
  const before = state[layer];
  written[layer].add(key);
  set({ [layer]: { ...before, [key]: value } } as Partial<State>);
  try {
    await put('/api/me/settings', { key, value, device: deviceOnly ? deviceId() : undefined });
  } catch (e) {
    set({ [layer]: before } as Partial<State>);
    throw e;
  }
}

/** Uloží globální hodnotu (správce): projeví se hned, při chybě se vrátí; pomalé načtení ji nepřepíše. */
export async function saveGlobalSetting(key: string, value: SettingValue): Promise<void> {
  const before = state.global;
  written.global.add(key);
  set({ global: { ...before, [key]: value } });
  try {
    await put('/api/settings/global', { key, value });
  } catch (e) {
    set({ global: before });
    throw e;
  }
}

/** Odstraní uloženou globální hodnotu (správce): platí zase výchozí. */
export async function resetGlobalSetting(key: string): Promise<void> {
  const before = state.global;
  const { [key]: _drop, ...rest } = before;
  written.global.add(key);
  set({ global: rest });
  try {
    await del(`/api/settings/global/${encodeURIComponent(key)}`);
  } catch (e) {
    set({ global: before });
    throw e;
  }
}

export async function resetUserSetting(key: string, deviceOnly = false): Promise<void> {
  const layer = deviceOnly ? 'device' : 'user';
  const { [key]: _drop, ...rest } = state[layer];
  const before = state[layer];
  written[layer].add(key);
  set({ [layer]: rest } as Partial<State>);
  try {
    await del(`/api/me/settings/${encodeURIComponent(key)}${deviceOnly ? `?device=${deviceId()}` : ''}`);
  } catch (e) {
    set({ [layer]: before } as Partial<State>);
    throw e;
  }
}

/** Export osobního nastavení do JSON (bez tajných údajů; ta v osobních vrstvách nejsou). */
export function exportUserSettings(): string {
  return JSON.stringify({ kind: 'kb-user-settings', version: 1, user: state.user }, null, 2);
}

/** Import: jen platné osobní parametry, ostatní se vyřadí. Vrací počet načtených a vyřazených. */
export async function importUserSettings(json: string): Promise<{ imported: number; dropped: string[] }> {
  const raw = JSON.parse(json) as { kind?: string; user?: Record<string, SettingValue> };
  if (raw.kind !== 'kb-user-settings' || typeof raw.user !== 'object' || raw.user === null) throw new Error('INVALID_FILE');
  const ok: Record<string, SettingValue> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(raw.user)) {
    const def = registry.get(k);
    if (!def || !scopeAllowed(def.scopes, 'user') || validateValues(registry, { [k]: v }).length) dropped.push(k);
    else ok[k] = v;
  }
  for (const [k, v] of Object.entries(ok)) await saveUserSetting(k, v);
  return { imported: Object.keys(ok).length, dropped };
}

// Změna na jiném zařízení téhož hráče se projeví hned.
onSocket<{ scope: string; device: string | null; key: string; value: SettingValue | null }>('settings:changed', (m) => {
  if (m.scope === 'user') {
    const { [m.key]: _d, ...rest } = state.user;
    set({ user: m.value === null ? rest : { ...state.user, [m.key]: m.value } });
  } else if (m.scope === 'userDevice' && m.device === deviceId()) {
    const { [m.key]: _d, ...rest } = state.device;
    set({ device: m.value === null ? rest : { ...state.device, [m.key]: m.value } });
  }
});

export type { SettingValues };

/** Výchozí hodnota osobního nastavení z registru (pro tlačítka „výchozí velikost“). */
export function defaultOf(key: string): number {
  return Number(registry.defaults()[key] ?? 0);
}
