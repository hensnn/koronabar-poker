import { describe, expect, it } from 'vitest';
import { PokertoolsAdapter } from './adapter.js';
import { GameError } from './types.js';

const cfg = { smallBlind: 5, bigBlind: 10, ante: 0, maxPlayers: 9, timeBankSeconds: 30 };

function setup(mode: 'noLimit' | 'potLimit' | 'fixedLimit', maxBets = 4, stacks = [1000, 1000]) {
  const a = new PokertoolsAdapter(cfg);
  stacks.forEach((s, i) => a.seat(i, `p${i}`, `P${i}`, s));
  a.setLimit(mode, maxBets);
  a.startHand();
  return a;
}
const actor = (a: PokertoolsAdapter) => a.state().players.find((p) => p.seat === a.state().actingSeat)!.playerId;

describe('sázkový limit v adaptéru', () => {
  it('fixed-limit: jedna povolená výše sázky, small bet před flopem a na flopu, big bet na turnu a riveru', () => {
    const a = setup('fixedLimit');
    let l = a.legalActions(actor(a))!;
    // před flopem: button/SB doplácí 5, zvýšení na 20
    expect(l.canRaise).toBe(true);
    expect([l.minRaiseTo, l.maxRaiseTo]).toEqual([20, 20]);
    expect(() => a.act(actor(a), { type: 'raise', amount: 35 })).toThrowError(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
    a.act(actor(a), { type: 'call' });
    a.act(actor(a), { type: 'check' });
    expect(a.state().street).toBe('FLOP');
    l = a.legalActions(actor(a))!;
    expect(l.canBet).toBe(true);
    expect([l.minRaiseTo, l.maxRaiseTo]).toEqual([10, 10]);
    a.act(actor(a), { type: 'check' });
    a.act(actor(a), { type: 'check' });
    expect(a.state().street).toBe('TURN');
    l = a.legalActions(actor(a))!;
    expect([l.minRaiseTo, l.maxRaiseTo]).toEqual([20, 20]);
    a.act(actor(a), { type: 'bet', amount: 20 });
    l = a.legalActions(actor(a))!;
    expect(l.canRaise).toBe(true);
    expect([l.minRaiseTo, l.maxRaiseTo]).toEqual([40, 40]);
  });

  it('fixed-limit: nejvýš zadaný počet sázek na kolo, potom už jen dorovnání', () => {
    const a = setup('fixedLimit', 4);
    // před flopem: blind je 1. sázka, tři zvýšení (na 20, 30, 40)
    for (const to of [20, 30, 40]) {
      const l = a.legalActions(actor(a))!;
      expect(l.canRaise).toBe(true);
      expect(l.minRaiseTo).toBe(to);
      a.act(actor(a), { type: 'raise', amount: to });
    }
    const l = a.legalActions(actor(a))!;
    expect(l.canRaise).toBe(false);
    expect(l.canBet).toBe(false);
    // „all-in“ se pak chová jako dorovnání
    a.act(actor(a), { type: 'allIn' });
    expect(a.state().street).toBe('FLOP');
    // na flopu je počítadlo od nuly: bet + tři zvýšení
    for (let i = 0; i < 4; i++) {
      const lg = a.legalActions(actor(a))!;
      expect(lg.canBet || lg.canRaise).toBe(true);
      a.act(actor(a), { type: lg.canBet ? 'bet' : 'raise', amount: lg.minRaiseTo });
    }
    expect(a.legalActions(actor(a))!.canRaise).toBe(false);
  });

  it('fixed-limit: krátký stack nemůže zvyšovat, jen dorovnat zbytek', () => {
    const a = setup('fixedLimit', 4, [1000, 15]);
    const first = actor(a);
    expect(first).toBe('p0');
    a.act(first, { type: 'raise', amount: 20 });
    const l = a.legalActions(actor(a))!;
    expect(actor(a)).toBe('p1');
    expect(l.canRaise).toBe(false);
    expect(l.callAmount).toBe(5);
    a.act('p1', { type: 'call' });
    expect(a.state().players.find((p) => p.playerId === 'p1')!.status).toBe('allIn');
  });

  it('pot-limit: nejvyšší zvýšení je o velikost potu po dorovnání', () => {
    const a = setup('potLimit');
    const l = a.legalActions(actor(a))!;
    // pot 15 (5 + 10), dorovnat 5 → raise-to nejvýš 10 + 15 + 5 = 30
    expect(l.maxRaiseTo).toBe(30);
    expect(l.minRaiseTo).toBe(20);
    expect(() => a.act(actor(a), { type: 'raise', amount: 31 })).toThrow(GameError);
    a.act(actor(a), { type: 'raise', amount: 30 });
    // druhý hráč: pot 40 (30 + 10), dorovnat 20 → raise-to nejvýš 30 + 40 + 20 = 90
    const l2 = a.legalActions(actor(a))!;
    expect(l2.maxRaiseTo).toBe(90);
    // „all-in“ je v pot-limitu omezený potem
    a.act(actor(a), { type: 'allIn' });
    expect(a.state().players.find((p) => p.playerId === 'p0' || p.playerId === 'p1')).toBeTruthy();
    const st = a.state();
    const maxBet = Math.max(...st.players.map((p) => p.invested));
    expect(maxBet).toBe(90);
  });

  it('no-limit zůstává beze změny', () => {
    const a = setup('noLimit');
    const l = a.legalActions(actor(a))!;
    expect(l.maxRaiseTo).toBe(1000);
    expect(l.minRaiseTo).toBe(20);
  });
});
