/**
 * Výplaty turnaje. Procenta se počítají v setinách procenta (základní body, 10 000 = 100 %),
 * aby se nikde nepracovalo s desetinnými čísly. Součet výher a zbytku připadajícího herně
 * je vždy přesně rovný prize poolu.
 */

export const BP = 10_000;

export class PayoutError extends Error {
  constructor(public readonly code: 'SYNTAX' | 'SUM' | 'EMPTY' | 'TOO_MANY') {
    super(code);
  }
}

export type PayoutPreset = 'standard' | 'wta' | 'top2' | 'top3' | 'custom';
export type RemainderRule = 'first' | 'house' | 'spread';

const TABLE: number[][] = [
  [10000],
  [6500, 3500],
  [5000, 3000, 2000],
  [4500, 2700, 1700, 1100],
  [4000, 2500, 1700, 1100, 700],
  [3800, 2400, 1600, 1100, 700, 400],
  [3500, 2300, 1600, 1100, 800, 400, 300],
  [3300, 2200, 1600, 1100, 800, 500, 300, 200],
  [3200, 2100, 1500, 1100, 800, 600, 400, 200, 100],
];

/** Doporučená procenta pro daný počet placených míst (součet přesně 10 000). */
export function defaultPercents(places: number): number[] {
  if (!Number.isInteger(places) || places < 1) throw new PayoutError('EMPTY');
  const fixed = TABLE[places - 1];
  if (fixed) return [...fixed];
  // Mnoho míst: klesající váhy 1/(i+1)^0.9, zbytek zaokrouhlení vítězi.
  const w = Array.from({ length: places }, (_, i) => 1 / Math.pow(i + 1, 0.9));
  const sum = w.reduce((a, b) => a + b, 0);
  const out = w.map((x) => Math.floor((x / sum) * BP));
  out[0]! += BP - out.reduce((a, b) => a + b, 0);
  return out;
}

/** Kolik míst se vyplácí podle předvolby a počtu hráčů. */
export function paidPlaces(preset: Exclude<PayoutPreset, 'custom'>, players: number): number {
  const p = Math.max(1, players);
  switch (preset) {
    case 'wta':
      return 1;
    case 'top2':
      return Math.min(2, p);
    case 'top3':
      return Math.min(3, p);
    default:
      return Math.min(p, p <= 3 ? 1 : p <= 6 ? 2 : p <= 10 ? 3 : Math.ceil(p * 0.15));
  }
}

/** Rozbor vlastních procent „50, 30, 20“ (oddělovač je čárka, mezera nebo středník; desetinná místa jen s tečkou, nejvýš 2). */
export function parsePercents(text: string): number[] {
  const parts = text
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new PayoutError('EMPTY');
  if (parts.length > 100) throw new PayoutError('TOO_MANY');
  const bp = parts.map((x) => {
    if (!/^\d+(\.\d{1,2})?$/.test(x)) throw new PayoutError('SYNTAX');
    return Math.round(Number(x) * 100);
  });
  if (bp.reduce((a, b) => a + b, 0) !== BP) throw new PayoutError('SUM');
  return bp;
}

/** Procenta pro konkrétní turnaj: předvolba (podle počtu hráčů) nebo vlastní tabulka. */
export function percentsFor(preset: PayoutPreset, custom: string, players: number): number[] {
  if (preset !== 'custom') return defaultPercents(paidPlaces(preset, players));
  const pct = parsePercents(custom);
  if (pct.length <= players) return pct;
  // Víc míst než hráčů: přebývající procenta připadnou poslednímu placenému místu.
  const kept = pct.slice(0, players);
  kept[kept.length - 1]! += pct.slice(players).reduce((a, b) => a + b, 0);
  return kept;
}

export interface PayoutResult {
  /** Výhry podle pořadí (1. místo je index 0). */
  amounts: number[];
  /** Co připadne herně (jen u pravidla „house“). */
  toHouse: number;
}

export function computePayouts(pool: number, percents: number[], opt: { roundTo: number; remainder: RemainderRule }): PayoutResult {
  if (!Number.isSafeInteger(pool) || pool < 0) throw new PayoutError('SYNTAX');
  if (percents.reduce((a, b) => a + b, 0) !== BP) throw new PayoutError('SUM');
  const unit = Math.max(1, Math.floor(opt.roundTo));
  const amounts = percents.map((bp) => Math.floor(Math.floor((pool * bp) / BP) / unit) * unit);
  let rest = pool - amounts.reduce((a, b) => a + b, 0);
  let toHouse = 0;
  if (opt.remainder === 'house') {
    toHouse = rest;
    rest = 0;
  } else if (opt.remainder === 'spread') {
    for (let i = 0; rest >= unit && amounts.length > 0; i = (i + 1) % amounts.length) {
      amounts[i]! += unit;
      rest -= unit;
    }
  }
  if (rest > 0 && amounts.length > 0) amounts[0]! += rest;
  else if (rest > 0) toHouse += rest;
  return { amounts, toHouse };
}

/**
 * Posuvníky s dorovnáním na 100 %: změna jednoho místa se promítne do ostatních neuzamčených
 * (poměrně podle jejich současné hodnoty). Uzamčená místa se nemění.
 */
export function balancePercents(percents: number[], index: number, value: number, locked: boolean[]): number[] {
  const n = percents.length;
  const out = [...percents];
  const lockedOthers = percents.reduce((a, p, i) => a + (i !== index && locked[i] ? p : 0), 0);
  const free = percents.map((_, i) => i).filter((i) => i !== index && !locked[i]);
  const room = BP - lockedOthers;
  // Bez volných míst se hodnota dorovná sama, aby součet zůstal 100 %.
  const v = free.length === 0 ? room : Math.max(0, Math.min(value, room));
  out[index] = v;
  let left = room - v;
  if (free.length > 0) {
    const base = free.reduce((a, i) => a + percents[i]!, 0);
    let given = 0;
    for (const i of free) {
      const share = base > 0 ? Math.floor((left * percents[i]!) / base) : Math.floor(left / free.length);
      out[i] = share;
      given += share;
    }
    // Zbytek po zaokrouhlení: největšímu volnému místu.
    const biggest = free.reduce((b, i) => (out[i]! > out[b]! ? i : b), free[0]!);
    out[biggest]! += left - given;
    left = 0;
  }
  void n;
  return out;
}
