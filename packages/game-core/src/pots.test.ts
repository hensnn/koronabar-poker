import { describe, expect, it } from 'vitest';
import { computeSidePots } from './pots.js';
import type { HandPlayer } from './types.js';

const p = (seat: number, invested: number, status: HandPlayer['status'] = 'allIn') => ({ seat, invested, status }) as HandPlayer;

describe('computeSidePots', () => {
  it('hlavní a vedlejší pot podle vkladů', () => {
    expect(computeSidePots({ players: [p(0, 100), p(1, 300), p(2, 300, 'active')] })).toEqual([
      { amount: 300, eligibleSeats: [0, 1, 2] },
      { amount: 400, eligibleSeats: [1, 2] },
    ]);
  });
  it('nevyrovnaná sázka do potu nepatří', () => {
    expect(computeSidePots({ players: [p(0, 100), p(1, 500, 'active')] })).toEqual([{ amount: 200, eligibleSeats: [0, 1] }]);
  });
  it('peníze složeného hráče nad krátkým all-inem patří jedinému zbývajícímu hráči', () => {
    const pots = computeSidePots({ players: [p(0, 436), p(1, 436, 'folded'), p(2, 330)] });
    expect(pots).toEqual([
      { amount: 990, eligibleSeats: [0, 2] },
      { amount: 212, eligibleSeats: [0] },
    ]);
  });
  it('složený hráč, který vložil míň než nejvyšší vklad, nevytvoří pot navíc', () => {
    expect(computeSidePots({ players: [p(0, 200), p(1, 100, 'folded'), p(2, 200, 'active')] })).toEqual([{ amount: 500, eligibleSeats: [0, 2] }]);
  });
});
