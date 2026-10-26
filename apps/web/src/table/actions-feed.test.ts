import { describe, expect, it } from 'vitest';
import type { TableView } from '@kb/game-core';
import { actionLabel, detectActions } from './actions-feed';

const view = (over: Record<string, unknown> = {}): TableView =>
  ({
    handId: 'h1',
    street: 'PREFLOP',
    actingSeat: null,
    seats: [
      { seat: 0, bet: 0, status: 'active' },
      { seat: 1, bet: 10, status: 'active' },
      { seat: 2, bet: 20, status: 'active' },
    ],
    ...over,
  }) as unknown as TableView;
const seats = (a: number, b: number, c: number, st: Record<number, string> = {}) => [
  { seat: 0, bet: a, status: st[0] ?? 'active' },
  { seat: 1, bet: b, status: st[1] ?? 'active' },
  { seat: 2, bet: c, status: st[2] ?? 'active' },
];

describe('akce hráčů odvozené ze stavu stolu', () => {
  it('call, raise, bet, fold a all-in podle změny sázek a stavu', () => {
    const before = view({ actingSeat: 0 });
    expect(detectActions(before, view({ actingSeat: 1, seats: seats(20, 10, 20) }))).toEqual([{ seat: 0, kind: 'call', amount: 20 }]);
    expect(detectActions(before, view({ actingSeat: 1, seats: seats(60, 10, 20) }))).toEqual([{ seat: 0, kind: 'raise', amount: 60, by: 40 }]);
    expect(detectActions(before, view({ actingSeat: 1, seats: seats(0, 10, 20, { 0: 'folded' }) }))).toEqual([{ seat: 0, kind: 'fold', amount: 0 }]);
    expect(detectActions(before, view({ actingSeat: 1, seats: seats(500, 10, 20, { 0: 'allIn' }) }))).toEqual([{ seat: 0, kind: 'allIn', amount: 500 }]);
    const flop = view({ street: 'FLOP', actingSeat: 1, seats: seats(0, 0, 0) });
    expect(detectActions(flop, view({ street: 'FLOP', actingSeat: 2, seats: seats(0, 30, 0) }))).toEqual([{ seat: 1, kind: 'bet', amount: 30 }]);
  });

  it('check: hráč na tahu předal tah bez změny sázky', () => {
    const flop = view({ street: 'FLOP', actingSeat: 1, seats: seats(0, 0, 0) });
    expect(detectActions(flop, view({ street: 'FLOP', actingSeat: 2, seats: seats(0, 0, 0) }))).toEqual([{ seat: 1, kind: 'check', amount: 0 }]);
  });

  it('akce, která uzavřela ulici, se pozná i po smetení sázek do potu', () => {
    const before = view({ actingSeat: 0, seats: seats(0, 20, 20) });
    expect(detectActions(before, view({ street: 'FLOP', actingSeat: 1, seats: seats(0, 0, 0) }))).toEqual([{ seat: 0, kind: 'call', amount: 20 }]);
    const checkRound = view({ street: 'FLOP', actingSeat: 2, seats: seats(0, 0, 0) });
    expect(detectActions(checkRound, view({ street: 'TURN', actingSeat: 0, seats: seats(0, 0, 0) }))).toEqual([{ seat: 2, kind: 'check', amount: 0 }]);
  });

  it('nová handa nebo první pohled nevyvolá nic', () => {
    expect(detectActions(null, view())).toEqual([]);
    expect(detectActions(view({ handId: 'h1' }), view({ handId: 'h2', seats: seats(0, 0, 0) }))).toEqual([]);
  });
});

describe('re-raise', () => {
  it('první agrese je bet/raise, třetí a další je re-raise; preflop se big blind počítá jako první', async () => {
    const { aggressionStart, classifyAggression } = await import('./actions-feed');
    expect(aggressionStart('PREFLOP')).toBe(1);
    expect(aggressionStart('FLOP')).toBe(0);
    // preflop: raise nad blindem (2), pak re-raise (3), 4-bet (4)
    expect(classifyAggression('raise', 2)).toBe('raise');
    expect(classifyAggression('raise', 3)).toBe('reraise');
    expect(classifyAggression('raise', 4)).toBe('reraise');
    // postflop: bet (1), raise (2), re-raise (3)
    expect(classifyAggression('bet', 1)).toBe('bet');
    expect(classifyAggression('raise', 2)).toBe('raise');
    expect(classifyAggression('call', 5)).toBe('call');
  });
});

describe('text akce u stolu', () => {
  const info = { chipLabel: '', currencySymbol: '', currencyForms: ['', '', ''], currencyDecimals: 0, chipsPerCurrencyUnit: 1, bigBlind: 10, smallBlind: 5 };
  const v = { info } as unknown as TableView;
  it('raise ukáže na kolik i o kolik, re-raise číslo sázky, ostatní jen částku', () => {
    expect(actionLabel({ seat: 0, kind: 'raise', amount: 60, by: 40 }, v, false)).toMatch(/Raise → 60 \(\+40\)/);
    expect(actionLabel({ seat: 0, kind: 'reraise', amount: 150, by: 90, count: 3 }, v, false)).toMatch(/3-bet → 150 \(\+90\)/);
    expect(actionLabel({ seat: 0, kind: 'bet', amount: 30 }, v, false)).toMatch(/Bet 30/);
    expect(actionLabel({ seat: 0, kind: 'fold', amount: 0 }, v, false)).toBe('Fold');
  });
});
