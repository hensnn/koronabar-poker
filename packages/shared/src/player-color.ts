/** Počet základních odstínů (design tokeny `color.series1` až `color.series12`, upravitelné v editoru vzhledu). */
export const PLAYER_HUES = 12;
/** Počet tónů každého odstínu (od světlého po tmavý, prostřední je základní barva tokenu). */
export const PLAYER_SHADES = 5;
/** Počet všech barev hráčů: kód 1 až 60 = (odstín − 1) × 5 + tón. */
export const PLAYER_COLOR_COUNT = PLAYER_HUES * PLAYER_SHADES;
/** Tón, který je přesně barvou tokenu. */
export const PLAYER_BASE_SHADE = 3;

export const playerColorCode = (hue: number, shade: number): number => (hue - 1) * PLAYER_SHADES + shade;
export const playerColorParts = (code: number): { hue: number; shade: number } => {
  const c = ((Math.max(1, Math.round(code)) - 1) % PLAYER_COLOR_COUNT);
  return { hue: Math.floor(c / PLAYER_SHADES) + 1, shade: (c % PLAYER_SHADES) + 1 };
};

/** Poměr základní barvy v tónu 1 až 5: světlejší tóny se mísí s bílou, tmavší s černou. */
const SHADE_MIX = [
  { with: 'white', base: 38 },
  { with: 'white', base: 68 },
  null,
  { with: 'black', base: 72 },
  { with: 'black', base: 48 },
] as const;

/** CSS hodnota barvy hráče podle kódu 1 až 60 (z design tokenu odstínu, mění se s motivem). */
export function playerColorVar(code: number): string {
  const { hue, shade } = playerColorParts(code);
  const base = `var(--tk-color-series${hue})`;
  const m = SHADE_MIX[shade - 1];
  return m ? `color-mix(in srgb, ${base} ${m.base}%, ${m.with})` : base;
}

/** Pořadí, v jakém se barvy přidělují automaticky: nejdřív všech 12 odstínů v základním tónu, pak ve světlejších a tmavších. */
const AUTO_ORDER: number[] = [3, 2, 4, 1, 5].flatMap((shade) => Array.from({ length: PLAYER_HUES }, (_, h) => playerColorCode(h + 1, shade)));

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
  const free = AUTO_ORDER.filter((n) => !used.has(n));
  let k = 0;
  for (const u of [...users].sort((a, b) => a.order - b.order)) {
    if (out.has(u.id)) continue;
    out.set(u.id, free.length > 0 ? free[k % free.length]! : AUTO_ORDER[k % AUTO_ORDER.length]!);
    k++;
  }
  return out;
}
