import type { HandState } from './types.js';

export interface SidePot {
  amount: number;
  /** Sedadla, která mohou pot vyhrát (nesložená). */
  eligibleSeats: number[];
}

/**
 * Rozdělení vložených žetonů na hlavní a vedlejší poty podle celkového vkladu hráčů.
 * Nevyrovnaná část nejvyššího vkladu (bez protihráče) do žádného potu nepatří; peníze složených hráčů v patře s jediným zbývajícím hráčem ale ano.
 * Engine-nezávislé, používá se pro šance na výhru po potech a jako křížová kontrola výsledků enginu.
 */
export function computeSidePots(h: Pick<HandState, 'players'>): SidePot[] {
  const levels = [...new Set(h.players.filter((p) => p.invested > 0 && p.status !== 'folded').map((p) => p.invested))].sort((a, b) => a - b);
  const pots: SidePot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of h.players) amount += Math.max(0, Math.min(p.invested, level) - prev);
    const eligible = h.players.filter((p) => p.status !== 'folded' && p.invested >= level).map((p) => p.seat);
    if (eligible.length >= 2) pots.push({ amount, eligibleSeats: eligible });
    else if (eligible.length === 1) {
      // Jediný zbývající hráč: jeho přebytek nad nejvyšším vkladem soupeřů je nevyrovnaná sázka (do potu nepatří),
      // ale to, co do tohoto patra vložili složení hráči, je živý pot, který tento hráč vyhrává.
      const mine = Math.max(0, Math.min(h.players.find((p) => p.seat === eligible[0])!.invested, level) - prev);
      const others = h.players.filter((p) => p.seat !== eligible[0]).map((p) => Math.max(0, Math.min(p.invested, level) - prev));
      const matched = Math.min(mine, Math.max(0, ...others));
      const live = others.reduce((n, x) => n + x, 0) + matched;
      if (others.some((x) => x > 0)) pots.push({ amount: live, eligibleSeats: eligible });
    }
    prev = level;
  }
  return pots;
}
