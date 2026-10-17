import { evaluate, getCardCode } from '@pokertools/evaluator';
import type { Card } from './types.js';

export interface OddsPlayer {
  seat: number;
  hole: [Card, Card];
}
export interface OddsPot {
  /** Sedadla, která o pot soupeří. */
  seats: number[];
}
export interface PotOdds {
  pot: number;
  entries: { seat: number; win: number; tie: number }[];
  method: 'exact' | 'monteCarlo';
}

export interface OddsOptions {
  /** Do tohoto počtu kombinací se počítá přesným výčtem. */
  maxExactCombos: number;
  /** Počet simulací, pokud je kombinací víc. */
  simulations: number;
  rng?: () => number;
}

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
export const FULL_DECK: Card[] = [...RANKS].flatMap((r) => [...SUITS].map((s) => r + s));

function combinations(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/**
 * Šance na výhru a na dělbu potu pro každý pot zvlášť. Hráči jsou ti, kteří jsou ještě ve hře,
 * karty jsou známé (otočené). Předpokládá hold'em (2 skryté karty, 5 na boardu, lepší pětice z 7).
 */
export function computeOdds(players: OddsPlayer[], board: Card[], pots: OddsPot[], opt: OddsOptions): PotOdds[] {
  const known = new Set<Card>([...board, ...players.flatMap((p) => p.hole)]);
  const unseen = FULL_DECK.filter((c) => !known.has(c));
  const need = 5 - board.length;
  const unseenCodes = unseen.map(getCardCode);
  const boardCodes = board.map(getCardCode);
  const holeCodes = new Map(players.map((p) => [p.seat, p.hole.map(getCardCode)] as const));
  const total = combinations(unseen.length, need);
  const exact = total <= opt.maxExactCombos;

  const win = pots.map(() => new Map<number, number>());
  const tie = pots.map(() => new Map<number, number>());
  let samples = 0;

  const scores = new Map<number, number>();
  const evalBoard = (full: number[]) => {
    for (const p of players) scores.set(p.seat, evaluate([...holeCodes.get(p.seat)!, ...full]));
    pots.forEach((pot, i) => {
      let best = Infinity;
      for (const s of pot.seats) best = Math.min(best, scores.get(s) ?? Infinity);
      const winners = pot.seats.filter((s) => scores.get(s) === best);
      const target = winners.length === 1 ? win[i]! : tie[i]!;
      for (const s of winners) target.set(s, (target.get(s) ?? 0) + 1);
    });
    samples++;
  };

  if (need === 0) {
    evalBoard(boardCodes);
  } else if (exact) {
    const idx = Array.from({ length: need }, (_, i) => i);
    const n = unseenCodes.length;
    for (;;) {
      evalBoard([...boardCodes, ...idx.map((i) => unseenCodes[i]!)]);
      let i = need - 1;
      while (i >= 0 && idx[i] === n - need + i) i--;
      if (i < 0) break;
      idx[i]!++;
      for (let j = i + 1; j < need; j++) idx[j] = idx[j - 1]! + 1;
    }
  } else {
    const rng = opt.rng ?? Math.random;
    const pool = [...unseenCodes];
    for (let s = 0; s < opt.simulations; s++) {
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(rng() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      evalBoard([...boardCodes, ...pool.slice(0, need)]);
    }
  }

  return pots.map((pot, i) => ({
    pot: i,
    method: exact || need === 0 ? 'exact' : 'monteCarlo',
    entries: pot.seats.map((seat) => ({
      seat,
      win: (win[i]!.get(seat) ?? 0) / samples,
      tie: (tie[i]!.get(seat) ?? 0) / samples,
    })),
  }));
}
