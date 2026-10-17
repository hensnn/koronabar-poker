import { distribute } from './tournament/bounty.js';

/**
 * Sázky vedle hry (virtuální měna): čistá logika vyhodnocení a dělení banku. Server s ní pracuje při zamykání vkladů
 * v účetní knize; tady není nic o penězích v knize, jen o tom, kdo kolik dostane.
 */
export const BET_SUBJECTS = ['winner', 'firstOut', 'duel', 'place', 'custom'] as const;
export type BetSubject = (typeof BET_SUBJECTS)[number];
export type BetSide = 'yes' | 'no';
export type BetOutcome = BetSide | 'void';

export interface BetParams {
  /** Hráč, o kterého jde (vítěz, první vyřazený, umístění). */
  userId?: string;
  /** Souboj: „ano“ znamená, že a skončí výš než b. */
  a?: string;
  b?: string;
  place?: number;
  /** Vlastní tvrzení. */
  text?: string;
}

export interface BetStake {
  userId: string;
  side: BetSide;
  amount: number;
}

/** Co o turnaji víme pro vyhodnocení. */
export interface TournamentFacts {
  status: 'registering' | 'running' | 'finished' | 'cancelled';
  /** Konečné pořadí (po skončení). */
  results: { userId: string; place: number }[] | null;
  /** První, kdo definitivně vypadl (null, dokud nikdo). */
  firstOut: string | null;
}

export type ParamsIssue = 'userId' | 'duel' | 'place' | 'text';

const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 80;

/** Zkontroluje parametry sázky podle jejího druhu a vrací jen povolená pole. */
export function validateBetParams(subject: BetSubject, p: BetParams): { ok: true; params: BetParams } | { ok: false; issue: ParamsIssue } {
  switch (subject) {
    case 'winner':
    case 'firstOut':
      return str(p.userId) ? { ok: true, params: { userId: p.userId } } : { ok: false, issue: 'userId' };
    case 'place':
      if (!str(p.userId)) return { ok: false, issue: 'userId' };
      return Number.isInteger(p.place) && p.place! >= 1 && p.place! <= 1000 ? { ok: true, params: { userId: p.userId, place: p.place } } : { ok: false, issue: 'place' };
    case 'duel':
      return str(p.a) && str(p.b) && p.a !== p.b ? { ok: true, params: { a: p.a, b: p.b } } : { ok: false, issue: 'duel' };
    case 'custom': {
      const text = (p.text ?? '').trim();
      return text.length >= 5 && text.length <= 200 ? { ok: true, params: { text } } : { ok: false, issue: 'text' };
    }
  }
}

/** Hráči, kterých se sázka týká (ti nesmí sázet proti sobě). */
export function subjectsOf(subject: BetSubject, p: BetParams): string[] {
  if (subject === 'duel') return [p.a, p.b].filter((x): x is string => !!x);
  if (subject === 'custom') return [];
  return p.userId ? [p.userId] : [];
}

/** Je strana sázky pro hráče výhodná, nevýhodná, nebo se ho netýká? */
export function favors(subject: BetSubject, p: BetParams, userId: string, side: BetSide): 'for' | 'against' | 'neutral' {
  if (!subjectsOf(subject, p).includes(userId)) return 'neutral';
  const yes = side === 'yes';
  switch (subject) {
    case 'winner':
    case 'place':
      return yes ? 'for' : 'against';
    case 'firstOut':
      return yes ? 'against' : 'for';
    case 'duel':
      return (userId === p.a) === yes ? 'for' : 'against';
    default:
      return 'neutral';
  }
}

/**
 * Výsledek sázky na herní výsledek. `null` = ještě nejde určit. `void` = sázka se ruší (turnaj zrušen,
 * hráč se nezúčastnil) a vklady se vrací.
 */
export function outcomeFor(subject: BetSubject, p: BetParams, f: TournamentFacts): BetOutcome | null {
  if (subject === 'custom') return null;
  if (f.status === 'cancelled') return 'void';
  if (subject === 'firstOut') {
    if (f.firstOut !== null) return f.firstOut === p.userId ? 'yes' : 'no';
    return f.status === 'finished' ? 'void' : null;
  }
  if (f.status !== 'finished' || !f.results) return null;
  const place = (u: string | undefined) => f.results!.find((r) => r.userId === u)?.place ?? null;
  switch (subject) {
    case 'winner': {
      const pl = place(p.userId);
      return pl === null ? 'void' : pl === 1 ? 'yes' : 'no';
    }
    case 'place': {
      const pl = place(p.userId);
      return pl === null ? 'void' : pl === p.place ? 'yes' : 'no';
    }
    case 'duel': {
      const a = place(p.a);
      const b = place(p.b);
      return a === null || b === null ? 'void' : a < b ? 'yes' : 'no';
    }
  }
}

export interface PoolSettlement {
  /** Co dostane který hráč (součet výher a vrácených vkladů). */
  payouts: { userId: string; amount: number }[];
  /** Poplatek domu. */
  fee: number;
  /** Sázka se zrušila a vklady se vracejí v původní výši. */
  refunded: boolean;
}

/**
 * Vypořádání sázkového banku: výherci si rozdělí celý bank poměrně podle vkladů (po odečtení poplatku domu).
 * Když nikdo nevyhrál, nebo nebyla protistrana, nebo je výsledek „zrušeno“, vrací se vklady beze změny.
 * Součet výplat + poplatek se vždy rovná součtu vkladů.
 */
export function settlePool(stakes: BetStake[], outcome: BetOutcome, feePercent: number): PoolSettlement {
  const sum = (side: BetSide) => stakes.filter((s) => s.side === side).reduce((n, s) => n + s.amount, 0);
  const merge = (list: { userId: string; amount: number }[]) => {
    const by = new Map<string, number>();
    for (const x of list) by.set(x.userId, (by.get(x.userId) ?? 0) + x.amount);
    return [...by].map(([userId, amount]) => ({ userId, amount }));
  };
  const total = sum('yes') + sum('no');
  if (outcome === 'void' || sum('yes') === 0 || sum('no') === 0) return { payouts: merge(stakes.map((s) => ({ userId: s.userId, amount: s.amount }))), fee: 0, refunded: true };
  const winners = stakes.filter((s) => s.side === outcome);
  const fee = Math.floor((total * Math.max(0, Math.min(100, feePercent))) / 100);
  const shares = distribute(total - fee, winners.map((s) => s.amount));
  return { payouts: merge(winners.map((s, i) => ({ userId: s.userId, amount: shares[i]! }))), fee, refunded: false };
}
