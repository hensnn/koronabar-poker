// Opravy z auditu 2. 11. 2026: odchod v okně mezi koncem handy a zaúčtováním rake, zkracování času při odpojení, stará akce.
import { describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { FakeClock } from './clock.js';
import { TableActor, type TableEvent } from './table-actor.js';

const reg = createDefaultRegistry();

function make(over: Record<string, number | boolean | string> = {}, players = ['a', 'b', 'c']) {
  const clock = new FakeClock();
  const ledger = new Ledger();
  const cash = new CashService(ledger);
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'time.dealMs': 0, 'time.showCardsMs': 0, 'time.betweenHandsMs': 600_000, ...over } as SettingValues;
  const events: TableEvent[] = [];
  const actor = new TableActor({ tableId: 't1', settings: () => settings, clock, cash, onEvent: (e) => events.push(e) });
  players.forEach((u, i) => {
    cash.mint(u, 10_000, `m-${u}`);
    actor.join(u, u.toUpperCase(), i, 1000);
  });
  const acting = () => {
    const v = actor.viewFor(null);
    return v.seats.find((s) => s.seat === v.actingSeat)?.playerId ?? null;
  };
  return { clock, ledger, settings, actor, events, acting };
}

/** Dohraje handu na showdown: všichni jen dorovnávají a checkují. Vrátí vítěze. */
function playToShowdown(m: ReturnType<typeof make>): string {
  m.clock.advance(Number(m.settings['time.betweenHandsMs']) + 1);
  for (let guard = 0; guard < 40; guard++) {
    const p = m.acting();
    if (!p) break;
    const legal = m.actor.viewFor(p).legal;
    if (!legal) break;
    m.actor.act(p, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
  const v = m.actor.viewFor(null);
  expect(v.street).toBe('SHOWDOWN');
  const seat = (v.winners?.[0] as { seat: number } | undefined)?.seat;
  const winner = v.seats.find((s) => s.seat === seat)?.playerId;
  expect(winner).toBeTruthy();
  return winner!;
}

describe('odchod hned po konci handy', () => {
  it('vítěz, který odejde během animace showdownu, zaplatí rake a odejde až na předělu', () => {
    const m = make({ 'rake.enabled': true, 'rake.percent': 10, 'rake.cap': 1000, 'rake.noFlopNoDrop': false });
    const winner = playToShowdown(m);
    const before = m.ledger.balance(accounts.wallet(winner));
    // hned po konci handy (fáze „pauza“, rake ještě není zaúčtovaný)
    m.actor.leave(winner);
    expect(m.actor.playersSeated().find((s) => s.userId === winner)?.mode).toBe('leaving');
    expect(m.events.some((e) => e.type === 'rake')).toBe(false);
    // po animaci se zaúčtuje rake, odchod proběhne na předělu před další handou
    m.clock.advance(Number(m.settings['time.showdownMs']) + Number(m.settings['time.potToWinnerMs']) + Number(m.settings['time.betweenHandsMs']) + 10);
    expect(m.events.some((e) => e.type === 'rake')).toBe(true);
    expect(m.actor.playersSeated().some((s) => s.userId === winner)).toBe(false);
    const house = m.ledger.balance(accounts.house());
    expect(house).toBeGreaterThan(0);
    // pot 30 (3 × 10), rake 10 % = 3; vítěz vložil 10 → čistý zisk 20 − 3
    expect(m.ledger.balance(accounts.wallet(winner)) - before).toBe(1000 + 20 - house);
    expect(m.ledger.balance(accounts.table('t1'))).toBe(m.actor.totalChips());
    expect(m.ledger.totalIsZero([accounts.mint(), accounts.house(), accounts.table('t1'), ...['a', 'b', 'c'].map(accounts.wallet)])).toBe(true);
  });

  it('po zaúčtování se odchází hned', () => {
    const m = make({ 'rake.enabled': true, 'rake.percent': 10, 'rake.cap': 1000, 'rake.noFlopNoDrop': false });
    const winner = playToShowdown(m);
    m.clock.advance(Number(m.settings['time.showdownMs']) + Number(m.settings['time.potToWinnerMs']) + 1);
    expect(m.events.some((e) => e.type === 'rake')).toBe(true);
    m.actor.leave(winner);
    expect(m.actor.playersSeated().some((s) => s.userId === winner)).toBe(false);
    expect(m.ledger.balance(accounts.table('t1'))).toBe(m.actor.totalChips());
  });
});

describe('odpojení hráče na tahu', () => {
  const start = (m: ReturnType<typeof make>) => {
    m.clock.advance(Number(m.settings['time.betweenHandsMs'])); // časovač vyprší přesně, hodiny zůstanou na jeho čase
    return m.acting()!;
  };
  const bank = (m: ReturnType<typeof make>, u: string) => m.actor.playersSeated().find((s) => s.userId === u)!.timeBank;

  it('odpojení během rezervy ji neobnoví: spotřebovaný čas se odečte a tah vyprší po toleranci', () => {
    const m = make({ 'time.turnSeconds': 30, 'time.timeBankSeconds': 60, 'time.disconnectGraceSeconds': 10, 'time.timeoutsToSitOut': 99 }, ['a', 'b']);
    const p = start(m);
    m.clock.advance(30_000); // základ vypršel, běží rezerva 60 s
    expect(m.actor.viewFor(null).bankActive).toBe(true);
    m.clock.advance(40_000); // spotřebováno 40 s rezervy
    m.actor.setConnected(p, false);
    const v = m.actor.viewFor(null);
    expect(v.deadline! - m.clock.now()).toBe(10_000);
    m.clock.advance(10_000);
    expect(m.events.some((e) => e.type === 'action' && e.auto && e.userId === p)).toBe(true);
    expect(bank(m, p)).toBe(60 - 50);
  });

  it('odpojení zbývající čas nikdy neprodlouží', () => {
    const m = make({ 'time.turnSeconds': 30, 'time.timeBankSeconds': 0, 'time.disconnectGraceSeconds': 20 }, ['a', 'b']);
    const p = start(m);
    m.clock.advance(25_000); // zbývá 5 s
    const deadline = m.actor.viewFor(null).deadline;
    m.actor.setConnected(p, false);
    expect(m.actor.viewFor(null).deadline).toBe(deadline);
  });

  it('po návratu před vypršením dostane hráč jen zbytek rezervy', () => {
    const m = make({ 'time.turnSeconds': 30, 'time.timeBankSeconds': 60, 'time.disconnectGraceSeconds': 10, 'time.timeoutsToSitOut': 99 }, ['a', 'b']);
    const p = start(m);
    m.clock.advance(30_000);
    m.clock.advance(40_000);
    m.actor.setConnected(p, false);
    m.clock.advance(5_000);
    m.actor.setConnected(p, true);
    m.clock.advance(5_000); // tolerance vypršela, hráč je připojený → běží zbytek rezervy (60 − 50 = 10 s; čas běžel i během odpojení)
    expect(m.events.some((e) => e.type === 'action' && e.auto && e.userId === p)).toBe(false);
    expect(m.actor.viewFor(null).bankActive).toBe(true);
    expect(bank(m, p)).toBe(10);
    m.clock.advance(10_001);
    expect(m.events.some((e) => e.type === 'action' && e.auto && e.userId === p)).toBe(true);
  });

  it('zavolaný čas odpojení nezruší', () => {
    const m = make({ 'time.turnSeconds': 60, 'time.timeBankSeconds': 60, 'time.disconnectGraceSeconds': 30, 'time.callClockEnabled': true, 'time.callClockSeconds': 10, 'time.timeoutsToSitOut': 99 }, ['a', 'b']);
    const p = start(m);
    const other = p === 'a' ? 'b' : 'a';
    m.clock.advance(5_000);
    m.actor.callClock(other);
    m.actor.setConnected(p, false);
    expect(m.actor.viewFor(null).clockCalled).toBe(true);
    m.clock.advance(10_001);
    expect(m.events.some((e) => e.type === 'action' && e.auto && e.userId === p)).toBe(true);
  });
});

describe('stará akce', () => {
  it('akce s handId jiné handy je odmítnuta, se správným projde', () => {
    const m = make({}, ['a', 'b']);
    m.clock.advance(Number(m.settings['time.betweenHandsMs']) + 1);
    const p = m.acting()!;
    const handId = m.actor.viewFor(null).handId!;
    expect(() => m.actor.act(p, { type: 'call' }, 'hand-stara')).toThrowError(expect.objectContaining({ code: 'STALE_ACTION' }));
    expect(m.acting()).toBe(p);
    m.actor.act(p, { type: 'call' }, handId);
    expect(m.acting()).not.toBe(p);
  });
});
