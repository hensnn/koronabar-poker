import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './definitions/index.js';
import { decodeSettingsCode, encodeSettingsCode, sanitizeSettingsProfile } from './profile.js';

const reg = createDefaultRegistry();

describe('sdílení osobního nastavení', () => {
  it('kód projde tam a zpět včetně české diakritiky', () => {
    const data = { user: { 'ui.themeId': 'světlé-čaj' }, device: { 'ui.mobileBest': false }, deviceKind: 'phone' as const };
    const code = encodeSettingsCode(data);
    expect(code.startsWith('KBS1.')).toBe(true);
    expect(decodeSettingsCode(code)).toEqual(data);
  });
  it('starší export v JSON se také přečte, cizí nesmysl ne', () => {
    expect(decodeSettingsCode(JSON.stringify({ kind: 'kb-user-settings', version: 1, user: { 'ui.sfxEnabled': false } })).user).toEqual({ 'ui.sfxEnabled': false });
    expect(() => decodeSettingsCode('{"a":1}')).toThrow('INVALID_CODE');
    expect(() => decodeSettingsCode('KBS1.%%%')).toThrow('INVALID_CODE');
    expect(() => decodeSettingsCode('')).toThrow('INVALID_CODE');
  });
  it('sanitizace nechá jen osobní parametry s platnou hodnotou', () => {
    const { data, dropped } = sanitizeSettingsProfile(reg, {
      user: { 'ui.sfxEnabled': false, 'economy.currencyName': 'X', 'neexistuje': 1, 'ui.sfxVolumePercent': 999 },
      device: { 'ui.mobileBest': true },
      deviceKind: null,
    });
    expect(data.user).toEqual({ 'ui.sfxEnabled': false });
    expect(data.device).toEqual({ 'ui.mobileBest': true });
    expect(dropped.sort()).toEqual(['economy.currencyName', 'neexistuje', 'ui.sfxVolumePercent'].sort());
  });
});
