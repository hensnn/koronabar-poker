/** One finished tournament whose paid winnings differ from the recomputation (as sent by the server). */
export interface PayoutProblem {
  id: string;
  name: string;
  finishedAt: number | null;
  kind: 'fixable' | 'mismatch' | 'uncertain';
  pool: number;
  paidPlaces: number;
  /** `credit` is what the player can still draw from the overdraft (0 = nothing or switched off). */
  rows: { userId: string; name: string; place: number; paid: number; correct: number; balance: number; credit: number; flagged: boolean }[];
}

export interface PayoutFixPlan {
  /** Who gets how much (+) and who returns how much (−); the sum is always zero. Those who return come first. */
  moves: { userId: string; name: string; amount: number }[];
  /** Overpaid players whose balance does not cover the return, but their overdraft does: `amount` becomes their debt. */
  credit: { userId: string; name: string; owes: number; has: number; amount: number }[];
  /** Overpaid players who cannot return the money even with the overdraft: the fix cannot be written yet. */
  short: { userId: string; name: string; owes: number; has: number; credit: number }[];
}

/** What writing the fix would do, for display only: the server recomputes everything itself before moving anything. */
export function payoutFixPlan(p: PayoutProblem): PayoutFixPlan {
  const moves = p.rows
    .filter((r) => r.correct !== r.paid)
    .map((r) => ({ userId: r.userId, name: r.name, amount: r.correct - r.paid }))
    .sort((a, b) => a.amount - b.amount);
  const lacking = p.rows.filter((r) => r.paid - r.correct > r.balance).map((r) => ({ userId: r.userId, name: r.name, owes: r.paid - r.correct, has: r.balance, credit: r.credit }));
  const credit = lacking.filter((x) => x.owes - x.has <= x.credit).map((x) => ({ userId: x.userId, name: x.name, owes: x.owes, has: x.has, amount: x.owes - x.has }));
  const short = lacking.filter((x) => x.owes - x.has > x.credit);
  return { moves, credit, short };
}
