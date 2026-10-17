import { describe, it, expect } from 'vitest';
import { computeOdds } from './odds.js';
import { computeSidePots } from './pots.js';

const opt = { maxExactCombos: 3_000_000, simulations: 20000 };
const two = (a: [string, string], b: [string, string], board: string[]) =>
  computeOdds([{ seat: 0, hole: a }, { seat: 1, hole: b }], board, [{ seats: [0, 1] }], opt)[0]!;
const pct = (e: { win: number }) => e.win * 100;

describe('šance na výhru', () => {
  it('AsAh vs KdKc před flopem: 81,06 % / 18,55 % / 0,39 % (ověřeno nezávislým vyhodnocením)', () => {
    const r = two(['As', 'Ah'], ['Kd', 'Kc'], []);
    expect(r.method).toBe('exact');
    expect(pct(r.entries[0]!)).toBeCloseTo(81.06, 1);
    expect(pct(r.entries[1]!)).toBeCloseTo(18.55, 1);
  });

  it('součet šancí včetně dělby je 100 %', () => {
    const r = two(['As', 'Kh'], ['Qd', 'Qc'], ['2c', '7d', 'Jh']);
    const sum = r.entries.reduce((n, e) => n + e.win, 0) + r.entries[0]!.tie;
    expect(sum).toBeCloseTo(1, 10);
  });

  it('nuts flush draw proti sadě na flopu: 8 čistých outů (Kh dá soupeři čtveřici), tedy ~25 %', () => {
    const r = two(['Ah', '5h'], ['Kd', 'Kc'], ['Ks', '9h', '2h']);
    expect(pct(r.entries[0]!)).toBeGreaterThan(22);
    expect(pct(r.entries[0]!)).toBeLessThan(30);
    expect(r.entries[0]!.win + r.entries[1]!.win + r.entries[0]!.tie).toBeCloseTo(1, 10);
  });

  it('na riveru je výsledek jistý', () => {
    const r = two(['As', 'Ah'], ['Kd', 'Kc'], ['2c', '7d', 'Jh', '3s', '9c']);
    expect(r.entries[0]!.win).toBe(1);
    expect(r.entries[1]!.win).toBe(0);
  });

  it('remíza (board hraje) se počítá jako dělba', () => {
    const r = two(['2s', '3h'], ['2d', '4c'], ['As', 'Ks', 'Qs', 'Js', 'Ts']);
    expect(r.entries[0]!.tie).toBe(1);
    expect(r.entries[0]!.win).toBe(0);
  });

  it('více potů: vedlejší pot počítá jen oprávněné hráče', () => {
    const odds = computeOdds(
      [
        { seat: 0, hole: ['As', 'Ah'] },
        { seat: 1, hole: ['Kd', 'Kc'] },
        { seat: 2, hole: ['2d', '3c'] },
      ],
      ['9s', '8d', '4h'],
      [{ seats: [0, 1, 2] }, { seats: [1, 2] }],
      opt,
    );
    expect(odds[0]!.entries).toHaveLength(3);
    expect(odds[1]!.entries.map((e) => e.seat)).toEqual([1, 2]);
    const side = odds[1]!.entries.reduce((n, e) => n + e.win, 0) + odds[1]!.entries[0]!.tie;
    expect(side).toBeCloseTo(1, 10);
  });

  it('při velkém počtu kombinací použije Monte Carlo', () => {
    const r = computeOdds([{ seat: 0, hole: ['As', 'Ah'] }, { seat: 1, hole: ['Kd', 'Kc'] }], [], [{ seats: [0, 1] }], { maxExactCombos: 1000, simulations: 5000 });
    expect(r[0]!.method).toBe('monteCarlo');
    expect(pct(r[0]!.entries[0]!)).toBeGreaterThan(75);
  });
});

describe('side poty (vlastní výpočet)', () => {
  const pl = (seat: number, invested: number, status: 'active' | 'folded' | 'allIn') => ({ seat, invested, status }) as never;
  it('3 all-iny 100/300/600: hlavní 300 pro všechny, vedlejší 400 pro dva, zbytek 300 nepatří do potu', () => {
    const pots = computeSidePots({ players: [pl(0, 100, 'allIn'), pl(1, 300, 'allIn'), pl(2, 600, 'allIn')] });
    expect(pots).toEqual([
      { amount: 300, eligibleSeats: [0, 1, 2] },
      { amount: 400, eligibleSeats: [1, 2] },
    ]);
  });
  it('složený hráč přispívá do potu, ale není oprávněný', () => {
    const pots = computeSidePots({ players: [pl(0, 50, 'folded'), pl(1, 100, 'allIn'), pl(2, 100, 'active')] });
    expect(pots).toEqual([{ amount: 250, eligibleSeats: [1, 2] }]);
  });
});
