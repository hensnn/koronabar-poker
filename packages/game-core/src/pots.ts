import type { HandState } from './types.js';

export interface SidePot {
  amount: number;
  /** Sedadla, která mohou pot vyhrát (nesložená). */
  eligibleSeats: number[];
}

/**
 * Rozdělení vložených žetonů na hlavní a vedlejší poty podle celkového vkladu hráčů.
 * Nevyrovnaná část nejvyššího vkladu (bez protihráče) do žádného potu nepatří.
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
    // Pot, o který soupeří jen jeden hráč, je nevyrovnaná sázka: do potů nepatří.
    if (eligible.length >= 2) pots.push({ amount, eligibleSeats: eligible });
    prev = level;
  }
  return pots;
}
