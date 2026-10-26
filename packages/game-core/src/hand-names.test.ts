import { describe, it, expect } from 'vitest';
import { t } from '@kb/shared';
import { describeHand } from './hand-names.js';

const cz = (cards: string[]) => {
  const d = describeHand(cards)!;
  return t(d.key, d.params);
};

describe('české popisy kombinací', () => {
  it('všechny kategorie', () => {
    expect(cz(['Qs', 'Jd', 'Th', '9c', '8s'])).toBe('Postupka do dámy');
    expect(cz(['5s', '4d', '3h', '2c', 'As'])).toBe('Postupka do pětky');
    expect(cz(['As', 'Ad', 'Kh', 'Kc', '2s'])).toBe('Dvě dvojice (es a králů)');
    expect(cz(['As', 'Ad', 'Kh', '9c', '2s'])).toBe('Dvojice es');
    expect(cz(['7s', '7d', '7h', '9c', '2s'])).toBe('Trojice sedmiček');
    expect(cz(['9s', '9d', '9h', '9c', '2s'])).toBe('Čtveřice devítek');
    expect(cz(['Ks', 'Kd', 'Kh', '2c', '2s'])).toBe('Full house (králů na dvojek)');
    expect(cz(['As', 'Js', '9s', '4s', '2s'])).toBe('Barva, nejvyšší eso');
    expect(cz(['9s', '8s', '7s', '6s', '5s'])).toBe('Postupka v barvě do devítky');
    expect(cz(['As', 'Ks', 'Qs', 'Js', 'Ts'])).toBe('Royal flush');
    expect(cz(['As', 'Jd', '9h', '4c', '2s'])).toBe('Nejvyšší karta: eso');
  });
  it('nevalidní počet karet nevrátí popis', () => {
    expect(describeHand(['As', 'Ks'])).toBeNull();
  });
});

describe('pořadí nejlepší pětice k zobrazení', () => {
  it('dvojice, trojice a čtveřice nejdřív; jinak od nejvyšší; postupka s esem dole má eso na konci', async () => {
    const { orderBestFive } = await import('./hand-names.js');
    expect(orderBestFive(['2c', 'Kd', '9h', 'Kc', '4s'])).toEqual(['Kd', 'Kc', '9h', '4s', '2c'].map((c) => c));
    expect(orderBestFive(['5c', '5d', '9h', '9c', 'Ks'])).toEqual(['9h', '9c', '5c', '5d', 'Ks']);
    expect(orderBestFive(['Ah', '2c', '3d', '4s', '5h'])).toEqual(['5h', '4s', '3d', '2c', 'Ah']);
  });
});
