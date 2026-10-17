import { distribute } from './bounty.js';

/**
 * Dělení prize poolu (deal) mezi zbývající hráče. Dělí se měna z poolu, ne žetony:
 * žetony jen určují podíl (ICM, chip chop). Součet částek je vždy přesně dělená částka.
 */

export type DealMethod = 'icm' | 'chipChop' | 'equal' | 'custom';

export class DealError extends Error {
  constructor(public readonly code: 'CUSTOM_SUM' | 'CUSTOM_PLAYERS' | 'CUSTOM_NEGATIVE' | 'EMPTY') {
    super(code);
  }
}

export interface DealParticipant {
  userId: string;
  chips: number;
}

/**
 * ICM (Malmuth–Harville): očekávaná výhra každého hráče z cen `prizes` (1. místo první) podle žetonů.
 * Pravděpodobnost, že hráč skončí první, je jeho podíl žetonů, na dalších místech se počítá stejně ze zbylých.
 * Počítá se dynamickým programováním přes podmnožiny, tedy rychle i pro 10 hráčů.
 */
export function icmEquity(stacks: number[], prizes: number[]): number[] {
  const n = stacks.length;
  if (n === 0) return [];
  const prize = (place: number) => prizes[place] ?? 0;
  const total = stacks.reduce((a, b) => a + b, 0);
  if (total <= 0) return stacks.map(() => prizes.reduce((a, b) => a + b, 0) / n);
  const full = 1 << n;
  const sum = new Array<number>(full).fill(0);
  for (let m = 1; m < full; m++) {
    const low = m & -m;
    sum[m] = sum[m ^ low]! + stacks[31 - Math.clz32(low)]!;
  }
  // prob[m] = pravděpodobnost, že přesně hráči v množině m obsadí první |m| míst (v libovolném pořadí)
  const prob = new Array<number>(full).fill(0);
  prob[0] = 1;
  const equity = new Array<number>(n).fill(0);
  const popcount = (x: number) => {
    let c = 0;
    for (; x; x &= x - 1) c++;
    return c;
  };
  for (let m = 0; m < full - 1; m++) {
    if (prob[m] === 0) continue;
    const remaining = total - sum[m]!;
    if (remaining <= 0) continue;
    const place = popcount(m);
    for (let i = 0; i < n; i++) {
      if (m & (1 << i)) continue;
      const p = prob[m]! * (stacks[i]! / remaining);
      prob[m | (1 << i)] = prob[m | (1 << i)]! + p;
      equity[i]! += p * prize(place);
    }
  }
  return equity;
}

/** Zaokrouhlení dolů na násobek jednotky; zbytek připadne hráči s nejvíc žetony (při shodě prvnímu). */
function roundTo(amounts: number[], participants: DealParticipant[], total: number, unit: number): number[] {
  if (unit <= 1) return amounts;
  const out = amounts.map((a) => Math.floor(a / unit) * unit);
  const rest = total - out.reduce((a, b) => a + b, 0);
  const lead = participants.reduce((best, p, i) => (p.chips > participants[best]!.chips ? i : best), 0);
  out[lead]! += rest;
  return out;
}

/** Částky pro jednu metodu. `total` je dělená částka (po odečtení části ponechané na hru). */
export function dealAmounts(method: DealMethod, participants: DealParticipant[], total: number, opt: { roundTo?: number; prizes?: number[]; custom?: Record<string, number> } = {}): Record<string, number> {
  if (participants.length === 0) throw new DealError('EMPTY');
  let amounts: number[];
  if (method === 'custom') {
    const custom = opt.custom ?? {};
    const ids = participants.map((p) => p.userId);
    if (Object.keys(custom).length !== ids.length || ids.some((id) => !(id in custom))) throw new DealError('CUSTOM_PLAYERS');
    amounts = ids.map((id) => custom[id]!);
    if (amounts.some((a) => !Number.isInteger(a) || a < 0)) throw new DealError('CUSTOM_NEGATIVE');
    if (amounts.reduce((a, b) => a + b, 0) !== total) throw new DealError('CUSTOM_SUM');
    return Object.fromEntries(ids.map((id, i) => [id, amounts[i]!]));
  }
  if (method === 'equal') amounts = distribute(total, participants.map(() => 1));
  else if (method === 'chipChop') amounts = distribute(total, participants.map((p) => p.chips));
  else {
    // ICM: vahy jsou očekávané výhry z cen; ceny se přeškálují na dělenou částku
    const prizes = opt.prizes ?? [total];
    amounts = distribute(total, icmEquity(participants.map((p) => p.chips), prizes));
  }
  amounts = roundTo(amounts, participants, total, opt.roundTo ?? 1);
  return Object.fromEntries(participants.map((p, i) => [p.userId, amounts[i]!]));
}
