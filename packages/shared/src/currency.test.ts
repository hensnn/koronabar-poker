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

describe('buy-in v měně', () => {
  it('BB × velký blind ÷ žetony na jednotku měny, jen pro klíče buy-inu', async () => {
    const { buyInInCurrency } = await import('./currency.js');
    const values = { 'table.bigBlind': 10, 'cash.chipsPerCurrencyUnit': 1, 'economy.currencyName': 'Korona', 'economy.currencyNameFew': 'Korony', 'economy.currencyNameMany': 'Koron' };
    expect(buyInInCurrency('cash.minBuyInBb', 40, values)).toBe('400 Koron');
    expect(buyInInCurrency('cash.maxBuyInBb', 100, { ...values, 'cash.chipsPerCurrencyUnit': 10 })).toBe('100 Koron');
    expect(buyInInCurrency('cash.minBuyInBb', 1, { ...values, 'table.bigBlind': 1 })).toBe('1 Korona');
    expect(buyInInCurrency('table.bigBlind', 40, values)).toBe('');
  });
});
