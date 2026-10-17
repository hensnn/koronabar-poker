import { describe, expect, it } from 'vitest';
import { dealAmounts, DealError, icmEquity } from './deal.js';

describe('ICM', () => {
  it('dva hráči bojující o 1. a 2. místo: výhra úměrná žetonům', () => {
    const [a, b] = icmEquity([300, 100], [70, 30]);
    // P(a první) = 0,75 → 0,75*70 + 0,25*30 = 60, b = 40
    expect(a).toBeCloseTo(60, 6);
    expect(b).toBeCloseTo(40, 6);
  });

  it('součet ICM vždy odpovídá součtu cen a větší stack má víc', () => {
    for (const stacks of [[1000, 1000, 1000], [5000, 2000, 1000, 500], [10, 1, 1], [100, 90, 80, 70, 60, 50, 40, 30, 20, 10]]) {
      const prizes = [500, 300, 150, 50].slice(0, stacks.length);
      const eq = icmEquity(stacks, prizes);
      expect(eq.reduce((a, b) => a + b, 0)).toBeCloseTo(prizes.reduce((a, b) => a + b, 0), 6);
      const sorted = [...stacks].map((s, i) => ({ s, e: eq[i]! })).sort((x, y) => y.s - x.s);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i - 1]!.e).toBeGreaterThanOrEqual(sorted[i]!.e - 1e-9);
    }
    // stejné stacky = stejná hodnota
    const same = icmEquity([700, 700, 700], [60, 30, 10]);
    expect(same[0]).toBeCloseTo(same[1]!, 9);
    expect(same[0]).toBeCloseTo(100 / 3, 6);
  });

  it('ICM tlumí výhodu velkého stacku proti chip chopu', () => {
    const chips = [
      { userId: 'big', chips: 8000 },
      { userId: 'small', chips: 2000 },
    ];
    const icm = dealAmounts('icm', chips, 1000, { prizes: [700, 300] });
    const chop = dealAmounts('chipChop', chips, 1000);
    expect(chop.big).toBe(800);
    expect(icm.big).toBeLessThan(chop.big!);
    expect(icm.big! + icm.small!).toBe(1000);
  });
});

describe('dealAmounts', () => {
  const ps = [
    { userId: 'a', chips: 5000 },
    { userId: 'b', chips: 3000 },
    { userId: 'c', chips: 1000 },
  ];

  it('každá metoda dělí přesně celou částku (náhodné pokusy včetně zaokrouhlení)', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 400; i++) {
      const n = 2 + Math.floor(rnd() * 5);
      const participants = Array.from({ length: n }, (_, k) => ({ userId: 'p' + k, chips: 1 + Math.floor(rnd() * 20000) }));
      const total = Math.floor(rnd() * 100_000);
      const unit = [1, 5, 10, 100][Math.floor(rnd() * 4)]!;
      for (const method of ['icm', 'chipChop', 'equal'] as const) {
        const prizes = [0.5, 0.3, 0.2, 0.1, 0.05, 0.02].slice(0, n).map((x) => x * 1000);
        const out = dealAmounts(method, participants, total, { roundTo: unit, prizes });
        expect(Object.values(out).reduce((a, b) => a + b, 0)).toBe(total);
        for (const v of Object.values(out)) expect(v).toBeGreaterThanOrEqual(0);
        if (unit > 1) {
          const lead = participants.reduce((b, p) => (p.chips > b.chips ? p : b), participants[0]!);
          for (const [id, v] of Object.entries(out)) if (id !== lead.userId) expect(v % unit).toBe(0);
        }
      }
    }
  });

  it('rovným dílem a chip chop', () => {
    expect(dealAmounts('equal', ps, 1000)).toEqual({ a: 334, b: 333, c: 333 });
    expect(dealAmounts('chipChop', ps, 900)).toEqual({ a: 500, b: 300, c: 100 });
  });

  it('vlastní částky: musí sedět počet hráčů, nezápornost a součet', () => {
    expect(dealAmounts('custom', ps, 100, { custom: { a: 50, b: 30, c: 20 } })).toEqual({ a: 50, b: 30, c: 20 });
    const code = (c: Record<string, number>) => {
      try {
        dealAmounts('custom', ps, 100, { custom: c });
      } catch (e) {
        return (e as DealError).code;
      }
      return 'OK';
    };
    expect(code({ a: 50, b: 30 })).toBe('CUSTOM_PLAYERS');
    expect(code({ a: 50, b: 30, c: 21 })).toBe('CUSTOM_SUM');
    expect(code({ a: 120, b: -10, c: -10 })).toBe('CUSTOM_NEGATIVE');
  });
});
