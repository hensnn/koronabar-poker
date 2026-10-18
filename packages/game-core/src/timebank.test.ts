import { describe, expect, it } from 'vitest';
import { CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { FakeClock } from './clock.js';
import { TableActor, type TableEvent } from './table-actor.js';
import { GameError } from './types.js';

const reg = createDefaultRegistry();

function make(over: Record<string, number | boolean | string> = {}) {
  const clock = new FakeClock();
  const cash = new CashService(new Ledger());
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'time.betweenHandsMs': 100, 'time.dealMs': 0, ...over } as SettingValues;
  const events: TableEvent[] = [];
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, onEvent: (e) => events.push(e) });
  for (const u of ['a', 'b', 'c']) cash.mint(u, 10_000, `m-${u}`);
  actor.join('a', 'A', 0, 1000);
  actor.join('b', 'B', 1, 1000);
  clock.advance(100);
  const acting = () => {
    const v = actor.viewFor(null);
    return v.seats.find((s) => s.seat === v.actingSeat)?.playerId;
  };
  const bank = (u: string) => actor.playersSeated().find((s) => s.userId === u)!;
  return { clock, actor, events, acting, bank, settings, cash };
}

describe('time bank: režimy', () => {
  it('časové žetony: každý prodlouží tah o pevný čas a spotřebuje se celý, po posledním následuje fold', () => {
    const m = make({ 'time.bankMode': 'chips', 'time.turnSeconds': 10, 'time.timeChips': 2, 'time.timeChipSeconds': 15 });
    const p = m.acting()!;
    expect(m.actor.viewFor(p).seats.find((s) => s.playerId === p)!.timeBank).toBe(30);
    m.clock.advance(10_001);
    expect(m.actor.viewFor(null).bankActive).toBe(true);
    expect(m.bank(p).timeChips).toBe(1);
    m.clock.advance(15_000);
    expect(m.bank(p).timeChips).toBe(0);
    m.clock.advance(15_000);
    expect(m.events.some((e) => e.type === 'action' && e.auto && e.userId === p)).toBe(true);
  });

  it('chess: jedna zásoba času běží jen na tahu hráče a ubývá o spotřebované sekundy', () => {
    const m = make({ 'time.bankMode': 'chess', 'time.timeBankSeconds': 100 });
    const p = m.acting()!;
    expect(m.actor.viewFor(null).deadline! - m.clock.now()).toBe(100_000);
    m.clock.advance(7_000);
    m.actor.act(p, { type: 'call' });
    expect(m.bank(p).timeBank).toBe(93);
    // soupeř má svoji zásobu nedotčenou
    const other = m.acting()!;
    expect(other).not.toBe(p);
    expect(m.bank(other).timeBank).toBe(100);
  });

  it('chess: když zásoba dojde, hráč automaticky složí a pak má aspoň minimální čas', () => {
    const m = make({ 'time.bankMode': 'chess', 'time.timeBankSeconds': 5, 'time.minTurnSeconds': 3 });
    const p = m.acting()!;
    m.clock.advance(5_001);
    expect(m.events.some((e) => e.type === 'action' && e.auto && e.userId === p)).toBe(true);
    expect(m.bank(p).timeBank).toBe(0);
  });

  it('Fischer: po každém tahu se přičte přírůstek (nejvýš do stropu)', () => {
    const m = make({ 'time.bankMode': 'fischer', 'time.timeBankSeconds': 60, 'time.incrementSeconds': 10, 'time.bankMaxSeconds': 65 });
    const p = m.acting()!;
    m.clock.advance(4_000);
    m.actor.act(p, { type: 'call' });
    expect(m.bank(p).timeBank).toBe(65); // 60 - 4 + 10 = 66, strop 65
    const q = m.acting()!;
    m.clock.advance(30_000);
    m.actor.act(q, { type: 'check' });
    expect(m.bank(q).timeBank).toBe(40); // 60 - 30 + 10
  });

  it('Bronstein: vrátí se nejvýš tolik, kolik hráč spotřeboval, a nejvýš přírůstek', () => {
    const m = make({ 'time.bankMode': 'bronstein', 'time.timeBankSeconds': 60, 'time.incrementSeconds': 10 });
    const p = m.acting()!;
    m.clock.advance(3_000);
    m.actor.act(p, { type: 'call' });
    expect(m.bank(p).timeBank).toBe(60); // spotřebováno 3, vráceno 3
    const q = m.acting()!;
    m.clock.advance(25_000);
    m.actor.act(q, { type: 'check' });
    expect(m.bank(q).timeBank).toBe(45); // 60 - 25 + 10
  });

  it('shot clock (bez rezervy): po vypršení limitu tahu hned fold', () => {
    const m = make({ 'time.bankMode': 'none', 'time.turnSeconds': 8, 'time.timeBankSeconds': 100 });
    const p = m.acting()!;
    expect(m.actor.viewFor(p).seats.find((s) => s.playerId === p)!.timeBank).toBe(0);
    m.clock.advance(8_001);
    expect(m.events.some((e) => e.type === 'action' && e.auto && e.userId === p)).toBe(true);
  });

  it('doplňování rezervy po zadaném počtu hand', () => {
    const m = make({ 'time.bankMode': 'pool', 'time.timeBankSeconds': 10, 'time.bankRefillEveryHands': 2, 'time.bankRefillSeconds': 5, 'time.bankMaxSeconds': 12, 'time.turnSeconds': 3 });
    const first = m.acting()!;
    m.clock.advance(3_001 + 10_001); // dojde základ i rezerva → fold
    expect(m.bank(first).timeBank).toBe(0);
    // druhá handa: doplní se po druhé handě (5 s)
    for (let i = 0; i < 40 && m.actor.viewFor(null).handNumber < 2; i++) m.clock.advance(1_000);
    expect(m.actor.viewFor(null).handNumber).toBeGreaterThanOrEqual(2);
    const total = m.bank('a').timeBank + m.bank('b').timeBank;
    expect(total).toBeGreaterThan(0);
    expect(m.bank('a').timeBank).toBeLessThanOrEqual(12);
  });
});

describe('zavolání času', () => {
  it('zkrátí tah soupeře a zruší jeho rezervu; jde jen jednou za tah a jen když je povoleno', () => {
    const off = make({ 'time.turnSeconds': 30, 'time.timeBankSeconds': 60 });
    const pOff = off.acting()!;
    const otherOff = pOff === 'a' ? 'b' : 'a';
    expect(() => off.actor.callClock(otherOff)).toThrowError(expect.objectContaining({ code: 'CALL_CLOCK_DISABLED' }));

    const m = make({ 'time.turnSeconds': 30, 'time.timeBankSeconds': 60, 'time.callClockEnabled': true, 'time.callClockSeconds': 10 });
    const p = m.acting()!;
    const other = p === 'a' ? 'b' : 'a';
    expect(() => m.actor.callClock(p)).toThrow(GameError);
    m.clock.advance(5_000);
    m.actor.callClock(other);
    expect(m.actor.viewFor(null).clockCalled).toBe(true);
    expect(m.actor.viewFor(null).deadline! - m.clock.now()).toBe(10_000);
    expect(() => m.actor.callClock(other)).toThrowError(expect.objectContaining({ code: 'CLOCK_ALREADY_CALLED' }));
    // po vypršení krátkého času je fold, rezerva se nepoužije
    m.clock.advance(10_001);
    expect(m.events.some((e) => e.type === 'action' && e.auto && e.userId === p)).toBe(true);
    expect(m.bank(p).timeBank).toBe(60);
    expect(m.events.some((e) => e.type === 'clockCalled')).toBe(true);
  });

  it('když zbývá méně času, než je limit po zavolání, nic se neprodlužuje', () => {
    const m = make({ 'time.turnSeconds': 30, 'time.timeBankSeconds': 0, 'time.callClockEnabled': true, 'time.callClockSeconds': 20 });
    const p = m.acting()!;
    const other = p === 'a' ? 'b' : 'a';
    m.clock.advance(25_000);
    m.actor.callClock(other);
    expect(m.actor.viewFor(null).deadline! - m.clock.now()).toBe(5_000);
  });
});
