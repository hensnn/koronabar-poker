import { useSyncExternalStore } from 'react';
import { createDefaultRegistry, resolveSettings, keysOfSet, sanitizeSettingsProfile, setById, type SettingsProfileData, type SettingValue, type SettingValues } from '@kb/shared';
import { del, get, put } from './api';
import { clearProfileValue, displayId, profileOverrides, SIZE_KEYS, setProfileValue } from './display-sizes';
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

/** Neúspěšné uložení osobního nastavení (rozbalení widgetu, velikost panelu…): ukáže se uživateli, ať změna nevypadá, že „nic neudělala“. */
const saveErrorListeners = new Set<(e: unknown) => void>();
export function onSaveError(l: (e: unknown) => void): () => void {
  saveErrorListeners.add(l);
  return () => saveErrorListeners.delete(l);
}
const reportSaveError = (e: unknown) => saveErrorListeners.forEach((l) => l(e));
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
  // Velikosti panelů platné pro toto zobrazení (rozlišení a zvětšení) přebijí obecné hodnoty.
  const profiles = String(resolved.values['ui.sizeProfiles'] ?? '');
  if (resolved.values['ui.sizePerDisplay'] !== false && profiles) {
    const over = profileOverrides(profiles, displayId());
    if (Object.keys(over).length > 0) {
      const origins = { ...resolved.origins };
      for (const k of Object.keys(over)) origins[k] = 'userDevice';
      return { ...s, values: { ...resolved.values, ...over }, origins };
    }
  }
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
  // Velikost panelu se ukládá pro právě používané zobrazení, ne pro všechna.
  if (SIZE_KEYS.has(key) && typeof value === 'number' && resolveFor().values['ui.sizePerDisplay'] !== false) {
    return saveUserSetting('ui.sizeProfiles', setProfileValue(String(resolveFor().values['ui.sizeProfiles'] ?? ''), displayId(), key, value), true);
  }
  const layer = deviceOnly ? 'device' : 'user';
  const before = state[layer];
  const deviceBefore = state.device;
  // Hodnota „pro všechna zařízení“ přebije starší hodnotu stejného klíče uloženou jen pro toto zařízení; jinak by ji nová hodnota nepřebila a změna by nebyla vidět (vrstva zařízení má přednost).
  const clearsDevice = !deviceOnly && key in deviceBefore;
  written[layer].add(key);
  if (clearsDevice) {
    const { [key]: _drop, ...rest } = deviceBefore;
    written.device.add(key);
    set({ user: { ...before, [key]: value }, device: rest } as Partial<State>);
  } else {
    set({ [layer]: { ...before, [key]: value } } as Partial<State>);
  }
  try {
    await put('/api/me/settings', { key, value, device: deviceOnly ? deviceId() : undefined });
    if (clearsDevice) await del(`/api/me/settings/${encodeURIComponent(key)}?device=${deviceId()}`);
  } catch (e) {
    set(clearsDevice ? ({ user: before, device: deviceBefore } as Partial<State>) : ({ [layer]: before } as Partial<State>));
    reportSaveError(e);
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
  if (SIZE_KEYS.has(key) && resolveFor().values['ui.sizePerDisplay'] !== false && key in profileOverrides(String(resolveFor().values['ui.sizeProfiles'] ?? ''), displayId())) {
    return saveUserSetting('ui.sizeProfiles', clearProfileValue(String(resolveFor().values['ui.sizeProfiles'] ?? ''), displayId(), key), true);
  }
  const layer = deviceOnly ? 'device' : 'user';
  const { [key]: _drop, ...rest } = state[layer];
  const before = state[layer];
  written[layer].add(key);
  set({ [layer]: rest } as Partial<State>);
  try {
    await del(`/api/me/settings/${encodeURIComponent(key)}${deviceOnly ? `?device=${deviceId()}` : ''}`);
  } catch (e) {
    set({ [layer]: before } as Partial<State>);
    reportSaveError(e);
    throw e;
  }
}

type Kind = 'phone' | 'desktop';
type Layers = { user: Record<string, SettingValue>; device: Record<string, SettingValue> };

/** Vrstvy hodnot hráče pro druh zařízení: pro to, na kterém jsem, z paměti, pro druhé se stáhnou ze serveru. */
async function layersFor(kind: Kind): Promise<Layers> {
  if (kind === deviceId()) return { user: { ...(state.user as Record<string, SettingValue>) }, device: { ...(state.device as Record<string, SettingValue>) } };
  const r = await get<Layers>(`/api/me/settings?device=${kind}`);
  return { user: r.user, device: r.device };
}

/** Hodnota, která platí bez mých úprav (výchozí z registru nebo od správce). */
function inherited(key: string): SettingValue | undefined {
  return resolveSettings(registry, [{ scope: 'global', values: state.global }]).values[key] as SettingValue | undefined;
}

const putLayer = (key: string, value: SettingValue, kind: Kind | null) => put('/api/me/settings', { key, value, device: kind ?? undefined });
const delLayer = (key: string, kind: Kind | null) => del(`/api/me/settings/${encodeURIComponent(key)}${kind ? `?device=${kind}` : ''}`);

/** Moje hodnoty ze sady (jen to, co jsem upravil), pro druh zařízení sady. */
export async function exportSet(setId: string): Promise<SettingsProfileData> {
  const def = setById(setId);
  if (!def) throw new Error('UNKNOWN_SET');
  const kind = def.kind ?? deviceId();
  const layers = await layersFor(kind);
  const keys = new Set(keysOfSet(registry, setId));
  const merged: Record<string, SettingValue> = {};
  for (const [k, v] of Object.entries({ ...layers.user, ...layers.device })) if (keys.has(k)) merged[k] = v;
  return def.kind ? { user: {}, device: merged, deviceKind: def.kind, set: setId } : { user: merged, device: {}, deviceKind: null, set: setId };
}

export interface SetChange {
  key: string;
  from: SettingValue | undefined;
  to: SettingValue;
}

/** Hodnoty, které ze sady platí u mě teď (včetně zděděných) pro druh zařízení sady. */
async function effectiveFor(setId: string): Promise<Record<string, SettingValue | undefined>> {
  const def = setById(setId);
  const layers = await layersFor(def?.kind ?? deviceId());
  return resolveSettings(registry, [
    { scope: 'global', values: state.global },
    { scope: 'user', values: layers.user },
    { scope: 'userDevice', values: layers.device },
  ]).values as Record<string, SettingValue | undefined>;
}

/** Co by převzetí sady změnilo: hodnoty, které se liší od těch, co platí u mě; u sady se nechá jen to, co do ní patří. */
export async function previewSet(data: SettingsProfileData): Promise<{ setId: string; changes: SetChange[]; toDefault: string[]; dropped: number }> {
  const setId = data.set ?? '';
  if (!setById(setId)) throw new Error('INVALID_CODE');
  const { data: clean, dropped } = sanitizeSettingsProfile(registry, data);
  const keys = new Set(keysOfSet(registry, setId));
  const incoming: Record<string, SettingValue> = {};
  for (const [k, v] of Object.entries({ ...clean.user, ...clean.device })) if (keys.has(k)) incoming[k] = v;
  const now = await effectiveFor(setId);
  const changes: SetChange[] = [];
  for (const [k, to] of Object.entries(incoming)) if (now[k] !== to) changes.push({ key: k, from: now[k], to });
  // Sada se převezme celá: co v ní není, se vrátí na výchozí.
  const toDefault = [...keys].filter((k) => !(k in incoming) && now[k] !== inherited(k));
  return { setId, changes, toDefault, dropped: dropped.length + Object.keys({ ...clean.user, ...clean.device }).filter((k) => !keys.has(k)).length };
}

/** Obnoví sadu na výchozí: moje úpravy se smažou a platí nastavení od správce. Sada stolu se týká jen svého druhu zařízení. */
export async function resetSet(setId: string): Promise<void> {
  const def = setById(setId);
  if (!def) throw new Error('UNKNOWN_SET');
  const keys = keysOfSet(registry, setId);
  if (def.kind) {
    const layers = await layersFor(def.kind);
    for (const k of keys) {
      if (k in layers.device) await delLayer(k, def.kind);
      // Hodnota společná všem zařízením se druhému druhu zařízení nemění: tady ji přebije výslovná výchozí hodnota.
      if (k in layers.user) await putLayer(k, inherited(k) as SettingValue, def.kind);
    }
  } else {
    const [phone, desktop] = await Promise.all([layersFor('phone'), layersFor('desktop')]);
    for (const k of keys) {
      if (k in phone.user) await delLayer(k, null);
      if (k in phone.device) await delLayer(k, 'phone');
      if (k in desktop.device) await delLayer(k, 'desktop');
    }
  }
  await loadSettings();
}

/** Převezme sadu (z kódu nebo od jiného hráče): nejdřív obnoví výchozí a pak uloží její hodnoty. */
export async function applySet(data: SettingsProfileData): Promise<{ applied: number }> {
  const setId = data.set ?? '';
  const def = setById(setId);
  if (!def) throw new Error('INVALID_CODE');
  const { data: clean } = sanitizeSettingsProfile(registry, data);
  const keys = new Set(keysOfSet(registry, setId));
  await resetSet(setId);
  let applied = 0;
  for (const [k, v] of Object.entries({ ...clean.user, ...clean.device })) {
    if (!keys.has(k)) continue;
    await putLayer(k, v, def.kind);
    applied++;
  }
  await loadSettings();
  return { applied };
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
