import { describe, expect, it } from 'vitest';
import type { TableView } from '@kb/game-core';
import { detectSfx, warningMarks } from './sfx';


const view = (over: Record<string, unknown> = {}): TableView =>
  ({
    handId: 'h1',
    street: 'PREFLOP',
    board: [],
    actingSeat: null,
    viewerSeat: 0,
    bankActive: false,
    winners: null,
    seats: [
      { seat: 0, bet: 0, status: 'active' },
      { seat: 1, bet: 0, status: 'active' },
    ],
    ...over,
  }) as unknown as TableView;

describe('zvuky hry: co se stane mezi dvěma pohledy', () => {
  it('při prvním pohledu je ticho', () => {
    expect(detectSfx(null, view({ actingSeat: 0 }))).toEqual([]);
  });

  it('nová handa a otočení karet na stole', () => {
    expect(detectSfx(view({ handId: 'h1' }), view({ handId: 'h2' }))).toEqual(['newHand']);
    expect(detectSfx(view({ board: [] }), view({ board: ['As', 'Kd', '7c'] }))).toEqual(['flip']);
  });

  it('sázka je žeton, all-in má vlastní zvuk místo žetonu, fold a check se rozliší', () => {
    const base = view({ actingSeat: 1 });
    expect(detectSfx(base, view({ actingSeat: 0, seats: [{ seat: 0, bet: 0, status: 'active' }, { seat: 1, bet: 40, status: 'active' }] }))).toEqual(['chip', 'turn']);
    expect(detectSfx(base, view({ actingSeat: 0, seats: [{ seat: 0, bet: 0, status: 'active' }, { seat: 1, bet: 900, status: 'allIn' }] }))).toEqual(['allIn', 'turn']);
    expect(detectSfx(base, view({ actingSeat: 0, seats: [{ seat: 0, bet: 0, status: 'active' }, { seat: 1, bet: 0, status: 'folded' }] }))).toEqual(['fold', 'turn']);
    expect(detectSfx(base, view({ actingSeat: 0 }))).toEqual(['check', 'turn']);
  });

  it('přechod na další ulici (žetony se smetou do potu) není check ani sázka', () => {
    const before = view({ street: 'PREFLOP', actingSeat: 1, seats: [{ seat: 0, bet: 20, status: 'active' }, { seat: 1, bet: 20, status: 'active' }] });
    const after = view({ street: 'FLOP', board: ['As', 'Kd', '7c'], actingSeat: null });
    expect(detectSfx(before, after)).toEqual(['flip']);
  });

  it('zvuk tahu zazní jen mně, ne při tahu soupeře; time bank jen na mém tahu', () => {
    expect(detectSfx(view({ actingSeat: null }), view({ actingSeat: 1 }))).toEqual([]);
    expect(detectSfx(view({ actingSeat: null }), view({ actingSeat: 0 }))).toEqual(['turn']);
    expect(detectSfx(view({ actingSeat: 0 }), view({ actingSeat: 0, bankActive: true }))).toEqual(['timeBank']);
    expect(detectSfx(view({ actingSeat: 1 }), view({ actingSeat: 1, bankActive: true }))).toEqual([]);
    // divák slyší tah soupeře (check), ale zvuk "jsi na tahu" ne
    expect(detectSfx(view({ actingSeat: 0, viewerSeat: null }), view({ actingSeat: 1, viewerSeat: null }))).toEqual(['check']);
  });

  it('výhra: delší fanfára, když vyhraju já', () => {
    const won = (seat: number) => ({ winners: [{ seat, amount: 100, hand: null }] });
    expect(detectSfx(view(), view(won(1)))).toEqual(['win']);
    expect(detectSfx(view(), view(won(0)))).toEqual(['winMe']);
    expect(detectSfx(view(won(0)), view(won(0)))).toEqual([]);
  });

  it('upozornění na čas: zadaná hranice a její polovina', () => {
    expect(warningMarks(10)).toEqual([10, 5]);
    expect(warningMarks(2)).toEqual([2, 1]);
    expect(warningMarks(1)).toEqual([1]);
  });
});
