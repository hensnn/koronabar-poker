import { useSyncExternalStore } from 'react';
import { createDefaultRegistry, resolveSettings, scopeAllowed, validateValues, type SettingValue, type SettingValues } from '@kb/shared';
import { del, get, put } from './api';
import { onSocket } from './net';

export const registry = createDefaultRegistry();

const CACHE = 'kb.settings.cache.v1';
const DEVICE = 'kb.device';

/** Identifikátor zařízení zůstává jen v tomto prohlížeči (osobní nastavení „jen na tomto zařízení“). */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE);
    if (!id) {
      id = crypto.randomUUID().slice(0, 8);
      localStorage.setItem(DEVICE, id);
    }
    return id;
  } catch {
    return 'temp';
  }
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

/** Server je zdroj pravdy; localStorage je jen mezipaměť pro rychlé načtení. */
export async function loadSettings(): Promise<void> {
  const [mine, glob] = await Promise.all([get<{ user: Partial<SettingValues>; device: Partial<SettingValues> }>(`/api/me/settings?device=${deviceId()}`), get<{ values: Partial<SettingValues> }>('/api/settings/global')]);
  set({ user: mine.user, device: mine.device, global: glob.values, loaded: true });
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

export function useSettings() {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  const resolved = resolveSettings(registry, [
    { scope: 'global', values: s.global },
    { scope: 'user', values: s.user },
    { scope: 'userDevice', values: s.device },
  ]);
  return { ...s, values: resolved.values, origins: resolved.origins };
}

/** Uloží osobní hodnotu na server; `deviceOnly` = jen pro toto zařízení. */
export async function saveUserSetting(key: string, value: SettingValue, deviceOnly = false): Promise<void> {
  const layer = deviceOnly ? 'device' : 'user';
  const before = state[layer];
  set({ [layer]: { ...before, [key]: value } } as Partial<State>);
  try {
    await put('/api/me/settings', { key, value, device: deviceOnly ? deviceId() : undefined });
  } catch (e) {
    set({ [layer]: before } as Partial<State>);
    throw e;
  }
}

export async function resetUserSetting(key: string, deviceOnly = false): Promise<void> {
  const layer = deviceOnly ? 'device' : 'user';
  const { [key]: _drop, ...rest } = state[layer];
  const before = state[layer];
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
