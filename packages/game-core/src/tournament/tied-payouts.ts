import { distribute } from '@kb/shared';
import type { TournamentState } from './tournament.js';

/** One finishing place: who took it and how much the place pays before ties are applied. */
export interface PlacedPayout {
  userId: string;
  place: number;
  payout: number;
}

/**
 * May the players of one remembered tie really share their payouts? Only eliminated players on neighbouring places:
 * never the winner and never places with somebody else in between. A tie that fails this is stale (a leftover of an
 * earlier shared bust after which the players bought back in) and must not move any money.
 */
export function tieIsShareable(places: number[]): boolean {
  if (places.length < 2) return false;
  const sorted = [...places].sort((a, b) => a - b);
  return sorted[0]! > 1 && sorted[sorted.length - 1]! - sorted[0]! === sorted.length - 1;
}

/**
 * Players eliminated in the same hand with equal stacks share the payouts of their places in equal parts.
 * `fixed` marks players whose amount is settled otherwise (a deal) and who therefore never share.
 * Returns the payouts in the order of `rows`; the total never changes.
 */
export function applyTiedPayouts(rows: PlacedPayout[], tiedGroups: string[][], fixed: (userId: string) => boolean = () => false): number[] {
  const out = rows.map((r) => r.payout);
  for (const group of tiedGroups) {
    const idx = rows.map((r, i) => (group.includes(r.userId) && !fixed(r.userId) ? i : -1)).filter((i) => i >= 0);
    if (!tieIsShareable(idx.map((i) => rows[i]!.place))) continue;
    const parts = distribute(idx.reduce((n, i) => n + out[i]!, 0), idx.map(() => 1));
    idx.forEach((i, k) => {
      out[i] = parts[k]!;
    });
  }
  return out;
}

export interface PayoutAuditInput {
  /** Final results in order of places, with what was really paid. */
  results: PlacedPayout[];
  /** Payout table for places 1..n (index 0 = winner) computed from the prize pool. */
  amounts: number[];
  deal?: { amounts: Record<string, number>; keep: number } | null;
  tiedGroups: string[][];
  /** Players who bought back in (rebuy) during the tournament: only they can be part of a stale tie. */
  rebought: ReadonlySet<string>;
}

export interface PayoutAudit {
  /** What each place should have been paid, in the order of `results`. */
  correct: number[];
  /** Ties that can never be valid (winner or distant places): the cause of wrongly shared payouts. */
  stale: string[][];
  /** Ties on neighbouring places where a member bought back in: the record cannot tell whether they really busted together. */
  uncertain: string[][];
  /**
   * `ok`: paid matches. `fixable`: every difference is explained by a stale tie and the total is unchanged.
   * `mismatch`: paid differs for another reason (the recomputation cannot be trusted, review by hand).
   */
  verdict: 'ok' | 'fixable' | 'mismatch';
}

/** Recomputes the payouts of a finished tournament and compares them with what was paid. Pure; reads nothing else. */
export function auditPayouts(input: PayoutAuditInput): PayoutAudit {
  const { results, deal } = input;
  const inDeal = (userId: string) => !!deal && userId in deal.amounts;
  const base = results.map((r, i) => ({ userId: r.userId, place: r.place, payout: inDeal(r.userId) ? deal!.amounts[r.userId]! + (i === 0 ? deal!.keep : 0) : (input.amounts[i] ?? 0) }));
  const correct = applyTiedPayouts(base, input.tiedGroups, inDeal);
  const stale: string[][] = [];
  const uncertain: string[][] = [];
  for (const group of input.tiedGroups) {
    const members = results.filter((r) => group.includes(r.userId) && !inDeal(r.userId));
    if (members.length < 2) continue;
    if (!tieIsShareable(members.map((r) => r.place))) stale.push(members.map((r) => r.userId));
    else if (members.some((r) => input.rebought.has(r.userId))) uncertain.push(members.map((r) => r.userId));
  }
  const differs = results.map((r, i) => r.payout !== correct[i]);
  if (!differs.some(Boolean)) return { correct, stale, uncertain, verdict: 'ok' };
  const staleIds = new Set(stale.flat());
  const sameTotal = results.reduce((n, r) => n + r.payout, 0) === correct.reduce((n, x) => n + x, 0);
  const explained = results.every((r, i) => !differs[i] || staleIds.has(r.userId));
  return { correct, stale, uncertain, verdict: sameTotal && explained ? 'fixable' : 'mismatch' };
}

/**
 * Writes corrected payouts into the state of a finished tournament: remembers what was paid originally, replaces the
 * payouts and drops ties that can never be valid (so a later check finds nothing). Throws when the correction would
 * change the total or name a player who is not in the results.
 */
export function correctFinishedState(st: Pick<TournamentState, 'status' | 'results' | 'tiedGroups' | 'payoutFix'>, correct: Record<string, number>, at: number): void {
  const results = st.results;
  if (st.status !== 'finished' || !results) throw new Error('payout correction: tournament is not finished');
  const known = new Set(results.map((r) => r.userId));
  if (Object.keys(correct).some((id) => !known.has(id))) throw new Error('payout correction: unknown player');
  const next = results.map((r) => correct[r.userId] ?? r.payout);
  if (next.some((x) => !Number.isInteger(x) || x < 0)) throw new Error('payout correction: invalid amount');
  if (next.reduce((n, x) => n + x, 0) !== results.reduce((n, r) => n + r.payout, 0)) throw new Error('payout correction: total would change');
  st.payoutFix = { at, before: { ...(st.payoutFix?.before ?? {}), ...Object.fromEntries(results.filter((r, i) => r.payout !== next[i] && !(r.userId in (st.payoutFix?.before ?? {}))).map((r) => [r.userId, r.payout])) } };
  results.forEach((r, i) => {
    r.payout = next[i]!;
  });
  if (st.tiedGroups) {
    const placeOf = new Map(results.map((r) => [r.userId, r.place]));
    st.tiedGroups = st.tiedGroups.filter((g) => tieIsShareable(g.filter((id) => placeOf.has(id)).map((id) => placeOf.get(id)!)));
  }
}
