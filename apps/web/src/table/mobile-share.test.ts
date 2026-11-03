import { describe, expect, it } from 'vitest';
import { createDefaultRegistry, keysOfSet, sanitizeSettingsProfile, SETTING_SETS, type SettingValue } from '@kb/shared';
import { MOBILE_WIDGETS, ORDER_KEY, ORDER_KEY_LANDSCAPE, parseMobileOrder, serializeOrder, TOOL_IDS, type MobileOrder } from './mobile-order';

const reg = createDefaultRegistry();

/** Nejdelší možný zápis rozmístění: všechny ikony a widgety nastavené na všechny obrazovky. */
const fullest = (): MobileOrder => ({
  ...parseMobileOrder(''),
  tools: Object.fromEntries([...TOOL_IDS, ...MOBILE_WIDGETS.map((w) => `w:${w}`)].map((k) => [k, [1, 2, 3]])),
});

describe('sdílení nastavení telefonu', () => {
  it('všechna nastavení telefonu patří do sady „stůl na telefonu“ a do sady pro počítač nepatří', () => {
    const phone = keysOfSet(reg, 'tablePhone');
    const desktop = keysOfSet(reg, 'tableDesktop');
    for (const k of ['ui.mobileOrder', 'ui.mobileOrderLandscape', 'ui.mobileTableScale', 'ui.mobileTableScaleLandscape', 'ui.mobileTableHeight', 'ui.mobileAutoShrink', 'ui.mobileAutoFullscreen', 'ui.mobileTableAspect', 'ui.mobileTurnAlert', 'ui.mobileLayout']) {
      expect(phone, k).toContain(k);
      expect(desktop, k).not.toContain(k);
    }
  });
  it('paměť zabalených karet se sdílí v sadě vzhled', () => {
    for (const k of ['ui.foldState', 'ui.statsSeason', 'ui.statsCompare', 'ui.adminLast', 'ui.chatList', 'ui.chatTablesWithChannels', 'ui.chatHideEmpty']) expect(keysOfSet(reg, 'look'), k).toContain(k);
  });
  it('každé osobní nastavení patří do některé sady', () => {
    const all = new Set(SETTING_SETS.flatMap((s) => keysOfSet(reg, s.id)));
    const personal = reg.all().filter((d) => d.scopes?.includes('user') && !d.secret).map((d) => d.key);
    expect(personal.filter((k) => !all.has(k))).toEqual([]);
  });
  it('i nejdelší rozmístění se vejde do limitu nastavení a při převzetí se nezahodí', () => {
    const text = serializeOrder(fullest());
    for (const key of [ORDER_KEY, ORDER_KEY_LANDSCAPE]) expect(text.length, key).toBeLessThanOrEqual(Number((reg.get(key) as { maxLength: number }).maxLength));
    const device: Record<string, SettingValue> = { [ORDER_KEY]: text, [ORDER_KEY_LANDSCAPE]: text, 'ui.mobileTableScale': 70, 'ui.mobileTableScaleLandscape': 80, 'ui.mobileTableHeight': 120, 'ui.mobileAutoShrink': false, 'ui.mobileAutoFullscreen': true };
    const { dropped } = sanitizeSettingsProfile(reg, { user: {}, device, deviceKind: 'phone', set: 'tablePhone' });
    expect(dropped).toEqual([]);
  });
  it('uložené rozmístění po převzetí vypadá stejně', () => {
    const o = fullest();
    const back = parseMobileOrder(serializeOrder(o));
    expect(back).toEqual(o);
  });
});
