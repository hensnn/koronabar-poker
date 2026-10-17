import { describe, expect, it } from 'vitest';
import { BUILTIN_THEMES, checkContrast, contrastRatio, resolveTokens } from './index.js';
import { fixContrast, generateVariant, harmony, hexToHsl, hslToHex, parseColor, rgbToHex, simulateColorBlind } from './color.js';

describe('barvy', () => {
  it('převody HEX ↔ RGB ↔ HSL jsou bez ztráty (na zaokrouhlení)', () => {
    for (const hex of ['#1f6b45', '#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#7a1f2b', '#808080']) {
      const back = hslToHex(hexToHsl(hex));
      const a = parseColor(hex).rgb;
      const b = parseColor(back).rgb;
      expect(Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b), hex).toBeLessThanOrEqual(3);
    }
    expect(rgbToHex({ r: 255, g: 0, b: 128 })).toBe('#ff0080');
    expect(parseColor('#11223380').alpha).toBeCloseTo(0.5, 1);
    expect(rgbToHex({ r: 1, g: 2, b: 3 }, 0.5)).toBe('#01020380');
    expect(hexToHsl('#ff0000')).toMatchObject({ h: 0, s: 100 });
  });

  it('harmonie vrací správný počet barev a první je základní', () => {
    expect(harmony('#1f6b45', 'complementary')).toHaveLength(2);
    expect(harmony('#1f6b45', 'triadic')).toHaveLength(3);
    expect(harmony('#1f6b45', 'tetradic')).toHaveLength(4);
    expect(harmony('#1f6b45', 'triadic')[0]).toBe('#1f6b45');
    const comp = harmony('#ff0000', 'complementary')[1]!;
    expect(hexToHsl(comp).h).toBeCloseTo(180, 0);
  });

  it('dorovnání kontrastu posune popředí na požadovaný poměr', () => {
    const fixed = fixContrast('#777777', '#ffffff', 4.5);
    expect(contrastRatio(fixed, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(fixContrast('#000000', '#ffffff', 4.5)).toBe('#000000');
    const onDark = fixContrast('#333333', '#111111', 4.5);
    expect(contrastRatio(onDark, '#111111')).toBeGreaterThanOrEqual(4.5);
  });

  it('návrh druhé varianty: tmavé plochy ze světlých a čitelný text', () => {
    const light = resolveTokens(BUILTIN_THEMES[0]!, 'light');
    const dark = generateVariant(light, 'light', 'dark');
    expect(hexToHsl(dark['color.bg']!).l).toBeLessThan(25);
    expect(hexToHsl(dark['color.text']!).l).toBeGreaterThan(70);
    expect(checkContrast({ ...resolveTokens(BUILTIN_THEMES[0]!, 'dark'), ...dark })).toEqual([]);
    const back = generateVariant(resolveTokens(BUILTIN_THEMES[0]!, 'dark'), 'dark', 'light');
    expect(hexToHsl(back['color.bg']!).l).toBeGreaterThan(80);
    expect(checkContrast({ ...resolveTokens(BUILTIN_THEMES[0]!, 'light'), ...back })).toEqual([]);
  });

  it('simulace barvosleposti: šedá zůstává šedá, červená a zelená se u protanopie/deuteranopie přiblíží', () => {
    expect(simulateColorBlind('#808080', 'protanopia')).toBe('#808080');
    const dist = (a: string, b: string) => {
      const x = parseColor(a).rgb;
      const y = parseColor(b).rgb;
      return Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b);
    };
    const normal = dist('#c0262d', '#1b7a3d');
    expect(dist(simulateColorBlind('#c0262d', 'deuteranopia'), simulateColorBlind('#1b7a3d', 'deuteranopia'))).toBeLessThan(normal);
    expect(dist(simulateColorBlind('#c0262d', 'protanopia'), simulateColorBlind('#1b7a3d', 'protanopia'))).toBeLessThan(normal);
  });
});
