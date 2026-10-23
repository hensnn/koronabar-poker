import type { SettingsRegistry } from './registry.js';
import { scopeAllowed } from './resolve.js';
import type { SettingValue } from './types.js';
import { setById } from './sets.js';
import { validateValues } from './validate.js';

/** Osobní nastavení hráče k sdílení: hodnoty pro všechna zařízení (`user`) a pro jeden druh zařízení (`device`). */
export interface SettingsProfileData {
  user: Record<string, SettingValue>;
  device: Record<string, SettingValue>;
  /** Druh zařízení, pro které byly hodnoty v `device` nastaveny (telefon / počítač). */
  deviceKind: 'phone' | 'desktop' | null;
  /** Sada nastavení, ke které profil patří (viz `SETTING_SETS`); bez ní jde o celé osobní nastavení. */
  set?: string | null;
}

const PREFIX = 'KBS1.';

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): string {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Kód k poslání v chatu: předpona + JSON v base64url. */
export function encodeSettingsCode(data: SettingsProfileData): string {
  return PREFIX + toBase64Url(JSON.stringify({ v: 1, user: data.user, device: data.device, deviceKind: data.deviceKind, set: data.set ?? null }));
}

const isRecord = (x: unknown): x is Record<string, SettingValue> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Přečte kód (nebo starší export v JSON, který měl jen vrstvu `user`); při chybě hodí `INVALID_CODE`. */
export function decodeSettingsCode(text: string): SettingsProfileData {
  const raw = text.trim();
  try {
    const json = raw.startsWith(PREFIX) ? fromBase64Url(raw.slice(PREFIX.length)) : raw;
    const o = JSON.parse(json) as { kind?: string; user?: unknown; device?: unknown; deviceKind?: unknown; set?: unknown };
    if (!isRecord(o.user) && !isRecord(o.device)) throw new Error('INVALID_CODE');
    if (!raw.startsWith(PREFIX) && o.kind !== 'kb-user-settings') throw new Error('INVALID_CODE');
    return { user: isRecord(o.user) ? o.user : {}, device: isRecord(o.device) ? o.device : {}, deviceKind: o.deviceKind === 'phone' || o.deviceKind === 'desktop' ? o.deviceKind : null, set: typeof o.set === 'string' && setById(o.set) ? o.set : null };
  } catch {
    throw new Error('INVALID_CODE');
  }
}

/** Nechá jen platné osobní parametry s platnou hodnotou; ostatní vrátí v `dropped`. */
export function sanitizeSettingsProfile(reg: SettingsRegistry, data: SettingsProfileData): { data: SettingsProfileData; dropped: string[] } {
  const dropped: string[] = [];
  const clean = (layer: Record<string, SettingValue>, scope: 'user' | 'userDevice') => {
    const out: Record<string, SettingValue> = {};
    for (const [k, v] of Object.entries(layer)) {
      const def = reg.get(k);
      if (!def || def.secret || !scopeAllowed(def.scopes, scope) || validateValues(reg, { [k]: v }).length > 0) dropped.push(k);
      else out[k] = v;
    }
    return out;
  };
  return { data: { user: clean(data.user, 'user'), device: clean(data.device, 'userDevice'), deviceKind: data.deviceKind, set: data.set && setById(data.set) ? data.set : null }, dropped };
}
