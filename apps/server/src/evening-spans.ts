/**
 * Which evening a money movement belongs to. Shared by the evening summary and by the period settlement in the
 * wallet, so both agree on one rule:
 *  - a tournament or a live cash game belongs whole to the evening it is attached to, whenever its movements happened
 *    (registration days ahead, a payout after midnight);
 *  - a movement at a cash table belongs to the evening of that table whose cash window contains it. The window opens
 *    a little before the evening itself: the evening starts with the first hand, but the players bought in before it.
 */

export interface EveningSpan {
  id: string;
  startsAt: number;
  /** null = still open. */
  endsAt: number | null;
  /** Start of the cash window (see `cashWindowStart`); the window covers movements strictly after it. */
  cashFrom: number;
  /** Cash tables of the evening. */
  cash: Set<string>;
  /** Tournaments and live cash games: counted whole. */
  whole: Set<string>;
}

/**
 * Start of the cash window of an evening: `gapMs` before its start (the gap after which a new evening begins anyway),
 * but never into the previous evening. The window covers movements strictly after this moment: a movement at the very
 * moment the previous evening was closed stays with that evening and is not counted twice.
 */
export function cashWindowStart(startsAt: number, previousEnd: number | null, gapMs: number): number {
  return Math.max(previousEnd ?? Number.NEGATIVE_INFINITY, startsAt - gapMs);
}

export function buildSpans(evenings: { id: string; startsAt: Date; endsAt: Date | null }[], games: { eveningId: string; kind: string; ref: string }[], gapMs: number): EveningSpan[] {
  const sorted = [...evenings].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const spans = sorted.map((e): EveningSpan => {
    const startsAt = e.startsAt.getTime();
    const previousEnd = sorted.reduce<number | null>((best, o) => {
      const end = o.endsAt?.getTime();
      return o.id !== e.id && end !== undefined && end <= startsAt && (best === null || end > best) ? end : best;
    }, null);
    return { id: e.id, startsAt, endsAt: e.endsAt?.getTime() ?? null, cashFrom: cashWindowStart(startsAt, previousEnd, gapMs), cash: new Set(), whole: new Set() };
  });
  const byId = new Map(spans.map((s) => [s.id, s]));
  for (const g of games) {
    const span = byId.get(g.eveningId);
    if (span) (g.kind === 'cash' ? span.cash : span.whole).add(g.ref);
  }
  return spans;
}

/** The evening a movement of game `gameId` at time `at` belongs to, or null when it belongs to none. */
export function ownerOf(spans: EveningSpan[], gameId: string, at: number): EveningSpan | null {
  const whole = spans.find((s) => s.whole.has(gameId));
  if (whole) return whole;
  // spans are sorted by start: the latest evening whose window contains the moment wins
  let owner: EveningSpan | null = null;
  for (const s of spans) if (s.cash.has(gameId) && at > s.cashFrom && at <= (s.endsAt ?? Number.POSITIVE_INFINITY)) owner = s;
  return owner;
}
