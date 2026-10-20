/** Tvary názvu měny pro češtinu: 1 Korona, 2 až 4 Korony, 5 a víc Koron (a desetinná čísla: Koruny). */
export type CurrencyForms = readonly [one: string, few: string, many: string];

export function currencyWord(n: number, forms: CurrencyForms): string {
  if (!Number.isInteger(n)) return forms[1];
  const a = Math.abs(n);
  if (a === 1) return forms[0];
  if (a >= 2 && a <= 4) return forms[1];
  return forms[2];
}

/** „500 Koron“; číslo se píše s mezerami po tisících. */
export function formatCurrency(n: number, forms: CurrencyForms): string {
  return `${n.toLocaleString('cs-CZ')} ${currencyWord(n, forms)}`;
}

/** Tvary názvu měny z hodnot nastavení. */
export function currencyFormsOf(values: Record<string, unknown>): CurrencyForms {
  const one = String(values['economy.currencyName'] ?? 'Korona');
  return [one, String(values['economy.currencyNameFew'] ?? one), String(values['economy.currencyNameMany'] ?? one)];
}
