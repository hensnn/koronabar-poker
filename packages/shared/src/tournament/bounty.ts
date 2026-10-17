/**
 * Pomocné výpočty pro bounty turnaje: mystery hodnoty, dělení částek a výběr vyřazujícího.
 * Vše v celých číslech a tak, aby součet vždy přesně seděl (nic nevznikne ani nezmizí).
 */

export class BountyError extends Error {
  constructor(public readonly code: 'LADDER') {
    super(code);
  }
}

/** Rozdělí `total` v poměru vah na celá čísla se součtem přesně `total` (největší zbytek dostane zbytek). */
export function distribute(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    const even = Math.floor(total / weights.length);
    const out = weights.map(() => even);
    out[0]! += total - even * weights.length;
    return out;
  }
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((x) => Math.floor(x));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length) {
    out[order[k]!.i]! += 1;
    rest--;
  }
  return out;
}

/** Násobky mystery odměn z textu „0.5, 1, 1, 2, 10“ (kladná čísla; víckrát uvedená hodnota je pravděpodobnější). */
export function parseLadder(text: string): number[] {
  const nums = text
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((x) => Number(x));
  if (nums.length === 0 || nums.some((n) => !Number.isFinite(n) || n <= 0)) throw new BountyError('LADDER');
  return nums;
}

/**
 * Mystery hodnoty pro `count` hlav: každá hlava si náhodně vybere násobek ze žebříčku a hodnoty se přeškálují,
 * aby jejich součet byl přesně `total`. Každá hodnota je aspoň 1, pokud na to `total` stačí.
 * `rnd(n)` vrací celé číslo od 0 do n−1 (v produkci kryptografický generátor).
 */
export function mysteryValues(count: number, total: number, ladder: number[], rnd: (n: number) => number): number[] {
  if (count <= 0) return [];
  const picked = Array.from({ length: count }, () => ladder[rnd(ladder.length)]!);
  let values = distribute(total, picked);
  // Žádná hlava nesmí být nulová, když je co dělit: chybějící jednotky se vezmou největším.
  if (total >= count) {
    for (let i = 0; i < values.length; i++) {
      if (values[i]! > 0) continue;
      const max = values.reduce((b, v, k) => (v > values[b]! ? k : b), 0);
      values[max]! -= 1;
      values[i] = 1;
    }
  }
  values = values.slice();
  return values;
}

export interface ContestedPlayer {
  userId: string;
  /** Kolik hráč vložil do handy. */
  invested: number;
  /** Kolik z handy vyhrál. */
  won: number;
  /** Šance na výhru v okamžiku all-inu (jen heads-up all-in), jinak chybí. */
  equity?: number | null;
}

export type SplitRule = 'equal' | 'byWinnings';

/**
 * Kdo vyřadil hráče `victim`: vítězové handy, kteří měli vloženo aspoň tolik co on (mohli vyhrát jeho žetony).
 * Když takový není, vyřadil ho vítěz s nejvyšším vkladem. Při dělení potu mezi víc vítězů se odměna dělí
 * rovným dílem, nebo podle výše výhry. Vrací váhy pro `distribute`.
 */
export function pickEliminators(victim: ContestedPlayer, hand: ContestedPlayer[], rule: SplitRule): { userId: string; weight: number; equity?: number | null }[] {
  const winners = hand.filter((p) => p.userId !== victim.userId && p.won > 0);
  if (winners.length === 0) return [];
  let cover = winners.filter((w) => w.invested >= victim.invested);
  if (cover.length === 0) {
    const top = Math.max(...winners.map((w) => w.invested));
    cover = winners.filter((w) => w.invested === top);
  }
  return cover.map((w) => ({ userId: w.userId, weight: rule === 'byWinnings' ? w.won : 1, ...(w.equity != null ? { equity: w.equity } : {}) }));
}
