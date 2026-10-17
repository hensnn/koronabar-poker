import { describe, expect, it } from 'vitest';
import { distribute, mysteryValues, parseLadder, pickEliminators, BountyError } from './bounty.js';

const seeded = (seed: number) => {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.floor((s / 4294967296) * n);
  };
};

describe('bounty: pomocné výpočty', () => {
  it('distribute: součet je vždy přesně celek a dělí poměrně', () => {
    expect(distribute(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(distribute(10, [3, 1])).toEqual([8, 2]);
    expect(distribute(7, [0, 0])).toEqual([4, 3]);
    const rnd = seeded(5);
    for (let i = 0; i < 500; i++) {
      const n = 1 + rnd(9);
      const w = Array.from({ length: n }, () => rnd(10));
      const total = rnd(100_000);
      const out = distribute(total, w);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      for (const v of out) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('žebříček mystery odměn se rozebere a chybný se odmítne', () => {
    expect(parseLadder('0.5, 1; 2')).toEqual([0.5, 1, 2]);
    for (const bad of ['', 'a', '0', '-1, 2']) expect(() => parseLadder(bad)).toThrow(BountyError);
  });

  it('mystery hodnoty mají přesný součet a žádná není nulová', () => {
    const rnd = seeded(9);
    for (let i = 0; i < 300; i++) {
      const count = 1 + rnd(12);
      const base = 5 + rnd(500);
      const total = count * base;
      const values = mysteryValues(count, total, [0.5, 1, 1, 2, 10], rnd);
      expect(values).toHaveLength(count);
      expect(values.reduce((a, b) => a + b, 0)).toBe(total);
      for (const v of values) expect(v).toBeGreaterThanOrEqual(1);
    }
  });

  it('vyřazujícího určují vítězové, kteří měli vloženo aspoň tolik co vyřazený; split dělí rovným dílem nebo podle výhry', () => {
    const hand = [
      { userId: 'victim', invested: 100, won: 0 },
      { userId: 'a', invested: 300, won: 150 },
      { userId: 'b', invested: 100, won: 50 },
      { userId: 'c', invested: 50, won: 0 },
    ];
    const victim = hand[0]!;
    expect(pickEliminators(victim, hand, 'equal')).toEqual([{ userId: 'a', weight: 1 }, { userId: 'b', weight: 1 }]);
    expect(pickEliminators(victim, hand, 'byWinnings')).toEqual([{ userId: 'a', weight: 150 }, { userId: 'b', weight: 50 }]);
    // vítěz s menším vkladem (side pot): vyřadil ho ten s nejvyšším vkladem
    const hand2 = [
      { userId: 'victim', invested: 500, won: 0 },
      { userId: 'short', invested: 100, won: 300 },
    ];
    expect(pickEliminators(hand2[0]!, hand2, 'equal')).toEqual([{ userId: 'short', weight: 1 }]);
    // nikdo nevyhrál
    expect(pickEliminators(victim, [victim], 'equal')).toEqual([]);
  });
});
