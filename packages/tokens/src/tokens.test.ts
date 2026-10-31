import { describe, it, expect } from 'vitest';
import {
  BUILTIN_THEMES,
  TOKEN_DEFS,
  resolveTokens,
  themeToCss,
  importTheme,
  exportTheme,
  checkContrast,
  contrastRatio,
  cssVarName,
  isSafeValue,
  validateTokenValue,
  themeAttributes,
  dataAttrName,
  migrateTheme,
  THEME_SCHEMA_VERSION,
  tokenDef,
} from './index.js';

describe('kontrast', () => {
  it('známé hodnoty WCAG', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });

  for (const theme of BUILTIN_THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      it(`vestavěný motiv ${theme.id} (${mode}) splňuje kontrast AA`, () => {
        expect(checkContrast(resolveTokens(theme, mode))).toEqual([]);
      });
    }
  }
});

describe('motivy', () => {
  it('každý token má výchozí hodnotu pro oba režimy a klíče jsou unikátní', () => {
    expect(new Set(TOKEN_DEFS.map((d) => d.key)).size).toBe(TOKEN_DEFS.length);
    for (const d of TOKEN_DEFS) {
      expect(d.light).toBeDefined();
      expect(d.dark).toBeDefined();
    }
  });

  it('CSS obsahuje proměnné pro světlý i tmavý režim', () => {
    const css = themeToCss(BUILTIN_THEMES[0]!);
    expect(css).toContain('[data-mode="dark"]');
    expect(css).toContain(`${cssVarName('color.bg')}:`);
  });

  it('export a import jsou bez ztráty, neznámé a nebezpečné hodnoty se vyřadí', () => {
    const theme = { ...BUILTIN_THEMES[1]!, builtin: false };
    const res = importTheme(exportTheme(theme));
    expect(res.ok && res.theme.light).toEqual(theme.light);

    const bad = importTheme(
      JSON.stringify({
        schemaVersion: 1,
        id: 'x',
        name: 'x',
        light: { 'color.bg': '#fff; background:url(http://x)', 'neznamy.token': '1', 'color.text': '#111111' },
        dark: {},
      }),
    );
    expect(bad.ok && bad.theme.light).toEqual({ 'color.text': '#111111' });
    expect(bad.ok && bad.dropped.sort()).toEqual(['color.bg', 'neznamy.token']);
    expect(importTheme('nejson').ok).toBe(false);
  });

  it('isSafeValue odmítá vkládání CSS', () => {
    expect(isSafeValue('#fff')).toBe(true);
    expect(isSafeValue('red; x:y')).toBe(false);
    expect(isSafeValue('url(x)')).toBe(false);
  });
});

describe('rozšířené tokeny', () => {
  it('výchozí hodnoty všech tokenů jsou platné pro svůj typ', () => {
    for (const d of TOKEN_DEFS) {
      expect(validateTokenValue(d, d.light), d.key + ' světlý').toBe(true);
      expect(validateTokenValue(d, d.dark), d.key + ' tmavý').toBe(true);
    }
  });

  it('kontrola hodnot podle typu: výčet, číslo v rozsahu, barva, délka, obrázek', () => {
    expect(validateTokenValue(tokenDef('cards.style')!, 'bigIndex')).toBe(true);
    expect(validateTokenValue(tokenDef('cards.style')!, 'ruzove')).toBe(false);
    expect(validateTokenValue(tokenDef('table.aspect')!, '1.2')).toBe(true);
    expect(validateTokenValue(tokenDef('table.aspect')!, '9')).toBe(false);
    expect(validateTokenValue(tokenDef('color.felt')!, '#0a0')).toBe(true);
    expect(validateTokenValue(tokenDef('color.felt')!, 'red')).toBe(false);
    expect(validateTokenValue(tokenDef('shape.radiusMd')!, '12px')).toBe(true);
    expect(validateTokenValue(tokenDef('shape.radiusMd')!, '12')).toBe(false);
    expect(validateTokenValue(tokenDef('image.felt')!, 'asset:123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(validateTokenValue(tokenDef('image.felt')!, 'https://example.com/x.png')).toBe(false);
    expect(validateTokenValue(tokenDef('shape.shadow')!, '0 4px 12px #00000055')).toBe(true);
    expect(validateTokenValue(tokenDef('shape.shadow')!, '0 4px 12px red; x:y')).toBe(false);
  });

  it('výčtové tokeny se promítnou do datových atributů, obrázek do url(), text do CSS nejde', () => {
    const theme = { ...BUILTIN_THEMES[0]!, light: { 'cards.fourColor': 'on', 'image.felt': 'asset:123e4567-e89b-12d3-a456-426614174000', 'table.logoText': 'Hospoda' }, dark: {} };
    const attrs = themeAttributes(resolveTokens(theme, 'light'));
    expect(attrs['data-tk-cards-four-color']).toBe('on');
    expect(attrs['data-tk-buttons-style']).toBe('solid');
    expect(dataAttrName('anim.enabled')).toBe('data-tk-anim-enabled');
    const css = themeToCss(theme);
    expect(css).toContain('url("/api/theme-assets/123e4567-e89b-12d3-a456-426614174000")');
    expect(css).not.toContain('Hospoda');
    expect(css).toContain('--tk-image-roomBg:none;');
  });

  it('starší motiv se migruje a chybějící tokeny doplní výchozí hodnoty; neplatné hodnoty se při importu vyřadí', () => {
    const old = { schemaVersion: 1, id: 'stary', name: 'Starý', light: { 'color.bg': '#112233' }, dark: {} };
    const res = importTheme(JSON.stringify(old));
    expect(res.ok && res.theme.schemaVersion).toBe(THEME_SCHEMA_VERSION);
    expect(res.ok && resolveTokens(res.theme, 'light')['cards.style']).toBe('classic');
    expect(migrateTheme({ ...BUILTIN_THEMES[0]!, schemaVersion: 1 }).schemaVersion).toBe(THEME_SCHEMA_VERSION);
    const bad = importTheme(JSON.stringify({ ...old, light: { 'cards.style': 'ruzove', 'table.aspect': '99', 'color.bg': '#112233' } }));
    expect(bad.ok && bad.theme.light).toEqual({ 'color.bg': '#112233' });
    expect(bad.ok && bad.dropped.sort()).toEqual(['cards.style', 'table.aspect']);
  });
});

describe('vestavěné motivy', () => {
  it('je jich dvaadvacet, mají jedinečná id a všechny jejich hodnoty jsou platné podle schématu', () => {
    expect(BUILTIN_THEMES.map((x) => x.id)).toEqual(['classic-green', 'high-contrast', 'red-salon', 'casino', 'night', 'minimal', 'retro', 'blue-club', 'gold-evening', 'pastel', 'emerald-royal', 'ocean', 'burgundy', 'sunset', 'forest', 'neon', 'ice', 'desert', 'graphite', 'sakura', 'vintage', 'lava']);
    for (const theme of BUILTIN_THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        for (const [k, v] of Object.entries(theme[mode])) {
          const d = tokenDef(k);
          expect(d, `${theme.id}: neznámý token ${k}`).toBeTruthy();
          expect(validateTokenValue(d!, v), `${theme.id}/${mode}/${k}=${v}`).toBe(true);
        }
      }
    }
  });
});

describe('sdílené tokeny platí v obou režimech', () => {
  it('tvary, velikosti a styly uvedené jen ve světlém režimu motiv zdědí i tmavý; barvy ne', () => {
    const minimal = BUILTIN_THEMES.find((x) => x.id === 'minimal')!;
    const dark = resolveTokens(minimal, 'dark');
    expect(dark['table.aspect']).toBe('1.8');
    expect(dark['table.edgeWidth']).toBe('2px');
    expect(dark['cards.style']).toBe('minimal');
    // barvy si tmavý režim určuje sám
    expect(dark['color.felt']).toBe(minimal.dark['color.felt']);
  });

  it('žádný vestavěný motiv nemá vlastní velikost karet (všechny motivy mají karty stejně velké)', () => {
    for (const theme of BUILTIN_THEMES) for (const mode of ['light', 'dark'] as const) expect(resolveTokens(theme, mode)['size.cardWidth'], `${theme.id}/${mode}`).toBe(TOKEN_DEFS.find((d) => d.key === 'size.cardWidth')!.light);
  });
});
