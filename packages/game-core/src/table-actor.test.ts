import { describe, it, expect } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { FakeClock } from './clock.js';
import { TableActor, type TableEvent } from './table-actor.js';
import { GameError } from './types.js';

const reg = createDefaultRegistry();

function make(over: Record<string, number | boolean | string> = {}, tableId = 't1') {
  const clock = new FakeClock();
  const ledger = new Ledger();
  const cash = new CashService(ledger);
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, ...over } as SettingValues;
  const events: TableEvent[] = [];
  let changes = 0;
  const actor = new TableActor({ tableId, settings: () => settings, clock, cash, onChange: () => changes++, onEvent: (e) => events.push(e) });
  const fund = (u: string, n = 10_000) => cash.mint(u, n, `m-${u}`);
  const ids = () => [accounts.mint(), accounts.house(), accounts.table(tableId), ...['a', 'b', 'c', 'd'].map(accounts.wallet)];
  return { clock, ledger, cash, settings, actor, events, fund, ids, changes: () => changes };
}

function seatTwo(m: ReturnType<typeof make>, amount = 1000) {
  m.fund('a');
  m.fund('b');
  m.actor.join('a', 'Alice', 0, amount);
  m.actor.join('b', 'Bob', 1, amount);
}
const startHand = (m: ReturnType<typeof make>) => m.clock.advance(Number(m.settings['time.betweenHandsMs']) + 1);
const acting = (m: ReturnType<typeof make>) => {
  const v = m.actor.viewFor(null);
  return v.seats.find((s) => s.seat === v.actingSeat)?.playerId;
};

describe('TableActor: peníze u stolu', () => {
  it('buy-in respektuje min a max a přesouvá měnu na účet stolu', () => {
    const m = make({ 'cash.minBuyInBb': 40, 'cash.maxBuyInBb': 100 });
    m.fund('a');
    expect(() => m.actor.join('a', 'A', 0, 399)).toThrowError(expect.objectContaining({ code: 'BUYIN_TOO_SMALL' }));
    expect(() => m.actor.join('a', 'A', 0, 1001)).toThrowError(expect.objectContaining({ code: 'BUYIN_TOO_LARGE' }));
    m.actor.join('a', 'A', 0, 1000);
    expect(m.ledger.balance(accounts.wallet('a'))).toBe(9000);
    expect(m.ledger.balance(accounts.table('t1'))).toBe(1000);
    expect(m.actor.totalChips()).toBe(1000);
  });

  it('nelze usednout na obsazené nebo neplatné místo, ani dvakrát', () => {
    const m = make();
    m.fund('a');
    m.fund('b');
    m.actor.join('a', 'A', 3, 500);
    expect(() => m.actor.join('b', 'B', 3, 500)).toThrowError(expect.objectContaining({ code: 'SEAT_OCCUPIED' }));
    expect(() => m.actor.join('b', 'B', 99, 500)).toThrowError(expect.objectContaining({ code: 'INVALID_SEAT' }));
    expect(() => m.actor.join('a', 'A', 4, 500)).toThrowError(expect.objectContaining({ code: 'ALREADY_SEATED' }));
  });

  it('nedostatek peněz v peněžence = chyba a nic se nezmění', () => {
    const m = make();
    m.fund('a', 100);
    expect(() => m.actor.join('a', 'A', 0, 500)).toThrow();
    expect(m.ledger.balance(accounts.wallet('a'))).toBe(100);
    expect(m.actor.playersSeated()).toHaveLength(0);
  });

  it('cash-out po odchodu mezi handami vrátí všechno do peněženky', () => {
    const m = make();
    m.fund('a');
    m.actor.join('a', 'A', 0, 500);
    m.actor.leave('a');
    expect(m.ledger.balance(accounts.wallet('a'))).toBe(10_000);
    expect(m.ledger.balance(accounts.table('t1'))).toBe(0);
  });

  it('top-up: nad maximum nejde, jinak se přičte (mezi handami hned)', () => {
    const m = make({ 'cash.maxBuyInBb': 100 });
    m.fund('a');
    m.actor.join('a', 'A', 0, 900);
    expect(() => m.actor.topUp('a', 200)).toThrowError(expect.objectContaining({ code: 'BUYIN_TOO_LARGE' }));
    m.actor.topUp('a', 100);
    expect(m.actor.totalChips()).toBe(1000);
    expect(m.ledger.balance(accounts.table('t1'))).toBe(1000);
  });

  it('hit and run: po odchodu nejde hned usednout s menším stackem', () => {
    const m = make({ 'cash.hitAndRunProtection': true, 'cash.hitAndRunMinutes': 30 });
    m.fund('a');
    m.actor.join('a', 'A', 0, 800);
    m.actor.leave('a');
    expect(() => m.actor.join('a', 'A', 0, 500)).toThrowError(expect.objectContaining({ code: 'HIT_AND_RUN' }));
    m.actor.join('a', 'A', 0, 800);
    m.actor.leave('a');
    m.clock.advance(31 * 60_000);
    m.actor.join('a', 'A', 0, 500);
  });
});

describe('TableActor: průběh handy', () => {
  it('s dvěma hráči se handa sama rozdá po pauze a legální akce vidí jen hráč na tahu', () => {
    const m = make();
    seatTwo(m);
    expect(m.actor.viewFor('a').handNumber).toBe(0);
    startHand(m);
    const va = m.actor.viewFor('a');
    expect(va.handNumber).toBe(1);
    expect(va.street).toBe('PREFLOP');
    const onTurn = acting(m)!;
    const other = onTurn === 'a' ? 'b' : 'a';
    expect(m.actor.viewFor(onTurn).legal).not.toBeNull();
    expect(m.actor.viewFor(other).legal).toBeNull();
    expect(m.actor.viewFor(null).legal).toBeNull();
    expect(va.seats.find((s) => s.playerId === 'a')!.cards).toHaveLength(2);
    expect(va.seats.find((s) => s.playerId === 'b')!.cards).toBeNull();
  });

  it('akce mimo tah a bez handy skončí chybou s kódem', () => {
    const m = make();
    seatTwo(m);
    expect(() => m.actor.act('a', { type: 'fold' })).toThrowError(expect.objectContaining({ code: 'NO_HAND' }));
    startHand(m);
    const other = acting(m) === 'a' ? 'b' : 'a';
    expect(() => m.actor.act(other, { type: 'fold' })).toThrowError(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));
    expect(() => m.actor.act('zzz', { type: 'fold' })).toThrowError(expect.objectContaining({ code: 'NOT_SEATED' }));
  });

  it('fold ukončí handu, výhra se rovnou projeví a po pauze začne další', () => {
    const m = make();
    seatTwo(m);
    startHand(m);
    const first = acting(m)!;
    m.actor.act(first, { type: 'fold' });
    const v = m.actor.viewFor(null);
    expect(v.winners).not.toBeNull();
    expect(m.actor.totalChips()).toBe(2000);
    startHand(m);
    expect(m.actor.viewFor(null).handNumber).toBe(2);
  });

  it('vypršení času: nejdřív time bank, pak automatický fold, po N vypršeních sit out', () => {
    const m = make({ 'time.turnSeconds': 10, 'time.timeBankSeconds': 20, 'time.timeoutsToSitOut': 2 });
    seatTwo(m);
    startHand(m);
    const p = acting(m)!;
    const v0 = m.actor.viewFor(null);
    expect(v0.deadline! - m.clock.now()).toBe(9_999);
    m.clock.advance(10_001);
    expect(m.actor.viewFor(null).bankActive).toBe(true);
    expect(m.actor.viewFor(null).deadline).toBe(v0.deadline! + 20_000);
    m.clock.advance(20_000);
    expect(m.events.some((e) => e.type === 'action' && e.auto && e.userId === p)).toBe(true);
    expect(m.actor.playersSeated().find((s) => s.userId === p)!.timeBank).toBe(0);
    expect(m.actor.playersSeated().find((s) => s.userId === p)!.timeouts).toBe(1);
  });

  it('hráč, který jedná v time banku, přijde jen o spotřebované sekundy', () => {
    const m = make({ 'time.turnSeconds': 10, 'time.timeBankSeconds': 30 });
    seatTwo(m);
    startHand(m);
    const p = acting(m)!;
    m.clock.advance(10_001 + 5_000);
    m.actor.act(p, { type: 'call' });
    const left = m.actor.playersSeated().find((s) => s.userId === p)!.timeBank;
    expect(left).toBeGreaterThanOrEqual(24);
    expect(left).toBeLessThanOrEqual(25);
  });

  it('odpojený hráč na tahu čeká jen po dobu prodlevy pro odpojené', () => {
    const m = make({ 'time.turnSeconds': 30, 'time.disconnectGraceSeconds': 5 });
    seatTwo(m);
    startHand(m);
    const p = acting(m)!;
    m.actor.setConnected(p, false);
    expect(m.actor.viewFor(null).deadline! - m.clock.now()).toBe(5_000);
    m.clock.advance(5_001);
    expect(m.events.some((e) => e.type === 'action' && e.auto)).toBe(true);
  });

  it('odchod uprostřed handy: hráč se složí a cash-out proběhne až po handě', () => {
    const m = make();
    seatTwo(m);
    startHand(m);
    const onTurn = acting(m)!;
    const other = onTurn === 'a' ? 'b' : 'a';
    m.actor.leave(onTurn);
    expect(m.actor.viewFor(null).winners).not.toBeNull();
    startHand(m);
    expect(m.actor.playersSeated().map((s) => s.userId)).toEqual([other]);
    expect(m.ledger.totalIsZero(m.ids())).toBe(true);
    expect(m.ledger.balance(accounts.table('t1'))).toBe(m.actor.totalChips());
    expect(m.ledger.balance(accounts.wallet(onTurn))).toBeGreaterThan(8000);
  });

  it('sit out: hráč se do další handy nezapojí a návrat je ruční', () => {
    const m = make();
    m.fund('c');
    seatTwo(m);
    m.actor.join('c', 'C', 2, 1000);
    m.actor.sitOut('c');
    startHand(m);
    const v = m.actor.viewFor(null);
    expect(v.seats.find((s) => s.playerId === 'c')!.status).toBe('sittingOut');
    expect(v.seats.find((s) => s.playerId === 'c')!.hasCards).toBe(false);
  });

  it('nový hráč usedne uprostřed handy a při dead blindu hraje od další', () => {
    const m = make({ 'table.newPlayerRule': 'postDeadBlind', 'table.deadBlindBb': 1 });
    seatTwo(m);
    startHand(m);
    m.fund('c');
    m.actor.join('c', 'C', 2, 1000);
    expect(m.actor.viewFor('c').seats.find((s) => s.playerId === 'c')!.status).toBe('waiting');
    m.actor.act(acting(m)!, { type: 'fold' });
    startHand(m);
    const v = m.actor.viewFor('c');
    expect(v.seats.find((s) => s.playerId === 'c')!.cards).toHaveLength(2);
    // dead blind 10 šel do potu
    expect(v.totalPot).toBeGreaterThanOrEqual(10 + 15);
    expect(m.actor.totalChips()).toBe(3000);
  });
});

describe('TableActor: dokládání karet po all-inu', () => {
  function allIn() {
    const m = make({ 'time.allInRunoutDelayMs': 1000, 'time.allInRiverDramaMs': 3000, 'time.showdownMs': 2000, 'time.potToWinnerMs': 500, 'odds.enabled': true });
    seatTwo(m, 500);
    startHand(m);
    m.actor.act(acting(m)!, { type: 'allIn' });
    m.actor.act(acting(m)!, { type: 'call' });
    return m;
  }

  it('karty se otočí, board se odhaluje po ulicích a výherce až na konci', () => {
    const m = allIn();
    let v = m.actor.viewFor('a');
    expect(v.board).toEqual([]);
    expect(v.winners).toBeNull();
    expect(v.seats.find((s) => s.playerId === 'b')!.cards).toHaveLength(2);
    expect(v.odds).not.toBeNull();
    expect(v.totalPot).toBe(1000);
    m.clock.advance(1000);
    expect(m.actor.viewFor('a').board).toHaveLength(3);
    m.clock.advance(1000);
    expect(m.actor.viewFor('a').board).toHaveLength(4);
    m.clock.advance(2999);
    expect(m.actor.viewFor('a').board).toHaveLength(4);
    m.clock.advance(1);
    v = m.actor.viewFor('a');
    expect(v.board).toHaveLength(5);
    expect(v.winners).toBeNull();
    m.clock.advance(2000);
    expect(m.actor.viewFor('a').winners).not.toBeNull();
    expect(m.actor.viewFor('a').odds).toBeNull();
  });

  it('šance se přepočítají po každé ulici a součet je 100 %', () => {
    const m = allIn();
    const sumOf = () => {
      const o = m.actor.viewFor('a').odds![0]!;
      return o.entries.reduce((n, e) => n + e.win, 0) + o.entries[0]!.tie;
    };
    const pre = m.actor.viewFor('a').odds![0]!.entries.map((e) => e.win);
    expect(sumOf()).toBeCloseTo(1, 9);
    m.clock.advance(1000);
    expect(sumOf()).toBeCloseTo(1, 9);
    m.clock.advance(1000);
    m.clock.advance(3000);
    const river = m.actor.viewFor('a').odds![0]!.entries.map((e) => e.win);
    expect(river.every((w) => w === 0 || w === 1) || river.reduce((a, b) => a + b, 0) <= 1).toBe(true);
    expect(pre).not.toEqual(river);
  });

  it('šance vypnuté nastavením se neposílají; přihlížející je dostanou jen když to nastavení dovolí', () => {
    const m = allIn();
    expect(m.actor.viewFor(null).odds).toBeNull();
    m.settings['odds.forSpectators'] = true;
    expect(m.actor.viewFor(null).odds).not.toBeNull();
    m.settings['odds.enabled'] = false;
    expect(m.actor.viewFor('a').odds).toBeNull();
  });

  it('přihlížející nikdy nevidí karty před odhalením', () => {
    const m = make();
    seatTwo(m);
    startHand(m);
    const json = JSON.stringify(m.actor.viewFor(null));
    expect(json).not.toMatch(/"cards":\["/);
  });
});

describe('TableActor: odolnost', () => {
  it('chyba na jednom stole nezastaví druhý', () => {
    const a = make({}, 't1');
    const b = make({}, 't2');
    seatTwo(a);
    seatTwo(b);
    startHand(a);
    startHand(b);
    (a.actor as any).adapter.act = () => {
      throw new Error('boom');
    };
    expect(() => a.actor.act(acting(a)!, { type: 'fold' })).toThrow('boom');
    expect(a.actor.currentPhase()).toBe('stopped');
    b.actor.act(acting(b)!, { type: 'fold' });
    expect(b.actor.viewFor(null).winners).not.toBeNull();
    expect(() => a.actor.act('a', { type: 'fold' })).toThrowError(GameError);
  });

  it('zrušení stolu uprostřed handy vrátí všem stav z předělu a nic nezmizí', () => {
    const m = make();
    seatTwo(m);
    startHand(m);
    m.actor.act(acting(m)!, { type: 'raise', amount: 200 });
    m.actor.close();
    expect(m.ledger.balance(accounts.table('t1'))).toBe(0);
    expect(m.ledger.balance(accounts.wallet('a'))).toBe(10_000);
    expect(m.ledger.balance(accounts.wallet('b'))).toBe(10_000);
  });

  it('obnova z uloženého stavu: hráči a žetony zůstanou, rozehraná handa se vrací', () => {
    const m = make();
    seatTwo(m);
    startHand(m);
    m.actor.act(acting(m)!, { type: 'raise', amount: 200 });
    const saved = JSON.parse(JSON.stringify(m.actor.persisted()));
    const clock2 = new FakeClock();
    const actor2 = new TableActor({ tableId: 't1', settings: () => m.settings, clock: clock2, cash: m.cash, restore: saved });
    expect(actor2.playersSeated().map((s) => s.chips).sort()).toEqual([1000, 1000]);
    clock2.advance(Number(m.settings['time.betweenHandsMs']) + 1);
    // microtask pro naplánování další handy
    return Promise.resolve().then(() => {
      clock2.advance(Number(m.settings['time.betweenHandsMs']) + 1);
      expect(actor2.viewFor(null).handNumber).toBe(1);
      expect(actor2.totalChips()).toBe(2000);
    });
  });
});
