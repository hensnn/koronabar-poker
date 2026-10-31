import { describe, expect, it } from 'vitest';
import { chipLeaderOf } from './chip-leader';

const p = (userId: string, chips: number | null, status = 'playing') => ({ userId, chips, status });

describe('chipleader turnaje', () => {
  it('je jím hráč s nejvíc žetony mezi těmi, kdo ještě hrají', () => {
    expect(chipLeaderOf([p('a', 500), p('b', 900), p('c', 300), p('d', 5000, 'out')])).toBe('b');
  });
  it('při shodě na prvním místě nebo méně než třech hráčích ve hře ho nikdo nemá', () => {
    expect(chipLeaderOf([p('a', 900), p('b', 900), p('c', 300)])).toBeNull();
    expect(chipLeaderOf([p('a', 900), p('b', 300)])).toBeNull();
    expect(chipLeaderOf(undefined)).toBeNull();
  });
  it('bez známých žetonů (živý turnaj) se nic neoznačuje; rozhodující hráč se počítá', () => {
    expect(chipLeaderOf([p('a', null), p('b', null), p('c', null)])).toBeNull();
    expect(chipLeaderOf([p('a', 100, 'deciding'), p('b', 50), p('c', 20)])).toBe('a');
  });
});
