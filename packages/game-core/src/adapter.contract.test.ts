import { describe, it, expect } from 'vitest';
import { PokertoolsAdapter, type PokerEngineAdapter } from './adapter.js';
import { GameError } from './types.js';

const cfg = { smallBlind: 5, bigBlind: 10, ante: 0, maxPlayers: 9, timeBankSeconds: 30 };

function setup(stacks: number[], c = cfg): PokerEngineAdapter {
  const a = new PokertoolsAdapter(c);
  stacks.forEach((s, i) => a.seat(i, `p${i}`, `P${i}`, s));
  a.startHand();
  return a;
}
const total = (a: PokerEngineAdapter) => {
  const s = a.state();
  return s.players.reduce((n, p) => n + p.stack + p.bet, 0) + s.pots.reduce((n, p) => n + p.amount, 0);
};
const actor = (a: PokerEngineAdapter) => a.state().players.find((p) => p.seat === a.state().actingSeat)!.playerId;

/** Sada kontrolních testů, která musí splnit každý engine za adaptérem. */
describe('PokerEngineAdapter (kontrolní sada)', () => {
  it('rozdá po dvou kartách a balíček neobsahuje rozdané karty ani board', () => {
    const a = setup([1000, 1000, 1000]);
    const s = a.state();
    const dealt = s.players.flatMap((p) => p.hole!);
    expect(dealt).toHaveLength(6);
    expect(new Set(dealt).size).toBe(6);
    const deck = a.remainingDeck();
    expect(new Set(deck).size).toBe(deck.length);
    for (const c of [...dealt, ...s.board]) expect(deck).not.toContain(c);
    expect(deck.length + dealt.length + s.board.length).toBe(52);
  });

  it('legální akce vidí jen hráč na tahu', () => {
    const a = setup([1000, 1000, 1000]);
    const id = actor(a);
    const other = a.state().players.find((p) => p.playerId !== id)!.playerId;
    expect(a.legalActions(other)).toBeNull();
    const l = a.legalActions(id)!;
    expect(l.callAmount).toBe(10);
    expect(l.canCheck).toBe(false);
    expect(l.canRaise).toBe(true);
    expect(l.minRaiseTo).toBe(20);
    expect(l.maxRaiseTo).toBe(1000);
  });

  it('nelegální akce vrací GameError s kódem', () => {
    const a = setup([1000, 1000, 1000]);
    const other = a.state().players.find((p) => p.playerId !== actor(a))!.playerId;
    expect(() => a.act(other, { type: 'fold' })).toThrow(GameError);
    try {
      a.act(other, { type: 'check' });
    } catch (e) {
      expect((e as GameError).code).toBe('NOT_YOUR_TURN');
    }
    expect(() => a.act(actor(a), { type: 'check' })).toThrow(GameError);
    expect(() => a.act(actor(a), { type: 'raise', amount: 11 })).toThrow(GameError);
  });

  it('side poty: tři all-iny s různými stacky, nevyrovnaná část se vrací', () => {
    const a = setup([100, 300, 600]);
    const before = total(a);
    for (let i = 0; i < 10 && !a.state().finished; i++) a.act(actor(a), { type: 'allIn' });
    const s = a.state();
    expect(s.finished).toBe(true);
    expect(s.winners!.reduce((n, w) => n + w.amount, 0)).toBe(700);
    expect(s.players.reduce((n, p) => n + p.stack, 0)).toBe(before);
    expect(s.board).toHaveLength(5);
  });

  it('součet žetonů se po celou handu zachovává', () => {
    const a = setup([500, 800, 1200, 300]);
    const before = total(a);
    let g = 0;
    while (!a.state().finished && g++ < 50) {
      const id = actor(a);
      const l = a.legalActions(id)!;
      a.act(id, l.canCheck ? { type: 'check' } : { type: 'call' });
      expect(total(a)).toBe(before);
    }
    expect(a.state().finished).toBe(true);
  });

  it('snapshot a obnova zachovají stav a hru lze dohrát', () => {
    const a = setup([500, 500]);
    a.act(actor(a), { type: 'call' });
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    const b = PokertoolsAdapter.restore(cfg, snap);
    expect(b.state().actingSeat).toBe(a.state().actingSeat);
    expect(b.state().players.map((p) => p.hole)).toEqual(a.state().players.map((p) => p.hole));
    b.act(actor(b), { type: 'check' });
    expect(b.state().street).toBe('FLOP');
  });

  it('heads-up: dealer je small blind a jedná první preflop', () => {
    const a = setup([500, 500]);
    const s = a.state();
    const sb = s.players.find((p) => p.bet === 5)!;
    expect(s.buttonSeat).toBe(sb.seat);
    expect(s.actingSeat).toBe(sb.seat);
  });

  it('další handa po skončení posune button', () => {
    const a = setup([500, 500, 500]);
    const first = a.state().buttonSeat;
    a.act(actor(a), { type: 'fold' });
    a.act(actor(a), { type: 'fold' });
    expect(a.state().finished).toBe(true);
    expect(a.canStartHand()).toBe(true);
    a.startHand();
    expect(a.state().buttonSeat).not.toBe(first);
  });

  it('ante se strhává od všech hráčů', () => {
    const a = setup([1000, 1000, 1000], { ...cfg, ante: 2 });
    expect(total(a)).toBe(3000);
    expect(a.state().players.reduce((n, p) => n + p.invested, 0)).toBeGreaterThanOrEqual(6 + 15);
  });

  it('karty se míchají kryptograficky: dvě handy mají různé karty', () => {
    const hands = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const a = setup([100, 100]);
      hands.add(a.state().players[0]!.hole!.join(''));
    }
    expect(hands.size).toBeGreaterThan(10);
  });
});
