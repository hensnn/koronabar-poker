import { describe, expect, it } from 'vitest';
import { dealFinance } from './deal-finance';

const participants = [
  { userId: 'a', name: 'Anna', chips: 6000 },
  { userId: 'b', name: 'Béda', chips: 3000 },
  { userId: 'c', name: 'Cyril', chips: 1000 },
];

describe('finanční přehled dohody', () => {
  it('spočítá podíly žetonů, podíly z dělené částky a rozdíl proti ICM; řadí podle žetonů', () => {
    const f = dealFinance({ participants: [participants[2]!, participants[0]!, participants[1]!], amounts: { a: 500, b: 300, c: 200 }, keep: 0, total: 1000, places: [600, 300, 100], fair: { a: 550, b: 290, c: 160 } });
    expect(f.rows.map((r) => r.userId)).toEqual(['a', 'b', 'c']);
    expect(f.rows.map((r) => r.chipPct)).toEqual([60, 30, 10]);
    expect(f.rows.map((r) => r.sharePct)).toEqual([50, 30, 20]);
    expect(f.rows.map((r) => r.vsFair)).toEqual([-50, 10, 40]);
    expect(f.shared).toBe(1000);
    expect(f.sum).toBe(1000);
    expect(f.range).toEqual({ min: 100, max: 600 });
  });

  it('ponechaná část se z dělené částky odečte a podíly se počítají z toho, co se rozdá hned', () => {
    const f = dealFinance({ participants, amounts: { a: 400, b: 300, c: 100 }, keep: 200, total: 1000 });
    expect(f.shared).toBe(800);
    expect(f.keep).toBe(200);
    expect(f.rows.map((r) => r.sharePct)).toEqual([50, 37.5, 12.5]);
    expect(f.sum).toBe(f.shared);
  });

  it('s ponechanou částí se rozdíl proti ICM nepočítá (ICM dělí celou částku, ne zbytek)', () => {
    const f = dealFinance({ participants, amounts: { a: 400, b: 300, c: 100 }, keep: 200, total: 1000, fair: { a: 550, b: 290, c: 160 } });
    expect(f.rows.every((r) => r.vsFair === null)).toBe(true);
  });

  it('starší návrh bez výplat za místa a bez ICM: rozsah a rozdíl nejsou k dispozici', () => {
    const f = dealFinance({ participants, amounts: { a: 1, b: 1, c: 1 }, keep: 0, total: 3 });
    expect(f.range).toBeNull();
    expect(f.rows.every((r) => r.vsFair === null)).toBe(true);
  });

  it('prázdné údaje nedělí nulou', () => {
    const f = dealFinance({ participants: [{ userId: 'a', name: 'A', chips: 0 }], amounts: {}, keep: 0, total: 0 });
    expect(f.rows[0]).toMatchObject({ chipPct: 0, sharePct: 0, amount: 0 });
  });
});
