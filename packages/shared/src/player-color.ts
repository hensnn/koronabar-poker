/** Počet barev hráčů (design tokeny `color.series1` až `color.series12`, upravitelné v editoru vzhledu). */
export const PLAYER_COLOR_COUNT = 12;

/** CSS hodnota barvy hráče podle čísla 1 až PLAYER_COLOR_COUNT (z design tokenu, mění se s motivem). */
export const playerColorVar = (n: number): string => `var(--tk-color-series${((Math.max(1, Math.round(n)) - 1) % PLAYER_COLOR_COUNT) + 1})`;

/**
 * Efektivní barvy hráčů: ručně přidělená (správcem) platí vždy, ostatní dostanou volné barvy podle pořadí registrace,
 * takže se barvy neopakují, dokud hráčů není víc než barev.
 */
export function assignPlayerColors(users: { id: string; chartColor: number | null; order: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  for (const u of users) {
    if (u.chartColor && u.chartColor >= 1 && u.chartColor <= PLAYER_COLOR_COUNT) {
      out.set(u.id, u.chartColor);
      used.add(u.chartColor);
    }
  }
  const free = Array.from({ length: PLAYER_COLOR_COUNT }, (_, i) => i + 1).filter((n) => !used.has(n));
  let k = 0;
  for (const u of [...users].sort((a, b) => a.order - b.order)) {
    if (out.has(u.id)) continue;
    out.set(u.id, free.length > 0 ? free[k % free.length]! : (k % PLAYER_COLOR_COUNT) + 1);
    k++;
  }
  return out;
}
