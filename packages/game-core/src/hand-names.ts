import type { Card } from './types.js';

/** Popis kombinace jako překladový klíč s parametry (česky vykreslí klient přes t()). */
export interface HandDescription {
  key: string;
  params?: Record<string, string>;
  /** Nejlepší pětice karet (jen u „Moje kombinace“) v pořadí k zobrazení: nejdřív dvojice, trojice a čtveřice, pak ostatní od nejvyšší. */
  cards?: Card[];
}

const ORDER = '23456789TJQKA';
const val = (c: Card) => ORDER.indexOf(c[0] ?? '') + 2;
const rankKey = (v: number) => ORDER[v - 2] ?? 'A';

/** Seřadí nejlepší pětici k zobrazení: skupiny stejných hodnot (čtveřice, trojice, dvojice) nejdřív, pak od nejvyšší karty; postupka A-2-3-4-5 má eso na konci. */
export function orderBestFive(cards: Card[]): Card[] {
  const counts = new Map<number, number>();
  for (const c of cards) counts.set(val(c), (counts.get(val(c)) ?? 0) + 1);
  const vals = cards.map(val);
  const wheel = new Set(vals).size === 5 && Math.max(...vals) === 14 && vals.includes(5) && vals.includes(2);
  const rank = (c: Card) => (wheel && val(c) === 14 ? 1 : val(c));
  return [...cards].sort((a, b) => (counts.get(val(b)) ?? 0) - (counts.get(val(a)) ?? 0) || rank(b) - rank(a));
}

/**
 * Popíše nejlepší pětici karet ("Dvě dvojice", "Postupka do dámy"…). Rozpoznává kombinaci
 * sám z karet, nespoléhá na texty enginu. Očekává přesně 5 karet.
 */
export function describeHand(cards: Card[]): HandDescription | null {
  if (cards.length !== 5) return null;
  const values = cards.map(val).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0]![1]);
  const unique = [...new Set(values)];
  let straightHigh = 0;
  if (unique.length === 5) {
    if (values[0]! - values[4]! === 4) straightHigh = values[0]!;
    else if (values[0] === 14 && values[1] === 5) straightHigh = 5; // A-2-3-4-5
  }
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const pattern = groups.map((g) => g[1]).join('');
  const k = (v: number) => rankKey(v);

  if (straightHigh && flush) {
    return straightHigh === 14 ? { key: 'hand.royalFlush' } : { key: 'hand.straightFlush', params: { high: k(straightHigh) } };
  }
  if (pattern === '41') return { key: 'hand.quads', params: { rank: k(groups[0]![0]) } };
  if (pattern === '32') return { key: 'hand.fullHouse', params: { trips: k(groups[0]![0]), pair: k(groups[1]![0]) } };
  if (flush) return { key: 'hand.flush', params: { high: k(values[0]!) } };
  if (straightHigh) return { key: 'hand.straight', params: { high: k(straightHigh) } };
  if (pattern === '311') return { key: 'hand.trips', params: { rank: k(groups[0]![0]) } };
  if (pattern === '221') return { key: 'hand.twoPair', params: { a: k(groups[0]![0]), b: k(groups[1]![0]) } };
  if (pattern === '2111') return { key: 'hand.pair', params: { rank: k(groups[0]![0]) } };
  return { key: 'hand.highCard', params: { high: k(values[0]!) } };
}
