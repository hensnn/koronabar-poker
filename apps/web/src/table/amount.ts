/** Ořízne částku do rozsahu [min, max] a zaokrouhlí na celé žetony; neplatná hodnota (prázdné pole, NaN) dá minimum. */
export function clampAmount(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(Math.max(min, max), Math.round(n)));
}

/** Je částka platná k odeslání: konečné číslo v rozsahu [min, max]? */
export function amountInRange(n: number, min: number, max: number): boolean {
  return Number.isFinite(n) && n >= min && n <= max;
}
