import { describe, it, expect } from 'vitest';
import { PokertoolsAdapter } from './adapter.js';
import { seededRandom, randomLegalAction } from './bot.js';

const cfg = { smallBlind: 5, bigBlind: 10, ante: 0, maxPlayers: 9, timeBankSeconds: 30 };

function table(stacks: number[], opts: { wait?: boolean[] } = {}) {
  const a = new PokertoolsAdapter(cfg);
  stacks.forEach((s, i) => a.seat(i, `p${i}`, `P${i}`, s, { waitForBb: opts.wait?.[i] }));
  return a;
}
const actingId = (a: PokertoolsAdapter) => a.state().players.find((p) => p.seat === a.state().actingSeat)!.playerId;
const totalStacks = (a: PokertoolsAdapter) => a.state().players.reduce((n, p) => n + p.stack, 0);

describe('straddle (patch enginu)', () => {
  it('UTG straddle: platí ho hráč za big blindem, začíná button a straddler má na konci opci', () => {
    const a = table([1000, 1000, 1000, 1000]);
    a.startHand({ straddle: { type: 'utg', amount: 20 } });
    const s = a.state();
    expect(s.buttonSeat).toBe(0);
    expect(s.straddleSeat).toBe(3);
    expect(s.players.find((p) => p.seat === 3)!.bet).toBe(20);
    expect(s.currentBet).toBe(20);
    expect(s.actingSeat).toBe(0);
    const l = a.legalActions('p0')!;
    expect(l.callAmount).toBe(20);
    expect(l.canCheck).toBe(false);
    expect(l.minRaiseTo).toBe(30);
    a.act('p0', { type: 'call' });
    a.act('p1', { type: 'call' });
    a.act('p2', { type: 'call' });
    expect(a.state().street).toBe('PREFLOP');
    expect(a.state().actingSeat).toBe(3);
    expect(a.legalActions('p3')!.canCheck).toBe(true);
    a.act('p3', { type: 'check' });
    expect(a.state().street).toBe('FLOP');
    expect(a.state().players.reduce((n, p) => n + p.invested, 0)).toBe(80);
  });

  it('Mississippi straddle: platí ho button, začíná small blind', () => {
    const a = table([1000, 1000, 1000, 1000]);
    a.startHand({ straddle: { type: 'mississippi', amount: 30 } });
    const s = a.state();
    expect(s.straddleSeat).toBe(0);
    expect(s.actingSeat).toBe(1);
    expect(s.players.find((p) => p.seat === 0)!.bet).toBe(30);
    expect(a.legalActions('p1')!.callAmount).toBe(25);
  });

  it('dobrovolný straddle: bez souhlasu hráče se neplatí', () => {
    const a = table([1000, 1000, 1000, 1000]);
    a.startHand({ straddle: { type: 'utg', amount: 20, optInPlayerIds: ['p0'] } });
    expect(a.state().straddleSeat).toBeNull();
    expect(a.state().actingSeat).toBe(3);
    const b = table([1000, 1000, 1000, 1000]);
    b.startHand({ straddle: { type: 'utg', amount: 20, optInPlayerIds: ['p3'] } });
    expect(b.state().straddleSeat).toBe(3);
  });

  it('heads-up se straddle nehraje', () => {
    const a = table([1000, 1000]);
    a.startHand({ straddle: { type: 'utg', amount: 20 } });
    expect(a.state().straddleSeat).toBeNull();
  });

  it('zvýšení po straddle: minimální raise-to a součet žetonů', () => {
    const a = table([1000, 1000, 1000, 1000]);
    a.startHand({ straddle: { type: 'utg', amount: 20 } });
    expect(() => a.act('p0', { type: 'raise', amount: 25 })).toThrow();
    a.act('p0', { type: 'raise', amount: 30 });
    expect(a.state().currentBet).toBe(30);
    const inPlay = a.state().players.reduce((n, p) => n + p.stack + p.invested, 0);
    expect(inPlay).toBe(4000);
  });

  it('krátký straddler dá všechno a hra běží dál', () => {
    const a = table([1000, 1000, 1000, 15]);
    a.startHand({ straddle: { type: 'utg', amount: 20 } });
    expect(a.state().players.find((p) => p.seat === 3)!.status).toBe('allIn');
    expect(a.state().players.reduce((n, p) => n + p.stack + p.invested, 0)).toBe(3015);
    expect(a.state().actingSeat).toBe(0);
  });
});

describe('mrtvé peníze (big blind ante, dead blind)', () => {
  it('BB zaplatí ante před rozdáním; složí-li se všichni, dostane ho zpět', () => {
    const a = table([1000, 1000, 1000]);
    a.startHand({ deadMoney: [{ payer: 'bb', amount: 10 }] });
    let s = a.state();
    expect(s.deadMoney).toBe(10);
    const bb = s.players.find((p) => p.dead > 0)!;
    expect(bb.stack + bb.invested + bb.dead).toBe(1000);
    expect(s.pots.reduce((n, p) => n + p.amount, 0)).toBe(10);
    a.act(actingId(a), { type: 'fold' });
    a.act(actingId(a), { type: 'fold' });
    s = a.state();
    expect(s.finished).toBe(true);
    const winner = s.players.find((p) => p.playerId === bb.playerId)!;
    expect(winner.stack).toBe(1000 + 5);
    expect(totalStacks(a)).toBe(3000);
  });

  it('dead money získá vítěz hlavního potu, ne ten, kdo ho zaplatil', () => {
    let different = 0;
    for (let i = 0; i < 40; i++) {
      const a = table([1000, 1000, 1000]);
      a.startHand({ deadMoney: [{ payer: 'bb', amount: 10 }] });
      const bb = a.state().players.find((p) => p.dead > 0)!;
      for (let g = 0; g < 20 && !a.state().finished; g++) a.act(actingId(a), a.legalActions(actingId(a))!.canCheck ? { type: 'check' } : { type: 'call' });
      expect(totalStacks(a)).toBe(3000);
      const s = a.state();
      const total = s.winners!.reduce((n, w) => n + w.amount, 0);
      expect(total).toBeGreaterThanOrEqual(40);
      if (s.winners!.every((w) => s.players.find((p) => p.seat === w.seat)!.playerId !== bb.playerId)) different++;
    }
    expect(different).toBeGreaterThan(5);
  });

  it('dead blind nového hráče a BB ante dohromady, součty žetonů vždy sedí (náhodné handy)', () => {
    const rnd = seededRandom(5);
    for (let hand = 0; hand < 80; hand++) {
      const a = table([300 + Math.floor(rnd() * 500), 400, 200 + Math.floor(rnd() * 800), 600]);
      const before = totalStacks(a);
      a.startHand({ deadMoney: [{ payer: 'bb', amount: 10 }, { payer: { playerId: 'p2' }, amount: 10 }], straddle: { type: 'utg', amount: 20 } });
      expect(a.state().players.reduce((n, p) => n + p.stack + p.invested + p.dead, 0)).toBe(before);
      for (let g = 0; g < 80 && !a.state().finished; g++) {
        const id = actingId(a);
        a.act(id, randomLegalAction(a.legalActions(id)!, rnd));
      }
      expect(totalStacks(a)).toBe(before);
    }
  });

  it('dead money nikdy nevyčerpá celý stack hráče', () => {
    const a = table([1000, 1000, 6]);
    a.startHand({ deadMoney: [{ payer: { playerId: 'p2' }, amount: 50 }] });
    const p2 = a.state().players.find((p) => p.playerId === 'p2')!;
    expect(p2.dead).toBe(5);
    expect(p2.hole).not.toBeNull();
  });
});

describe('čekání na big blind', () => {
  it('nový hráč s waitForBb nedostane karty, dokud se nedostane na big blind', () => {
    const a = table([1000, 1000, 1000, 1000], { wait: [false, false, false, true] });
    let waitedHands = 0;
    let reachedBb: boolean | undefined;
    for (let h = 0; h < 6; h++) {
      a.startHand();
      const p3 = a.state().players.find((p) => p.seat === 3)!;
      if (p3.hole) {
        reachedBb = true;
        expect(a.state().players.find((p) => p.seat === a.state().players.find((x) => x.bet === 10)?.seat)?.seat).toBe(3);
        break;
      }
      waitedHands++;
      while (!a.state().finished) a.act(actingId(a), { type: 'fold' });
    }
    expect(reachedBb).toBe(true);
    expect(waitedHands).toBeGreaterThanOrEqual(1);
  });
});

describe('all-in jako dorovnání (hráč čelí sázce nad svůj stack)', () => {
  it('kdo čelí all-inu přesahujícímu jeho stack, nemůže zvyšovat, ale all-in (= call všeho) projde a nic nevznikne ani nezmizí', () => {
    const a = table([1000, 300, 1000]);
    a.startHand();
    // p0 je UTG (button = seat 0 u tří hráčů): zahraje all-in; krátký stack p1 (small blind) čelí sázce nad svých 300
    const first = actingId(a);
    a.act(first, { type: 'allIn' });
    let guard = 0;
    let reached = false;
    while (guard++ < 5 && !a.state().finished) {
      const id = actingId(a);
      const l = a.legalActions(id)!;
      const stack = a.state().players.find((p) => p.playerId === id)!.stack;
      if (l.callAmount >= stack && !l.canRaise && !l.canBet && l.callAmount > 0) {
        // dorovnání celého stacku = all-in
        reached = true;
        a.act(id, { type: 'allIn' });
        expect(a.state().players.find((p) => p.playerId === id)!.status).toBe('allIn');
        expect(a.state().players.find((p) => p.playerId === id)!.stack).toBe(0);
        break;
      }
      a.act(id, { type: 'fold' });
    }
    expect(reached).toBe(true);
    expect(a.state().players.reduce((n, p) => n + p.stack + p.invested, 0) + a.state().deadMoney).toBe(2300);
  });
});
