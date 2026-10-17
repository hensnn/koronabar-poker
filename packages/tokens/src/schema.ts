import { z } from 'zod';

/** Verze schématu motivu. Starší motivy se při načtení migrují (`migrateTheme`) a chybějící tokeny doplní výchozí hodnoty. */
export const THEME_SCHEMA_VERSION = 2;

export type TokenType = 'color' | 'length' | 'shadow' | 'font' | 'number' | 'enum' | 'text' | 'image';
export type TokenCategory = 'colors' | 'table' | 'cards' | 'chips' | 'players' | 'buttons' | 'typography' | 'shape' | 'animation';

/** Definice jednoho tokenu. Všechny tokeny jsou v jednom schématu (výchozí hodnoty, popisy, kategorie). */
export interface TokenDef {
  key: string;
  type: TokenType;
  category: TokenCategory;
  /** Výchozí hodnoty pro světlý a tmavý režim. */
  light: string;
  dark: string;
  /** U výčtu možné hodnoty. */
  options?: string[];
  /** U čísla rozsah a krok (pro posuvník v editoru). */
  min?: number;
  max?: number;
  step?: number;
  /** Token se v editoru nastavuje jen jednou pro oba režimy (tvary, písma, výčty). */
  shared: boolean;
}

const c = (key: string, light: string, dark: string, category: TokenCategory = 'colors'): TokenDef => ({ key, type: 'color', category, light, dark, shared: false });
const len = (key: string, v: string, category: TokenCategory = 'shape'): TokenDef => ({ key, type: 'length', category, light: v, dark: v, shared: true });
const sh = (key: string, v: string, category: TokenCategory = 'shape'): TokenDef => ({ key, type: 'shadow', category, light: v, dark: v, shared: true });
const font = (key: string, v: string): TokenDef => ({ key, type: 'font', category: 'typography', light: v, dark: v, shared: true });
const num = (key: string, v: number, category: TokenCategory, min: number, max: number, step: number): TokenDef => ({ key, type: 'number', category, light: String(v), dark: String(v), min, max, step, shared: true });
const en = (key: string, v: string, options: string[], category: TokenCategory): TokenDef => ({ key, type: 'enum', category, light: v, dark: v, options, shared: true });
const text = (key: string, v: string, category: TokenCategory): TokenDef => ({ key, type: 'text', category, light: v, dark: v, shared: true });
const image = (key: string, category: TokenCategory): TokenDef => ({ key, type: 'image', category, light: 'none', dark: 'none', shared: true });

export const TOKEN_DEFS: TokenDef[] = [
  // Základní barvy
  c('color.bg', '#f4f6f4', '#0f1512'),
  c('color.surface', '#ffffff', '#18211c'),
  c('color.surfaceRaised', '#eef2ee', '#212d26'),
  c('color.text', '#16211b', '#e8efe9'),
  c('color.textMuted', '#4a5a50', '#a5b5aa'),
  c('color.border', '#c9d3cc', '#33443a'),
  c('color.primary', '#1f6b45', '#4cc38a'),
  c('color.onPrimary', '#ffffff', '#08140d'),
  c('color.secondary', '#8a6d1f', '#e0b84c'),
  c('color.accent', '#b3261e', '#ff6b5e'),
  c('color.success', '#1b7a3d', '#4cc38a'),
  c('color.warning', '#8a5a00', '#f0b64a'),
  c('color.danger', '#b3261e', '#ff6b5e'),
  c('color.info', '#1c5d99', '#6fb1ee'),
  c('color.focus', '#1c5d99', '#6fb1ee'),
  // Akční tlačítka
  c('color.actionFold', '#8a1f1f', '#a8302b', 'buttons'),
  c('color.actionCheck', '#1c5d99', '#1f64b0', 'buttons'),
  c('color.actionCall', '#1f6b45', '#1e7a50', 'buttons'),
  c('color.actionRaise', '#8a5a00', '#8f5f00', 'buttons'),
  c('color.onAction', '#ffffff', '#ffffff', 'buttons'),
  en('buttons.style', 'solid', ['solid', 'outline', 'glossy'], 'buttons'),
  len('shape.buttonRadius', '8px', 'buttons'),
  // Herní stůl
  c('color.felt', '#1f6b45', '#17503a', 'table'),
  c('color.feltBorder', '#5b3a1f', '#3a2614', 'table'),
  c('color.roomBg', '#e3e8e4', '#0b0f0d', 'table'),
  c('color.vignette', '#00000033', '#00000099', 'table'),
  len('table.edgeWidth', '8px', 'table'),
  len('table.radius', '9999px', 'table'),
  len('table.vignetteSize', '80px', 'table'),
  num('table.aspect', 1.5, 'table', 1, 2.5, 0.05),
  text('table.logoText', '', 'table'),
  image('image.felt', 'table'),
  image('image.roomBg', 'table'),
  image('image.logo', 'table'),
  // Karty
  c('color.cardFace', '#ffffff', '#f7f7f2', 'cards'),
  c('color.cardBack', '#7a1f2b', '#5c1620', 'cards'),
  c('color.cardBackAccent', '#e0b84c', '#c9a238', 'cards'),
  c('color.cardInk', '#16211b', '#16211b', 'cards'),
  c('color.suitRed', '#c0262d', '#c0262d', 'cards'),
  c('color.suitHeart', '#c0262d', '#c0262d', 'cards'),
  c('color.suitDiamond', '#1c5dbf', '#1c5dbf', 'cards'),
  c('color.suitClub', '#1b7a3d', '#1b7a3d', 'cards'),
  c('color.suitSpade', '#16211b', '#16211b', 'cards'),
  en('cards.style', 'classic', ['classic', 'minimal', 'bigIndex'], 'cards'),
  en('cards.fourColor', 'off', ['off', 'on'], 'cards'),
  en('cards.back', 'stripes', ['solid', 'stripes', 'dots', 'diamonds'], 'cards'),
  len('size.cardWidth', '56px', 'cards'),
  len('shape.cardRadius', '4px', 'cards'),
  num('anim.flip', 250, 'cards', 0, 1000, 25),
  image('image.cardBack', 'cards'),
  // Žetony a pot
  c('color.chipWhite', '#f1efe6', '#e9e6d8', 'chips'),
  c('color.chipRed', '#b3261e', '#c4372f', 'chips'),
  c('color.chipGreen', '#1b7a3d', '#1f8a47', 'chips'),
  c('color.chipBlue', '#1c5d99', '#2a6db0', 'chips'),
  c('color.chipBlack', '#222a26', '#3a4540', 'chips'),
  en('chips.display', 'number', ['number', 'chips', 'both'], 'chips'),
  // Hráči u stolu
  c('color.turnGlow', '#1f6b45', '#4cc38a', 'players'),
  c('color.timerOk', '#1b7a3d', '#4cc38a', 'players'),
  c('color.timerBank', '#8a5a00', '#f0b64a', 'players'),
  c('color.dealerButton', '#8a6d1f', '#e0b84c', 'players'),
  len('shape.avatarRadius', '9999px', 'players'),
  len('size.avatar', '64px', 'players'),
  en('timer.style', 'ring', ['ring', 'bar'], 'players'),
  en('anim.pulse', 'on', ['off', 'on'], 'players'),
  // Tvary a rozměry
  len('shape.radiusSm', '4px'),
  len('shape.radiusMd', '8px'),
  len('shape.radiusLg', '16px'),
  len('shape.borderWidth', '1px'),
  sh('shape.shadow', '0 1px 3px #00000040'),
  len('space.unit', '4px'),
  num('density.scale', 1, 'shape', 0.75, 1.5, 0.05),
  en('layout.chat', 'bottom', ['bottom', 'right'], 'shape'),
  // Typografie
  font('font.body', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'),
  font('font.heading', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'),
  font('font.number', 'ui-monospace, "Cascadia Mono", Menlo, monospace'),
  len('size.textBase', '16px', 'typography'),
  num('font.weightBody', 400, 'typography', 300, 700, 100),
  num('font.weightHeading', 700, 'typography', 400, 900, 100),
  num('font.lineHeight', 1.5, 'typography', 1.1, 2, 0.05),
  en('font.tabular', 'on', ['off', 'on'], 'typography'),
  // Animace
  num('anim.speed', 1, 'animation', 0.25, 3, 0.25),
  en('anim.enabled', 'on', ['off', 'on'], 'animation'),
];

export const tokenKeys = TOKEN_DEFS.map((t) => t.key);
export const tokenDef = (key: string): TokenDef | undefined => TOKEN_DEFS.find((t) => t.key === key);

export const themeSchema = z.object({
  schemaVersion: z.number().int().min(1).max(THEME_SCHEMA_VERSION),
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(80),
  builtin: z.boolean().optional(),
  light: z.record(z.string(), z.string().max(200)).default({}),
  dark: z.record(z.string(), z.string().max(200)).default({}),
});

export interface Theme {
  schemaVersion: number;
  id: string;
  name: string;
  builtin?: boolean;
  /** Částečné přepsání výchozích tokenů. Chybějící hodnoty doplní výchozí. */
  light: Record<string, string>;
  dark: Record<string, string>;
}

export type Mode = 'light' | 'dark';
export type ResolvedTokens = Record<string, string>;
