import { describe, expect, it } from 'vitest';
import { currencyFormsOf, currencyWord, formatCurrency } from './currency.js';

const f = ['Korona', 'Korony', 'Koron'] as const;

describe('název měny podle počtu', () => {
  it('1 Korona, 2 až 4 Korony, jinak Koron', () => {
    expect([0, 1, 2, 4, 5, 21, 500].map((n) => currencyWord(n, f))).toEqual(['Koron', 'Korona', 'Korony', 'Korony', 'Koron', 'Koron', 'Koron']);
    expect(currencyWord(1.5, f)).toBe('Korony');
    expect(formatCurrency(12500, f)).toMatch(/^12\s500 Koron$/);
  });
  it('tvary z nastavení; bez nich zůstane základní název', () => {
    expect(currencyFormsOf({ 'economy.currencyName': 'Korona', 'economy.currencyNameFew': 'Korony', 'economy.currencyNameMany': 'Koron' })).toEqual(f);
    expect(currencyFormsOf({ 'economy.currencyName': 'KČ' })).toEqual(['KČ', 'KČ', 'KČ']);
  });
});
