import { describe, expect, it } from 'vitest';
import { formatStructure, generateStructure, parseStructure, StructureError } from './blinds.js';
import { balancePercents, BP, computePayouts, defaultPercents, paidPlaces, parsePercents, percentsFor, PayoutError } from './payouts.js';

describe('struktura blindů', () => {
  it('rozebere zápis s ante i bez a vrátí ho zpět', () => {
    const levels = parseStructure('25/50, 50/100/10\n100/200/25');
    expect(levels).toEqual([
      { smallBlind: 25, bigBlind: 50, ante: 0 },
      { smallBlind: 50, bigBlind: 100, ante: 10 },
      { smallBlind: 100, bigBlind: 200, ante: 25 },
    ]);
    expect(parseStructure(formatStructure(levels))).toEqual(levels);
  });

  it('odmítne prázdný zápis, chybný tvar i klesající blindy', () => {
    const code = (s: string) => {
      try {
        parseStructure(s);
      } catch (e) {
        return (e as StructureError).code;
      }
      return 'OK';
    };
    expect(code('')).toBe('EMPTY');
    expect(code('25-50')).toBe('SYNTAX');
    expect(code('50/25')).toBe('SYNTAX');
    expect(code('25/50/80')).toBe('SYNTAX');
    expect(code('50/100, 25/50')).toBe('NOT_INCREASING');
  });

  it('generátor vytvoří rostoucí strukturu odpovídající cílové délce', () => {
    for (const [stack, target, minutes] of [[5000, 150, 15], [1500, 45, 6], [20000, 240, 25], [300, 25, 3]] as const) {
      const levels = generateStructure({ startingStack: stack, targetMinutes: target, levelMinutes: minutes });
      expect(levels.length).toBeGreaterThanOrEqual(2);
      expect(levels.length).toBeLessThanOrEqual(Math.round(target / minutes));
      for (let i = 0; i < levels.length; i++) {
        const l = levels[i]!;
        expect(Number.isInteger(l.smallBlind) && l.smallBlind >= 1).toBe(true);
        expect(l.bigBlind).toBe(l.smallBlind * 2);
        expect(l.ante).toBeLessThanOrEqual(l.bigBlind);
        if (i > 0) expect(l.bigBlind).toBeGreaterThan(levels[i - 1]!.bigBlind);
      }
      // První level nechá hráčům hlubokou hru, poslední je k dohrání.
      expect(levels[0]!.bigBlind).toBeLessThanOrEqual(stack / 40);
      expect(levels[levels.length - 1]!.bigBlind).toBeGreaterThanOrEqual(stack / 10);
    }
  });
});

describe('výplaty', () => {
  it('výchozí tabulky mají součet přesně 100 %', () => {
    for (let n = 1; n <= 60; n++) {
      const p = defaultPercents(n);
      expect(p).toHaveLength(n);
      expect(p.reduce((a, b) => a + b, 0)).toBe(BP);
      for (let i = 1; i < n; i++) expect(p[i]!).toBeLessThanOrEqual(p[i - 1]!);
    }
  });

  it('počet placených míst podle předvolby', () => {
    expect(paidPlaces('standard', 2)).toBe(1);
    expect(paidPlaces('standard', 5)).toBe(2);
    expect(paidPlaces('standard', 9)).toBe(3);
    expect(paidPlaces('standard', 40)).toBe(6);
    expect(paidPlaces('wta', 9)).toBe(1);
    expect(paidPlaces('top3', 2)).toBe(2);
  });

  it('vlastní procenta se rozeberou, špatný součet se odmítne', () => {
    expect(parsePercents('50, 30, 20')).toEqual([5000, 3000, 2000]);
    expect(parsePercents('33.33 33.33 33.34')).toEqual([3333, 3333, 3334]);
    const code = (s: string) => {
      try {
        parsePercents(s);
      } catch (e) {
        return (e as PayoutError).code;
      }
      return 'OK';
    };
    expect(code('50,30')).toBe('SUM');
    expect(code('abc')).toBe('SYNTAX');
    expect(code('')).toBe('EMPTY');
    // víc míst než hráčů: zbytek připadne poslednímu placenému
    expect(percentsFor('custom', '50,30,20', 2)).toEqual([5000, 5000]);
  });

  it('součet výher a zbytku je vždy přesně prize pool (náhodné pokusy)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 2000; i++) {
      const pool = Math.floor(rnd() * 1_000_000);
      const places = 1 + Math.floor(rnd() * 12);
      const roundTo = [1, 5, 10, 50, 100][Math.floor(rnd() * 5)]!;
      const remainder = (['first', 'house', 'spread'] as const)[Math.floor(rnd() * 3)]!;
      const r = computePayouts(pool, defaultPercents(places), { roundTo, remainder });
      expect(r.amounts.reduce((a, b) => a + b, 0) + r.toHouse).toBe(pool);
      for (const a of r.amounts) expect(a).toBeGreaterThanOrEqual(0);
      if (remainder !== 'house') expect(r.toHouse).toBe(0);
      if (remainder === 'house') for (const a of r.amounts) expect(a % roundTo).toBe(0);
    }
  });

  it('pravidla pro zbytek ze zaokrouhlení', () => {
    // 1000 v poolu, 50/30/20, zaokrouhlení na 300: 500→300, 300→300, 200→0, zbytek 400
    const pct = [5000, 3000, 2000];
    expect(computePayouts(1000, pct, { roundTo: 300, remainder: 'first' })).toEqual({ amounts: [700, 300, 0], toHouse: 0 });
    expect(computePayouts(1000, pct, { roundTo: 300, remainder: 'house' })).toEqual({ amounts: [300, 300, 0], toHouse: 400 });
    expect(computePayouts(1000, pct, { roundTo: 300, remainder: 'spread' })).toEqual({ amounts: [700, 300, 0], toHouse: 0 });
    expect(computePayouts(1000, pct, { roundTo: 100, remainder: 'first' })).toEqual({ amounts: [500, 300, 200], toHouse: 0 });
  });

  it('posuvníky: změna se dorovná do ostatních, zámky se nemění, součet zůstává 100 %', () => {
    const base = [5000, 3000, 2000];
    const a = balancePercents(base, 0, 6000, [false, false, false]);
    expect(a.reduce((x, y) => x + y, 0)).toBe(BP);
    expect(a[0]).toBe(6000);
    const b = balancePercents(base, 0, 6000, [false, true, false]);
    expect(b).toEqual([6000, 3000, 1000]);
    // nelze překročit to, co zbývá po zámcích
    const c = balancePercents(base, 0, 9500, [false, true, false]);
    expect(c).toEqual([7000, 3000, 0]);
    // bez volných míst se hodnota dorovná sama
    const d = balancePercents(base, 0, 1000, [false, true, true]);
    expect(d).toEqual([5000, 3000, 2000]);
    for (let i = 0; i < 500; i++) {
      const p = defaultPercents(1 + (i % 9));
      const locked = p.map((_, k) => (i * 7 + k) % 3 === 0);
      const idx = i % p.length;
      const r = balancePercents(p, idx, (i * 137) % (BP + 500), locked);
      expect(r.reduce((x, y) => x + y, 0)).toBe(BP);
      for (let k = 0; k < p.length; k++) {
        expect(r[k]).toBeGreaterThanOrEqual(0);
        if (k !== idx && locked[k]) expect(r[k]).toBe(p[k]);
      }
    }
  });
});
