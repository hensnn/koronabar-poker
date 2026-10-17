import { contrastRatio, parseHex, CONTRAST_PAIRS } from './contrast.js';
import { TOKEN_DEFS, type Mode } from './schema.js';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

/** Barva ve tvaru #RGB / #RRGGBB / #RRGGBBAA → složky 0–255 a průhlednost 0–1. */
export function parseColor(hex: string): { rgb: Rgb; alpha: number } {
  const [r, g, b] = parseHex(hex);
  const h = hex.trim().replace('#', '');
  const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { rgb: { r, g, b }, alpha };
}

export function rgbToHex({ r, g, b }: Rgb, alpha = 1): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha < 1 ? hex2(alpha * 255) : ''}`;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const S = clamp(s, 0, 100) / 100;
  const L = clamp(l, 0, 100) / 100;
  const H = ((h % 360) + 360) % 360;
  const k = (n: number) => (n + H / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

export const hexToHsl = (hex: string): Hsl => rgbToHsl(parseColor(hex).rgb);
export const hslToHex = (hsl: Hsl, alpha = 1): string => rgbToHex(hslToRgb(hsl), alpha);

export type HarmonyKind = 'complementary' | 'analogous' | 'triadic' | 'splitComplementary' | 'tetradic';

/** Harmonická paleta z jedné základní barvy (základní barva je první). */
export function harmony(base: string, kind: HarmonyKind): string[] {
  const hsl = hexToHsl(base);
  const turn = (deg: number) => hslToHex({ ...hsl, h: hsl.h + deg });
  switch (kind) {
    case 'complementary':
      return [base, turn(180)];
    case 'analogous':
      return [turn(-30), base, turn(30)];
    case 'triadic':
      return [base, turn(120), turn(240)];
    case 'splitComplementary':
      return [base, turn(150), turn(210)];
    case 'tetradic':
      return [base, turn(90), turn(180), turn(270)];
  }
}

/** Posune světlost popředí tak, aby proti pozadí dosáhlo požadovaného kontrastu (nebo se dostalo co nejblíž). */
export function fixContrast(fg: string, bg: string, min: number): string {
  if (contrastRatio(fg, bg) >= min) return fg;
  const { rgb, alpha } = parseColor(fg);
  const hsl = rgbToHsl(rgb);
  // směr, kde je větší rezerva: ke světlé, nebo k tmavé
  const towardLight = contrastRatio('#ffffff', bg) >= contrastRatio('#000000', bg);
  let best = fg;
  let bestRatio = contrastRatio(fg, bg);
  for (let l = hsl.l; towardLight ? l <= 100 : l >= 0; l += towardLight ? 2 : -2) {
    const c = hslToHex({ ...hsl, l: clamp(l, 0, 100) }, alpha);
    const r = contrastRatio(c, bg);
    if (r > bestRatio) {
      best = c;
      bestRatio = r;
    }
    if (r >= min) return c;
  }
  return best;
}

/**
 * Návrh druhé varianty motivu (světlé ze tmavé a naopak): světlost barev se převrátí, plochy zůstanou
 * plochami a popředí se dorovná na potřebný kontrast. Je to jen výchozí návrh k doladění.
 */
export function generateVariant(source: Record<string, string>, from: Mode, to: Mode): Record<string, string> {
  const out: Record<string, string> = {};
  const lightnessOf = (k: string, l: number): number => {
    // plochy a text se obracejí, výrazné barvy (primární, akční…) se jen zjemní
    if (/^color\.(bg|surface|surfaceRaised|roomBg)$/.test(k)) return to === 'dark' ? 6 + (100 - l) * 0.18 : 100 - (100 - l) * 0.12 - 3;
    if (/^color\.(text|textMuted|border|onPrimary)$/.test(k)) return to === 'dark' ? 100 - l * 0.12 - 2 : 100 - l;
    return to === 'dark' ? clamp(l + (l < 50 ? 18 : 6), 0, 92) : clamp(l - (l > 50 ? 18 : 4), 8, 100);
  };
  for (const d of TOKEN_DEFS) {
    if (d.type !== 'color' || d.shared) continue;
    const val = source[d.key] ?? d[from];
    if (/^color\.(felt|feltBorder|cardFace|cardBack|cardBackAccent|cardInk|suit|chip|onAction|vignette)/.test(d.key)) {
      out[d.key] = d[to]; // stůl, karty a žetony zůstávají podle výchozích hodnot
      continue;
    }
    const { rgb, alpha } = parseColor(val);
    const hsl = rgbToHsl(rgb);
    out[d.key] = hslToHex({ ...hsl, s: to === 'dark' ? hsl.s * 0.9 : hsl.s, l: lightnessOf(d.key, hsl.l) }, alpha);
  }
  // dorovnání kontrastu u dvojic text / pozadí
  for (const p of CONTRAST_PAIRS) {
    const fg = out[p.fg];
    const bg = out[p.bg] ?? TOKEN_DEFS.find((d) => d.key === p.bg)?.[to];
    if (!fg || !bg) continue;
    // jeden společný text na více barvách (onAction, onPrimary): upraví se barva pozadí, ne text
    if (p.fg === 'color.onAction' || p.fg === 'color.onPrimary') out[p.bg] = fixContrast(bg, fg, p.min);
    else out[p.fg] = fixContrast(fg, bg, p.min);
  }
  return out;
}

// ---------- simulace barvosleposti ----------

export type ColorBlindKind = 'protanopia' | 'deuteranopia' | 'tritanopia';

/** Matice 3×3 pro SVG filtr (Machado et al. 2009, plná závažnost). */
export const COLOR_BLIND_MATRIX: Record<ColorBlindKind, number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

/** Barva tak, jak ji vidí člověk s danou poruchou (pro kontrolu rozlišitelnosti v editoru). */
export function simulateColorBlind(hex: string, kind: ColorBlindKind): string {
  const { rgb, alpha } = parseColor(hex);
  const m = COLOR_BLIND_MATRIX[kind];
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const gam = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  const r = lin(rgb.r);
  const g = lin(rgb.g);
  const b = lin(rgb.b);
  return rgbToHex({ r: gam(clamp(m[0]! * r + m[1]! * g + m[2]! * b, 0, 1)), g: gam(clamp(m[3]! * r + m[4]! * g + m[5]! * b, 0, 1)), b: gam(clamp(m[6]! * r + m[7]! * g + m[8]! * b, 0, 1)) }, alpha);
}
