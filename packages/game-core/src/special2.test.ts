import { describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { FakeClock } from './clock.js';
import { TableActor, type TableEvent } from './table-actor.js';
import type { Card } from './types.js';

const reg = createDefaultRegistry();

function make(over: Record<string, number | boolean | string> = {}, players = ['a', 'b'], stack = 1000, seed = 1) {
  const clock = new FakeClock();
  const ledger = new Ledger();
  const cash = new CashService(ledger);
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'cash.maxBuyInBb': 500, 'time.betweenHandsMs': 100, 'time.showdownMs': 100, 'time.potToWinnerMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'odds.enabled': false, ...over } as SettingValues;
  const events: TableEvent[] = [];
  let n = seed;
  const rnd = () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: rnd, onEvent: (e) => events.push(e) });
  players.forEach((p, i) => {
    cash.mint(p, 100_000, `m-${p}`);
    actor.join(p, p.toUpperCase(), i, stack);
  });
  clock.advance(100);
  const acting = () => {
    const v = actor.viewFor(null);
    return v.seats.find((s) => s.seat === v.actingSeat)?.playerId;
  };
  const untilPause = () => {
    for (let i = 0; i < 400 && actor.currentPhase() !== 'pause'; i++) clock.advance(25);
  };
  return { clock, ledger, actor, events, settings, acting, untilPause };
}

type M = ReturnType<typeof make>;
const foldOut = (m: M) => {
  const p = m.acting()!;
  m.actor.act(p, { type: 'fold' });
  return p;
};

describe('ukázání karet a rabbit hunt', () => {
  it('po foldu smí hráč ukázat obě nebo jednu kartu; ostatní je pak vidí, před tím ne', () => {
    const m = make({ 'special.showCards': true });
    const folder = foldOut(m);
    const other = folder === 'a' ? 'b' : 'a';
    const seatOf = (id: string) => m.actor.viewFor(null).seats.find((s) => s.playerId === id)!.seat;
    expect(m.actor.viewFor(other).seats.find((s) => s.playerId === folder)!.exposed).toBeUndefined();
    m.actor.showCards(folder, 0);
    let seat = m.actor.viewFor(other).seats.find((s) => s.seat === seatOf(folder))!;
    expect(seat.exposed![0]).not.toBeNull();
    expect(seat.exposed![1]).toBeNull();
    m.actor.showCards(folder, 'both');
    seat = m.actor.viewFor(null).seats.find((s) => s.seat === seatOf(folder))!;
    expect(seat.exposed!.every((c) => c !== null)).toBe(true);
    expect(() => m.actor.showCards('zzz', 'both')).toThrow();
    m.clock.advance(4000);
    expect(m.actor.viewFor(null).seats.every((s) => s.exposed === undefined)).toBe(true);
  });

  it('vypnuté ukázání karet se nepovolí', () => {
    const off = make({ 'special.showCards': false });
    const f = foldOut(off);
    expect(() => off.actor.showCards(f, 'both')).toThrowError(expect.objectContaining({ code: 'NOT_ALLOWED' }));
  });

  it('po showdownu se karty ukazovat nemusí (a nejde to)', () => {
    const m = make({ 'special.showCards': true });
    for (let i = 0; i < 12 && m.actor.currentPhase() === 'hand'; i++) {
      const p = m.acting();
      if (!p) break;
      const legal = m.actor.viewFor(p).legal!;
      m.actor.act(p, legal.callAmount > 0 && legal.callAmount >= legal.maxRaiseTo ? { type: 'call' } : { type: 'allIn' });
    }
    m.untilPause();
    expect(() => m.actor.showCards('a', 'both')).toThrowError(expect.objectContaining({ code: 'NOT_ALLOWED' }));
  });

  it('rabbit hunt ukáže chybějící karty boardu z balíčku, jen jednou a jen když je zapnutý', () => {
    const m = make({ 'special.rabbitHunt': true });
    const f = foldOut(m);
    expect(m.actor.viewFor(null).rabbit).toBeNull();
    m.actor.rabbitHunt(f);
    const cards = m.actor.viewFor('a').rabbit!;
    expect(cards).toHaveLength(5);
    expect(new Set(cards).size).toBe(5);
    expect(m.actor.viewFor('b').rabbit).toEqual(cards);
    expect(() => m.actor.rabbitHunt(f)).toThrowError(expect.objectContaining({ code: 'NOT_ALLOWED' }));
    m.clock.advance(4000);
    expect(m.actor.viewFor(null).rabbit).toBeNull();
    const off = make({ 'special.rabbitHunt': false });
    const f2 = foldOut(off);
    expect(() => off.actor.rabbitHunt(f2)).toThrow();
  });
});

describe('7-2 bonus a bomb pot', () => {
  it('7-2 bonus: vítěz se sedmou a dvojkou různých barev dostane od ostatních bonus, součty sedí', async () => {
    const { PokertoolsAdapter } = await import('./adapter.js');
    const clock = new FakeClock();
    const ledger = new Ledger();
    const cash = new CashService(ledger);
    const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'cash.maxBuyInBb': 500, 'time.betweenHandsMs': 100, 'time.showdownMs': 100, 'time.potToWinnerMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'odds.enabled': false, 'special.sevenTwoBonus': true, 'special.sevenTwoAmountBb': 3 } as SettingValues;
    const events: TableEvent[] = [];
    const factory = (cfg: ConstructorParameters<typeof PokertoolsAdapter>[0]) => {
      const real = new PokertoolsAdapter(cfg);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'state') {
            return () => {
              const st = target.state();
              if (!st.finished || !st.winners || st.players.length !== 3) return st;
              const total = st.winners.reduce((n, w) => n + w.amount, 0);
              const w = st.players.find((p) => p.playerId === 'a')!;
              return {
                ...st,
                board: ['Kc', '9d', '4h', 'Js', '3c'] as Card[],
                players: st.players.map((p) => ({ ...p, status: 'active' as const, hole: (p.playerId === 'a' ? ['7s', '2d'] : p.playerId === 'b' ? ['Ac', 'Kd'] : ['Qc', 'Qd']) as [Card, Card] })),
                winners: [{ seat: w.seat, amount: total, handName: null, cards: null }],
              };
            };
          }
          const v = (target as never)[prop];
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    };
    const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, adapterFactory: factory, onEvent: (e) => events.push(e) });
    for (const [i, u] of ['a', 'b', 'c'].entries()) {
      cash.mint(u, 10_000, `m-${u}`);
      actor.join(u, u, i, 500);
    }
    clock.advance(100);
    for (let i = 0; i < 20 && actor.currentPhase() === 'hand'; i++) {
      const v = actor.viewFor(null);
      const p = v.seats.find((s) => s.seat === v.actingSeat)!.playerId;
      const legal = actor.viewFor(p).legal!;
      actor.act(p, legal.canCheck ? { type: 'check' } : { type: 'call' });
    }
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'bonus'); i++) clock.advance(50);
    const bonus = events.find((e) => e.type === 'bonus');
    expect(bonus).toMatchObject({ kind: 'sevenTwo', userId: 'a', amount: 60 });
    expect(actor.totalChips()).toBe(1500);
    expect(ledger.balance(accounts.table('t'))).toBe(1500);
  });

  it('bomb pot: každou N-tou handu všichni dají ante a hraje se od flopu', () => {
    const m = make({ 'special.bombPot': true, 'special.bombPotEveryHands': 2, 'special.bombPotAnteBb': 2 }, ['a', 'b', 'c']);
    const first = m.actor.viewFor(null);
    expect(first.bombPot).toBe(false);
    expect(first.board).toHaveLength(0);
    for (let i = 0; i < 12 && m.actor.currentPhase() === 'hand'; i++) {
      const p = m.acting();
      if (!p) break;
      m.actor.act(p, { type: 'fold' });
    }
    for (let i = 0; i < 60 && m.actor.viewFor(null).handNumber < 2; i++) m.clock.advance(100);
    const v = m.actor.viewFor(null);
    expect(v.handNumber).toBe(2);
    expect(v.bombPot).toBe(true);
    expect(v.street).toBe('FLOP');
    expect(v.board).toHaveLength(3);
    expect(v.totalPot).toBeGreaterThanOrEqual(60);
    expect(m.events.some((e) => e.type === 'bombPot')).toBe(true);
    expect(m.actor.totalChips()).toBe(3000);
    expect(m.ledger.balance(accounts.table('t'))).toBe(3000);
    for (let i = 0; i < 200 && m.actor.viewFor(null).handNumber < 3; i++) {
      const p = m.acting();
      if (m.actor.currentPhase() === 'hand' && p) m.actor.act(p, { type: 'fold' });
      m.clock.advance(100);
    }
    expect(m.actor.viewFor(null).bombPot).toBe(false);
  });

  it('bomb pot se nespustí, když někdo nemá dost žetonů na ante', () => {
    const m = make({ 'special.bombPot': true, 'special.bombPotEveryHands': 1, 'special.bombPotAnteBb': 40 }, ['a', 'b'], 300);
    expect(m.actor.viewFor(null).bombPot).toBe(false);
    expect(m.actor.viewFor(null).board).toHaveLength(0);
  });
});
