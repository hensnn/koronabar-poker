import { describe, expect, it } from 'vitest';
import { dealOrder, dealSlots, dealTiming, flyOffset } from './deal';

const seats = (...n: number[]) => n.map((seat) => ({ seat, hasCards: true }));

describe('rozdávání karet', () => {
  it('začíná prvním hráčem po tlačítku a jde dokola', () => {
    expect(dealOrder(seats(0, 2, 4, 6), 2)).toEqual([4, 6, 0, 2]);
    expect(dealOrder(seats(0, 2, 4, 6), 6)).toEqual([0, 2, 4, 6]);
    expect(dealOrder(seats(1, 3), null)).toEqual([1, 3]);
  });

  it('přeskočí hráče bez karet', () => {
    expect(dealOrder([{ seat: 0, hasCards: true }, { seat: 1, hasCards: false }, { seat: 2, hasCards: true }], 0)).toEqual([2, 0]);
    expect(dealOrder([], 0)).toEqual([]);
  });

  it('nejdřív dostane každý první kartu, potom druhou', () => {
    const slots = dealSlots([4, 6, 0]);
    expect(slots.get('4:0')).toBe(0);
    expect(slots.get('6:0')).toBe(1);
    expect(slots.get('0:0')).toBe(2);
    expect(slots.get('4:1')).toBe(3);
    expect(slots.get('0:1')).toBe(5);
    expect(slots.size).toBe(6);
  });

  it('celé rozdání nepřekročí strop, odstup mezi kartami respektuje nastavení', () => {
    expect(dealTiming(8, 280).stepMs).toBe(280);
    const full = dealTiming(18, 800);
    expect(full.totalMs).toBeLessThanOrEqual(4000);
    expect(dealTiming(4, 280).totalMs).toBe(650 + 4 * 280);
    expect(dealTiming(0, 280).totalMs).toBe(650);
  });

  it('posun karty je rozdíl pozic rozdávajícího a hráče', () => {
    expect(flyOffset({ left: 50, top: 10 }, { left: 20, top: 60 })).toEqual({ dx: 30, dy: -50 });
  });
});
