/** One finished tournament whose paid winnings differ from the recomputation (as sent by the server). */
export interface PayoutProblem {
  id: string;
  name: string;
  finishedAt: number | null;
  kind: 'fixable' | 'mismatch' | 'uncertain';
  pool: number;
  paidPlaces: number;
  rows: { userId: string; name: string; place: number; paid: number; correct: number; balance: number; flagged: boolean }[];
}

export interface PayoutFixPlan {
  /** Who gets how much (+) and who returns how much (−); the sum is always zero. Those who return come first. */
  moves: { userId: string; name: string; amount: number }[];
  /** Overpaid players whose current balance does not cover what they should return: the fix cannot be written yet. */
  short: { userId: string; name: string; owes: number; has: number }[];
}

/** What writing the fix would do, for display only: the server recomputes everything itself before moving anything. */
export function payoutFixPlan(p: PayoutProblem): PayoutFixPlan {
  const moves = p.rows
    .filter((r) => r.correct !== r.paid)
    .map((r) => ({ userId: r.userId, name: r.name, amount: r.correct - r.paid }))
    .sort((a, b) => a.amount - b.amount);
  const short = p.rows.filter((r) => r.paid - r.correct > r.balance).map((r) => ({ userId: r.userId, name: r.name, owes: r.paid - r.correct, has: r.balance }));
  return { moves, short };
}
