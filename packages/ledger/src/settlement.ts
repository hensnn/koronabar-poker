/** Jeden převod ve vyúčtování (vždy jen ve virtuální měně). */
export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

/**
 * Minimální počet převodů, který vyrovná zůstatky (součet musí být 0). Kdo vyhrál, má kladný
 * zůstatek, kdo prohrál, záporný. Hráči se rozdělí do co nejvíce skupin se součtem 0 (skupina
 * o k hráčích potřebuje k−1 převodů), takže výsledek je optimální. Pro víc než 16 nenulových
 * hráčů se použije rychlé chamtivé párování.
 */
export function minimalTransfers(balances: Record<string, number>): Transfer[] {
  const people = Object.entries(balances).filter(([, v]) => v !== 0);
  if (!people.every(([, v]) => Number.isInteger(v))) throw new Error('Zůstatky musí být celá čísla.');
  if (people.reduce((n, [, v]) => n + v, 0) !== 0) throw new Error('Součet zůstatků musí být nula.');
  if (people.length === 0) return [];
  const groups = people.length <= 16 ? bestPartition(people) : [people];
  return groups.flatMap(greedy);
}

function greedy(group: [string, number][]): Transfer[] {
  const debtors = group.filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v })).sort((a, b) => b.v - a.v);
  const creditors = group.filter(([, v]) => v > 0).map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v);
  const out: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i]!;
    const c = creditors[j]!;
    const amount = Math.min(d.v, c.v);
    out.push({ from: d.id, to: c.id, amount });
    d.v -= amount;
    c.v -= amount;
    if (d.v === 0) i++;
    if (c.v === 0) j++;
  }
  return out;
}

/** Rozdělení do nejvyššího počtu skupin se součtem 0 (dynamické programování přes podmnožiny). */
function bestPartition(people: [string, number][]): [string, number][][] {
  const n = people.length;
  const full = (1 << n) - 1;
  const sum = new Array<number>(1 << n).fill(0);
  for (let m = 1; m <= full; m++) {
    const low = m & -m;
    sum[m] = sum[m ^ low]! + people[31 - Math.clz32(low)]![1];
  }
  const best = new Array<number>(1 << n).fill(0);
  const choice = new Array<number>(1 << n).fill(0);
  for (let m = 1; m <= full; m++) {
    let top = 0;
    let pick = m;
    const low = m & -m;
    // Podmnožina s nejnižším bitem, jejíž součet je 0 a zbytek se dá rozdělit dál.
    for (let s = m; s > 0; s = (s - 1) & m) {
      if (!(s & low) || sum[s] !== 0) continue;
      const score = 1 + best[m ^ s]!;
      if (score > top) {
        top = score;
        pick = s;
      }
    }
    best[m] = top;
    choice[m] = pick;
  }
  const groups: [string, number][][] = [];
  let m = full;
  while (m > 0) {
    const s = choice[m]!;
    groups.push(people.filter((_, i) => s & (1 << i)));
    m ^= s;
  }
  return groups;
}
