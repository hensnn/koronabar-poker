import { useSyncExternalStore } from 'react';
import { createDefaultRegistry, resolveSettings, sanitizeSettingsProfile, type SettingsProfileData, type SettingValue, type SettingValues } from '@kb/shared';
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

/** Moje osobní nastavení ke sdílení: hodnoty pro všechna zařízení a pro druh zařízení, na kterém právě jsem. */
export function currentProfile(): SettingsProfileData {
  return { user: state.user as Record<string, SettingValue>, device: state.device as Record<string, SettingValue>, deviceKind: deviceId() };
}

export interface ProfileChange {
  key: string;
  layer: 'user' | 'device';
  /** Hodnota, která u mě platí teď (včetně zděděné), a hodnota z profilu. */
  from: SettingValue | undefined;
  to: SettingValue;
}

export interface ProfileOptions {
  /** Převzít i hodnoty pro druh zařízení (telefon / počítač). */
  includeDevice: boolean;
  /** Nejdřív zrušit mé vlastní úpravy, které v profilu nejsou (nastavení bude přesně jako v profilu). */
  replace: boolean;
}

/** Co by převzetí profilu změnilo: jen hodnoty, které se liší od těch, co mám; neplatné klíče jsou v `dropped`. */
export function previewProfile(data: SettingsProfileData, opts: ProfileOptions): { changes: ProfileChange[]; removed: string[]; dropped: string[] } {
  const { data: clean, dropped } = sanitizeSettingsProfile(registry, data);
  const now = resolveFor().values as Record<string, SettingValue>;
  const changes: ProfileChange[] = [];
  for (const [key, to] of Object.entries(clean.user)) if (now[key] !== to) changes.push({ key, layer: 'user', from: now[key], to });
  if (opts.includeDevice) for (const [key, to] of Object.entries(clean.device)) if (now[key] !== to) changes.push({ key, layer: 'device', from: now[key], to });
  const removed = opts.replace ? [...Object.keys(state.user).filter((k) => !(k in clean.user)), ...(opts.includeDevice ? Object.keys(state.device).filter((k) => !(k in clean.device)) : [])] : [];
  return { changes, removed, dropped };
}

/** Převezme profil (z kódu nebo od jiného hráče): uloží platné hodnoty do mého osobního nastavení. */
export async function applyProfile(data: SettingsProfileData, opts: ProfileOptions): Promise<{ applied: number; removed: number; dropped: number }> {
  const { data: clean, dropped } = sanitizeSettingsProfile(registry, data);
  let applied = 0;
  for (const [k, v] of Object.entries(clean.user)) {
    await saveUserSetting(k, v);
    applied++;
  }
  if (opts.includeDevice) {
    for (const [k, v] of Object.entries(clean.device)) {
      await saveUserSetting(k, v, true);
      applied++;
    }
  }
  let removed = 0;
  if (opts.replace) {
    for (const k of Object.keys(state.user).filter((x) => !(x in clean.user))) {
      await resetUserSetting(k);
      removed++;
    }
    if (opts.includeDevice) {
      for (const k of Object.keys(state.device).filter((x) => !(x in clean.device))) {
        await resetUserSetting(k, true);
        removed++;
      }
    }
  }
  return { applied, removed, dropped: dropped.length };
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
