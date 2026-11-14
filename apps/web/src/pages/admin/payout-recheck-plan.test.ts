import { describe, expect, it } from 'vitest';
import { payoutFixPlan, type PayoutProblem } from './payout-recheck-plan';

const problem = (balances: [number, number], credit = 0): PayoutProblem => ({
  id: 't1',
  name: 'Turnaj',
  finishedAt: 0,
  kind: 'fixable',
  pool: 1405,
  paidPlaces: 3,
  rows: [
    { userId: 'a', name: 'Anička', place: 1, paid: 352, correct: 703, balance: balances[0], credit: 1000, flagged: true },
    { userId: 'k', name: 'Kajmi', place: 2, paid: 421, correct: 421, balance: 0, credit: 1000, flagged: false },
    { userId: 'p', name: 'Pumča', place: 4, paid: 351, correct: 0, balance: balances[1], credit, flagged: true },
  ],
});

describe('payoutFixPlan', () => {
  it('lists only the players whose payout changes and the moves sum to zero', () => {
    const plan = payoutFixPlan(problem([0, 500]));
    expect(plan.moves).toEqual([
      { userId: 'p', name: 'Pumča', amount: -351 },
      { userId: 'a', name: 'Anička', amount: 351 },
    ]);
    expect(plan.moves.reduce((n, m) => n + m.amount, 0)).toBe(0);
    expect(plan.credit).toEqual([]);
    expect(plan.short).toEqual([]);
  });
  it('reports an overpaid player who cannot return the money right now', () => {
    expect(payoutFixPlan(problem([0, 100])).short).toEqual([{ userId: 'p', name: 'Pumča', owes: 351, has: 100, credit: 0 }]);
    expect(payoutFixPlan(problem([0, 351])).short).toEqual([]);
  });
  it('covers the missing part from the overdraft when the free limit is enough', () => {
    const plan = payoutFixPlan(problem([0, 100], 251));
    expect(plan.credit).toEqual([{ userId: 'p', name: 'Pumča', owes: 351, has: 100, amount: 251 }]);
    expect(plan.short).toEqual([]);
    // a player who has enough does not touch the overdraft, however large the limit is
    expect(payoutFixPlan(problem([0, 351], 1000)).credit).toEqual([]);
  });
  it('one Korona over the free limit and the fix cannot be written', () => {
    const plan = payoutFixPlan(problem([0, 100], 250));
    expect(plan.credit).toEqual([]);
    expect(plan.short).toEqual([{ userId: 'p', name: 'Pumča', owes: 351, has: 100, credit: 250 }]);
  });
});
