import { describe, expect, it } from 'vitest';
import { createDefaultRegistry, isValidTimeZone, resolveSettings, RETIRED_SETTING_KEYS, SCOPES, timezoneOf, validateValues } from '../index.js';

const reg = createDefaultRegistry();

describe('paměť výsledků resolveSettings', () => {
  it('stejné vrstvy dají stejný výsledek, ale vždy novou kopii', () => {
    const global = { 'economy.startingBalance': 5000 };
    const a = resolveSettings(reg, [{ scope: 'global', values: global }]);
    const b = resolveSettings(reg, [{ scope: 'global', values: global }]);
    expect(b.values).toEqual(a.values);
    expect(b.values).not.toBe(a.values);
    a.values['economy.startingBalance'] = 1;
    expect(resolveSettings(reg, [{ scope: 'global', values: global }]).values['economy.startingBalance']).toBe(5000);
  });

  it('nový objekt vrstvy i změna „na místě“ dají novou hodnotu', () => {
    const table: Record<string, number> = { 'table.bigBlind': 20 };
    const layers = [{ scope: 'table' as const, values: table }];
    expect(resolveSettings(reg, layers).values['table.bigBlind']).toBe(20);
    table['table.bigBlind'] = 40;
    expect(resolveSettings(reg, layers).values['table.bigBlind']).toBe(40);
    delete table['table.bigBlind'];
    expect(resolveSettings(reg, layers).values['table.bigBlind']).toBe(10);
    expect(resolveSettings(reg, [{ scope: 'table', values: { 'table.bigBlind': 60 } }]).values['table.bigBlind']).toBe(60);
  });

  it('pořadí vrstev v seznamu nerozhoduje, rozhoduje pořadí SCOPES', () => {
    const a = resolveSettings(reg, [
      { scope: 'user', values: { 'ui.sfxVolumePercent': 30 } },
      { scope: 'global', values: { 'ui.sfxVolumePercent': 50 } },
    ]);
    expect(a.values['ui.sfxVolumePercent']).toBe(30);
    expect(a.origins['ui.sfxVolumePercent']).toBe('user');
  });

  it('výchozí hodnoty a seznam definic jsou sdílené a zmrazené', () => {
    expect(reg.defaults()).toBe(reg.defaults());
    expect(Object.isFrozen(reg.defaults())).toBe(true);
    expect(reg.all()).toBe(reg.all());
  });
});

describe('herní parametry a globální vrstva', () => {
  it('parametry s appliesTo (cash, turnaj, živá hra) jsou označené globalHidden, ostatní ne', () => {
    for (const d of reg.all()) {
      const game = d.scopes === undefined && !!d.appliesTo && d.appliesTo !== 'all';
      expect(!!d.globalHidden, d.key).toBe(game);
    }
    expect(reg.get('table.bigBlind')!.globalHidden).toBe(true);
    expect(reg.get('table.straddleMultiplier')!.appliesTo).toBe('cash');
    expect(reg.get('time.turnSeconds')!.globalHidden).toBeUndefined();
    expect(reg.get('economy.startingBalance')!.globalHidden).toBeUndefined();
  });

  it('globální vrstva se při vyhodnocení dál respektuje (základ pro testy a skripty)', () => {
    expect(resolveSettings(reg, [{ scope: 'global', values: { 'cash.minBuyInBb': 10 } }]).values['cash.minBuyInBb']).toBe(10);
  });

  it('nepoužívaný rozsah „game“ už neexistuje a table.variant je vyřazený klíč', () => {
    expect(SCOPES).not.toContain('game');
    expect(reg.get('table.variant')).toBeUndefined();
    expect(RETIRED_SETTING_KEYS.has('table.variant')).toBe(true);
    expect(validateValues(reg, { 'table.variant': 'nlhe' })).toEqual([]);
  });

  it('podmínka osobní volby odkazuje na existující globální klíč', () => {
    for (const d of reg.all()) if (d.userChoiceDependsOn) expect(reg.get(d.userChoiceDependsOn.key)?.scopes, d.key).toContain('global');
    expect(reg.get('announcer.userVoice')!.userChoiceDependsOn).toEqual({ key: 'announcer.allowUserChoice', truthy: true });
  });
});

describe('časové pásmo aplikace', () => {
  it('ověřuje název pásma podle IANA', () => {
    expect(isValidTimeZone('Europe/Prague')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('system.timezone má výchozí Europe/Prague a neplatné pásmo neprojde validací', () => {
    expect(reg.defaults()['system.timezone']).toBe('Europe/Prague');
    expect(validateValues(reg, { 'system.timezone': 'Europe/Vienna' })).toEqual([]);
    const bad = validateValues(reg, { 'system.timezone': 'Nikde/Nic' });
    expect(bad).toEqual([{ keys: ['system.timezone'], messageKey: 'rule.invalidTimezone' }]);
    expect(timezoneOf({ 'system.timezone': 'Nikde/Nic' })).toBe('Europe/Prague');
    expect(timezoneOf({ 'system.timezone': 'Asia/Tokyo' })).toBe('Asia/Tokyo');
    expect(timezoneOf({})).toBe('Europe/Prague');
  });
});
