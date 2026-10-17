import { DEFAULT_TZ, toLocal } from './schedule.js';

/**
 * Postup hráče: křivka levelů a hodnosti (čisté funkce). Parametry pocházejí z nastavení,
 * nic není napevno; výchozí hodnoty jsou ve schématu nastavení.
 */

export interface LevelCurve {
  /** XP potřebné na přechod z levelu 1 na 2. */
  base: number;
  /** Exponent křivky v setinách (150 = 1,5). */
  exponentPercent: number;
}

/** Kolik XP je třeba na přechod z `level` na `level + 1`. */
export function xpToNext(level: number, c: LevelCurve): number {
  return Math.max(1, Math.round(c.base * Math.pow(Math.max(1, level), c.exponentPercent / 100)));
}

/** Kolik XP celkem je třeba k dosažení `level` (level 1 = 0 XP). */
export function xpForLevel(level: number, c: LevelCurve): number {
  let sum = 0;
  for (let l = 1; l < level; l++) sum += xpToNext(l, c);
  return sum;
}

export interface LevelInfo {
  level: number;
  /** XP v rámci aktuálního levelu. */
  into: number;
  /** XP potřebné na další level. */
  need: number;
}

export function levelFor(xp: number, c: LevelCurve): LevelInfo {
  let level = 1;
  let left = Math.max(0, Math.floor(xp));
  for (;;) {
    const need = xpToNext(level, c);
    if (left < need || level >= 1000) return { level, into: left, need };
    left -= need;
    level++;
  }
}

/** Tabulka levelů pro náhled v nastavení. */
export function levelTable(count: number, c: LevelCurve): { level: number; need: number; total: number }[] {
  const out: { level: number; need: number; total: number }[] = [];
  let total = 0;
  for (let l = 1; l <= count; l++) {
    const need = xpToNext(l, c);
    out.push({ level: l, need, total });
    total += need;
  }
  return out;
}

// ---------- hodnosti ----------

export const RANK_COLORS = ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'danger', 'muted'] as const;
export type RankColor = (typeof RANK_COLORS)[number];

export interface Rank {
  name: string;
  icon: string;
  color: RankColor;
  /** Od kterého levelu hodnost platí. */
  minLevel: number;
}

/** Výchozí hodnosti, jeden řádek `Název|ikona|barva|od levelu`. */
export const DEFAULT_RANKS = ['Nováček|🌱|muted|1', 'Štamgast|🍺|info|5', 'Karbaník|🃏|success|10', 'Hráč od stolu|♠️|primary|20', 'Žralok|🦈|warning|35', 'Hospodský|👑|accent|50', 'Legenda|🏆|danger|75'].join(';');

/** Den (Europe/Prague) jako RRRR-MM-DD; podle něj se počítá denní strop a bonus prvního dne. */
export function dayKey(ms: number, tz = DEFAULT_TZ): string {
  const l = toLocal(ms, tz);
  return `${l.y}-${String(l.m).padStart(2, '0')}-${String(l.d).padStart(2, '0')}`;
}

/** Týden jako datum pondělí (RRRR-MM-DD). */
export function weekKey(ms: number, tz = DEFAULT_TZ): string {
  const l = toLocal(ms, tz);
  const monday = new Date(Date.UTC(l.y, l.m - 1, l.d - (l.weekday - 1)));
  return monday.toISOString().slice(0, 10);
}

export interface RankParse {
  ranks: Rank[];
  errors: string[];
}

/** Rozloží text hodnosti na seznam. Neplatné řádky se přeskočí a vrátí se o nich zpráva. */
export function parseRanks(text: string): RankParse {
  const ranks: Rank[] = [];
  const errors: string[] = [];
  for (const [i, raw] of text.split(/\r?\n|;/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const [name, icon, color, min] = line.split('|').map((x) => x.trim());
    const minLevel = Number(min);
    if (!name || name.length > 30 || !icon || icon.length > 8 || !RANK_COLORS.includes(color as RankColor) || !Number.isInteger(minLevel) || minLevel < 1 || minLevel > 1000) {
      errors.push(`Řádek ${i + 1}`);
      continue;
    }
    ranks.push({ name, icon, color: color as RankColor, minLevel });
  }
  ranks.sort((a, b) => a.minLevel - b.minLevel);
  if (ranks.length > 0 && ranks[0]!.minLevel !== 1) errors.push('První hodnost musí začínat na levelu 1');
  return { ranks, errors };
}

/** Hodnost pro level; neplatný nebo prázdný text použije výchozí hodnosti. */
export function rankFor(level: number, text: string): Rank {
  const parsed = parseRanks(text);
  const list = parsed.errors.length === 0 && parsed.ranks.length > 0 ? parsed.ranks : parseRanks(DEFAULT_RANKS).ranks;
  let cur = list[0]!;
  for (const r of list) if (r.minLevel <= level) cur = r;
  return cur;
}
