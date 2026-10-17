import type { LegalActions, PlayerAction } from './types.js';

/** Jednoduchý bot: vybírá náhodné legální akce. Slouží k testům a simulacím, ne ke hře. */
export function randomLegalAction(legal: LegalActions, rnd: () => number): PlayerAction {
  const r = rnd();
  const canAggress = legal.canBet || legal.canRaise;
  if (r < 0.12 && !legal.canCheck) return { type: 'fold' };
  if (r < 0.22 && canAggress) return { type: 'allIn' };
  if (r < 0.45 && canAggress) {
    const span = legal.maxRaiseTo - legal.minRaiseTo;
    const amount = legal.minRaiseTo + Math.floor(rnd() * (span + 1));
    return { type: legal.canBet ? 'bet' : 'raise', amount };
  }
  return legal.canCheck ? { type: 'check' } : { type: 'call' };
}

/** Deterministický generátor pro opakovatelné simulace. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
