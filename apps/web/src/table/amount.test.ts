import { describe, expect, it } from 'vitest';
import { amountInRange, clampAmount } from './amount';

describe('částka sázky a buy-inu', () => {
  it('ořeže do rozsahu a zaokrouhlí na celé žetony', () => {
    expect(clampAmount(5, 20, 100)).toBe(20);
    expect(clampAmount(150, 20, 100)).toBe(100);
    expect(clampAmount(42.6, 20, 100)).toBe(43);
  });
  it('prázdné pole nebo NaN nikdy neprojde: dá minimum', () => {
    expect(clampAmount(NaN, 20, 100)).toBe(20);
    expect(clampAmount(Infinity, 20, 100)).toBe(20);
  });
  it('obrácený rozsah (max pod min) drží minimum', () => {
    expect(clampAmount(50, 20, 10)).toBe(20);
  });
  it('platnost pro odeslání: jen konečné číslo v rozsahu', () => {
    expect(amountInRange(20, 20, 100)).toBe(true);
    expect(amountInRange(100, 20, 100)).toBe(true);
    expect(amountInRange(101, 20, 100)).toBe(false);
    expect(amountInRange(NaN, 20, 100)).toBe(false);
  });
});
