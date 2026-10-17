import { describe, it, expect } from 'vitest';
import { minimalTransfers } from './settlement.js';

const apply = (balances: Record<string, number>, transfers: { from: string; to: string; amount: number }[]) => {
  const b = { ...balances };
  for (const t of transfers) {
    expect(t.amount).toBeGreaterThan(0);
    b[t.from] = (b[t.from] ?? 0) + t.amount;
    b[t.to] = (b[t.to] ?? 0) - t.amount;
  }
  return b;
};

describe('minimální převody ve vyúčtování', () => {
  it('jednoduchý případ: dlužník platí věřiteli', () => {
    expect(minimalTransfers({ petr: -350, pavel: 350 })).toEqual([{ from: 'petr', to: 'pavel', amount: 350 }]);
  });

  it('nulové zůstatky se ignorují, prázdný vstup nemá převody', () => {
    expect(minimalTransfers({ a: 0, b: 0 })).toEqual([]);
    expect(minimalTransfers({})).toEqual([]);
  });

  it('všechny zůstatky se po převodech vyrovnají na nulu', () => {
    const b = { a: -500, b: 200, c: 150, d: 100, e: 50 };
    const t = minimalTransfers(b);
    for (const v of Object.values(apply(b, t))) expect(v).toBe(0);
    expect(t.length).toBeLessThanOrEqual(4);
  });

  it('využije podskupiny se součtem nula: dvě nezávislé dvojice = dva převody (chamtivý postup by dal víc)', () => {
    const b = { a: -100, b: 100, c: -70, d: 70 };
    const t = minimalTransfers(b);
    expect(t).toHaveLength(2);
    for (const v of Object.values(apply(b, t))) expect(v).toBe(0);
  });

  it('optimální oproti chamtivému: 3 + 3 hráči ve dvou vyrovnaných skupinách', () => {
    const b = { a: -60, b: 40, c: 20, d: -30, e: -10, f: 40 };
    const t = minimalTransfers(b);
    // skupiny {a,b,c} (součet 0) a {d,e,f} (součet 0) = 2 + 2 převody
    expect(t.length).toBe(4);
    for (const v of Object.values(apply(b, t))) expect(v).toBe(0);
  });

  it('náhodné případy: vždy vyrovnáno a nejvýš n−1 převodů', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 200; i++) {
      const n = 2 + Math.floor(rnd() * 9);
      const b: Record<string, number> = {};
      let total = 0;
      for (let k = 0; k < n - 1; k++) {
        b[`p${k}`] = Math.floor(rnd() * 2000) - 1000;
        total += b[`p${k}`]!;
      }
      b[`p${n - 1}`] = -total;
      const t = minimalTransfers(b);
      for (const v of Object.values(apply(b, t))) expect(v).toBe(0);
      expect(t.length).toBeLessThanOrEqual(n - 1);
    }
  });

  it('velký počet hráčů používá rychlé párování a pořád vyrovná', () => {
    const b: Record<string, number> = {};
    for (let i = 0; i < 20; i++) b[`p${i}`] = i % 2 === 0 ? 100 + i : -(100 + i + 1);
    b.p20 = -Object.values(b).reduce((a, c) => a + c, 0);
    for (const v of Object.values(apply(b, minimalTransfers(b)))) expect(v).toBe(0);
  });

  it('odmítne neceločíselné zůstatky a nenulový součet', () => {
    expect(() => minimalTransfers({ a: 1.5, b: -1.5 })).toThrow();
    expect(() => minimalTransfers({ a: 10, b: -5 })).toThrow(/nula/);
  });
});
