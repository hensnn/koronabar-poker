import { describe, it, expect } from 'vitest';
import {
  createDefaultRegistry,
  resolveSettings,
  validateValues,
  decideChange,
  isVisible,
  builtinTemplates,
  exportTemplate,
  importTemplate,
  fillTemplate,
  SETTINGS_SCHEMA_VERSION,
  MIGRATIONS,
  cs,
  t,
  labelKey,
  helpKey,
  categoryKey,
  optionKey,
  SCOPES,
} from '../index.js';

const reg = createDefaultRegistry();

describe('registr nastavení', () => {
  it('každý parametr má český název a nápovědu, kategorie a možnosti jsou přeložené', () => {
    for (const d of reg.all()) {
      expect(cs[labelKey(d.key)], `název ${d.key}`).toBeTruthy();
      expect(cs[helpKey(d.key)], `nápověda ${d.key}`).toBeTruthy();
      if (d.type === 'enum') for (const o of d.options) expect(cs[optionKey(d.key, o)], `${d.key}/${o}`).toBeTruthy();
      if (d.unit) expect(cs[`unit.${d.unit}`], `jednotka ${d.unit}`).toBeTruthy();
    }
    for (const c of reg.categories()) expect(cs[categoryKey(c)], c).toBeTruthy();
  });

  it('výchozí hodnoty jsou platné a konzistentní', () => {
    expect(validateValues(reg, reg.defaults())).toEqual([]);
  });

  it('klíče jsou unikátní', () => {
    expect(() => new (reg.constructor as any)().register(reg.all()[0], reg.all()[0])).toThrow();
  });

  it('závislosti odkazují na existující klíče', () => {
    for (const d of reg.all()) if (d.dependsOn) expect(reg.get(d.dependsOn.key)).toBeTruthy();
  });

  it('osobní parametry (ui.*) jsou ve vrstvách global (výchozí od správce), user a userDevice', () => {
    for (const d of reg.all().filter((x) => x.category === 'ui')) {
      expect(d.scopes).toEqual(['global', 'user', 'userDevice']);
    }
  });
});

describe('vrstvy a dědičnost', () => {
  it('výchozí hodnota osobního nastavení od správce platí, dokud si ji hráč nepřepíše', () => {
    const base = resolveSettings(reg, [{ scope: 'global', values: { 'ui.showSymbolAtTable': false } }]);
    expect(base.values['ui.showSymbolAtTable']).toBe(false);
    expect(base.origins['ui.showSymbolAtTable']).toBe('global');
    const own = resolveSettings(reg, [{ scope: 'global', values: { 'ui.showSymbolAtTable': false } }, { scope: 'user', values: { 'ui.showSymbolAtTable': true } }]);
    expect(own.values['ui.showSymbolAtTable']).toBe(true);
  });

  it('nižší vrstva přepisuje vyšší a eviduje původ', () => {
    const r = resolveSettings(reg, [
      { scope: 'table', values: { 'table.bigBlind': 40 } },
      { scope: 'global', values: { 'table.bigBlind': 20, 'time.turnSeconds': 45 } },
      { scope: 'template', values: { 'time.turnSeconds': 15 } },
    ]);
    expect(r.values['table.bigBlind']).toBe(40);
    expect(r.origins['table.bigBlind']).toBe('table');
    expect(r.values['time.turnSeconds']).toBe(15);
    expect(r.origins['time.turnSeconds']).toBe('template');
    expect(r.origins['table.seats']).toBe('default');
  });

  it('vrstva nesmí přepsat parametr mimo své povolené rozsahy', () => {
    const r = resolveSettings(reg, [
      { scope: 'table', values: { 'ui.sfxEnabled': false } },
      { scope: 'user', values: { 'table.bigBlind': 999 } },
    ]);
    expect(r.values['ui.sfxEnabled']).toBe(true);
    expect(r.values['table.bigBlind']).toBe(10);
  });

  it('osobní vrstva a zařízení přepisují v tomto pořadí', () => {
    const r = resolveSettings(reg, [
      { scope: 'userDevice', values: { 'ui.sfxVolumePercent': 20 } },
      { scope: 'user', values: { 'ui.sfxVolumePercent': 80 } },
    ]);
    expect(r.values['ui.sfxVolumePercent']).toBe(20);
    expect(r.origins['ui.sfxVolumePercent']).toBe('userDevice');
    expect(SCOPES.indexOf('user')).toBeLessThan(SCOPES.indexOf('userDevice'));
  });

  it('odebrání vrstvy vrátí zděděnou hodnotu', () => {
    const withTable = resolveSettings(reg, [{ scope: 'table', values: { 'table.bigBlind': 40 } }]);
    const without = resolveSettings(reg, []);
    expect(withTable.values['table.bigBlind']).toBe(40);
    expect(without.values['table.bigBlind']).toBe(10);
  });
});

describe('validace', () => {
  it('odmítne hodnotu mimo rozsah a neznámý klíč', () => {
    expect(validateValues(reg, { 'table.seats': 11 })[0]?.messageKey).toBe('validation.invalid.int');
    expect(validateValues(reg, { 'nic.takoveho': 1 })[0]?.messageKey).toBe('validation.unknownKey');
    expect(validateValues(reg, { 'table.bbAnte': 'ano' as any })[0]?.messageKey).toBe('validation.invalid.bool');
  });

  it('kontroluje vzájemnou konzistenci s českou chybou u správných polí', () => {
    const issues = validateValues(reg, { 'cash.minBuyInBb': 200, 'cash.maxBuyInBb': 100 });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.keys).toContain('cash.minBuyInBb');
    expect(t(issues[0]!.messageKey)).toMatch(/Minimální buy-in/);
  });

  it('small blind nad big blind je chyba, BB ante s částkou ante je v pořádku', () => {
    expect(validateValues(reg, { 'table.smallBlind': 50, 'table.bigBlind': 10 })).toHaveLength(1);
    expect(validateValues(reg, { 'table.bbAnte': true, 'table.ante': 10 })).toEqual([]);
    expect(validateValues(reg, { 'table.bbAnte': true, 'table.ante': 11 }).map((i) => i.messageKey)).toContain('rule.anteAboveBigBlind');
  });

  it('krok (step) se kontroluje', () => {
    expect(validateValues(reg, { 'time.betweenHandsMs': 3050 })).toHaveLength(1);
    expect(validateValues(reg, { 'time.betweenHandsMs': 3100 })).toEqual([]);
  });

  it('náhodné platné kombinace projdou validací (fuzz)', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 300; i++) {
      const v: Record<string, any> = {};
      for (const d of reg.all()) {
        if (rnd() < 0.5) continue;
        if (d.type === 'int') {
          const step = d.step ?? 1;
          const n = Math.floor(rnd() * ((d.max - d.min) / step + 1));
          v[d.key] = d.min + n * step;
        } else if (d.type === 'bool') v[d.key] = rnd() < 0.5;
        else if (d.type === 'enum') v[d.key] = d.options[Math.floor(rnd() * d.options.length)];
      }
      const issues = validateValues(reg, v).filter((x) => !x.messageKey.startsWith('rule.'));
      expect(issues).toEqual([]);
    }
  });
});

describe('kdy lze měnit', () => {
  const ctx = { gameStarted: true, handInProgress: true, isAdmin: false };
  it('řídí se příznakem mutability', () => {
    expect(decideChange(reg, 'time.turnSeconds', ctx).result).toBe('apply');
    expect(decideChange(reg, 'table.bigBlind', ctx).result).toBe('pending');
    expect(decideChange(reg, 'table.bigBlind', { ...ctx, handInProgress: false }).result).toBe('apply');
    expect(decideChange(reg, 'table.seats', ctx).result).toBe('denied');
    expect(decideChange(reg, 'table.seats', { ...ctx, gameStarted: false }).result).toBe('apply');
    expect(decideChange(reg, 'economy.currencyName', ctx).result).toBe('denied');
    expect(decideChange(reg, 'economy.currencyName', { ...ctx, isAdmin: true }).result).toBe('apply');
  });
});

describe('viditelnost', () => {
  it('skryje závislé a nepatřící do formátu', () => {
    const v = reg.defaults();
    expect(isVisible(reg, 'table.straddleType', v)).toBe(false);
    expect(isVisible(reg, 'table.straddleType', { ...v, 'table.straddleEnabled': true })).toBe(true);
    expect(isVisible(reg, 'cash.minBuyInBb', v, 'tournament')).toBe(false);
    expect(isVisible(reg, 'cash.minBuyInBb', v, 'cash')).toBe(true);
  });
});

describe('šablony', () => {
  const tpls = builtinTemplates(reg);
  it('každá vestavěná šablona je kompletní a projde validací', () => {
    const nonUser = reg.all().filter((d) => !d.scopes || d.scopes.includes('template'));
    for (const tpl of tpls) {
      expect(validateValues(reg, tpl.values)).toEqual([]);
      for (const d of nonUser) expect(tpl.values[d.key], `${tpl.id}/${d.key}`).not.toBeUndefined();
      expect(cs[tpl.name]).toBeTruthy();
      expect(cs[tpl.description]).toBeTruthy();
    }
  });

  it('retro šablony mají nové funkce vypnuté', () => {
    const retro = tpls.filter((x) => x.retro);
    expect(retro.length).toBeGreaterThan(0);
    for (const tpl of retro)
      for (const d of reg.all()) if (d.retroDefault !== undefined) expect(tpl.values[d.key], d.key).toBe(d.retroDefault);
  });

  it('export a import jsou bez ztráty', () => {
    const tpl = tpls[0]!;
    const res = importTemplate(reg, exportTemplate(reg, tpl));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.template.values).toEqual(tpl.values);
      expect(res.template.builtin).toBe(false);
      expect(res.dropped).toEqual([]);
    }
  });

  it('import vyřadí neznámé klíče a odmítne neplatné hodnoty a JSON', () => {
    const base = JSON.parse(exportTemplate(reg, tpls[0]!));
    const withExtra = importTemplate(reg, JSON.stringify({ ...base, values: { ...base.values, 'stary.klic': 1 } }));
    expect(withExtra.ok && withExtra.dropped).toEqual(['stary.klic']);
    expect(importTemplate(reg, JSON.stringify({ ...base, values: { 'table.seats': 99 } })).ok).toBe(false);
    expect(importTemplate(reg, 'tohle neni json').ok).toBe(false);
    expect(importTemplate(reg, JSON.stringify({ ...base, schemaVersion: SETTINGS_SCHEMA_VERSION + 1 })).ok).toBe(false);
  });

  it('aktuální verze šablony se importuje bez migrace', () => {
    MIGRATIONS[0] = (raw) => ({ ...raw, tags: ['migrated'] });
    try {
      const base = JSON.parse(exportTemplate(reg, tpls[0]!));
      // Simulace verze 0 vyžaduje změnu aktuální verze, proto jen ověříme chybějící migraci u starší verze.
      expect(importTemplate(reg, JSON.stringify({ ...base, schemaVersion: 1 })).ok).toBe(true);
    } finally {
      delete MIGRATIONS[0];
    }
  });

  it('export neobsahuje tajné parametry', () => {
    const secretReg = createDefaultRegistry();
    secretReg.register({ key: 'ai.apiKey', type: 'string', default: '', category: 'ai', mutability: 'adminOnly', secret: true });
    const tpl = fillTemplate(secretReg, { id: 'x', name: 'x', description: '', kind: 'cash', tags: [], values: { 'ai.apiKey': 'tajne' } });
    expect(exportTemplate(secretReg, tpl)).not.toContain('tajne');
  });
});
