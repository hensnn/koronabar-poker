// Ochrana „hit and run“ a související limity buy-inu: náhodné posloupnosti usednutí, odchodů a změn nastavení proti jednoduchému modelu.
import { describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { seededRandom } from './bot.js';
import { FakeClock } from './clock.js';
import { TableActor } from './table-actor.js';
import { GameError } from './types.js';

const reg = createDefaultRegistry();
const MIN = 100; // 10 BB při big blindu 10
const USERS = ['a', 'b', 'c'];

function table(over: Record<string, number | boolean | string>) {
  const clock = new FakeClock();
  const ledger = new Ledger();
  const cash = new CashService(ledger);
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'cash.maxBuyInBb': 100, 'time.dealMs': 0, 'time.showCardsMs': 0, ...over } as SettingValues;
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash });
  for (const u of USERS) cash.mint(u, 1_000_000, `m-${u}`);
  return { clock, ledger, settings, actor };
}

describe('hit and run: model a náhodné posloupnosti', () => {
  for (const protection of [true, false]) {
    it(`ochrana ${protection ? 'zapnutá' : 'vypnutá'}: usednutí vždy odpovídá pravidlům a žetony sedí`, () => {
      const t = table({ 'cash.hitAndRunProtection': protection, 'cash.hitAndRunMinutes': 30 });
      const rnd = seededRandom(protection ? 7 : 8);
      const seated = new Map<string, number>();
      const left = new Map<string, { chips: number; at: number }>();
      let attempts = 0;
      let blocked = 0;
      let allowedAboveMax = 0;
      for (let step = 0; step < 600; step++) {
        const u = USERS[Math.floor(rnd() * USERS.length)]!;
        const r = rnd();
        if (r < 0.2) t.clock.advance(Math.floor(rnd() * 25 * 60_000));
        else if (r < 0.28) t.settings['cash.maxBuyInBb'] = 30 + Math.floor(rnd() * 100); // maximum se mění
        else if (seated.has(u)) {
          t.actor.leave(u);
          left.set(u, { chips: seated.get(u)!, at: t.clock.now() });
          seated.delete(u);
        } else {
          // U stolu sedí nejvýš jeden hráč, aby se nehrály handy a stack při odchodu byl přesně ten, se kterým usedl.
          for (const [other, chips] of [...seated]) {
            t.actor.leave(other);
            left.set(other, { chips, at: t.clock.now() });
            seated.delete(other);
          }
          attempts++;
          const max = Number(t.settings['cash.maxBuyInBb']) * 10;
          const last = left.get(u);
          const floor = protection && last && t.clock.now() - last.at < 30 * 60_000 ? last.chips : 0;
          // často zkusit přesně stack, se kterým odešel (i nad maximem), jinak náhodnou částku
          const amount = floor > 0 && rnd() < 0.4 ? floor : MIN + Math.floor(rnd() * (max * 1.5 - MIN));
          const cap = Math.max(max, floor);
          const expected = amount > cap ? 'BUYIN_TOO_LARGE' : floor > 0 && amount < floor ? 'HIT_AND_RUN' : 'ok';
          const seat = USERS.indexOf(u);
          try {
            t.actor.join(u, u, seat, amount);
            expect(expected, `krok ${step}: ${u} usedl s ${amount} (strop ${cap})`).toBe('ok');
            seated.set(u, amount);
            if (amount > max) allowedAboveMax++;
          } catch (e) {
            if (!(e instanceof GameError)) throw e;
            blocked++;
            expect(e.code, `krok ${step}: ${u} s ${amount} (strop ${cap}, dřív ${floor})`).toBe(expected);
          }
          // viewer, který nesedí, vidí správný návratový stack
          if (!seated.has(u)) expect(t.actor.viewFor(u).returnStack).toBe(floor);
        }
        let chips = 0;
        for (const c of seated.values()) chips += c;
        expect(t.actor.totalChips()).toBe(chips);
        expect(t.ledger.balance(accounts.table('t'))).toBe(chips);
      }
      expect(attempts).toBeGreaterThan(50);
      if (protection) {
        expect(blocked).toBeGreaterThan(0);
        expect(allowedAboveMax).toBeGreaterThan(0);
      } else {
        expect(allowedAboveMax).toBe(0);
      }
    });
  }

  it('turnajový stůl a sedící hráč nemají návratový stack', () => {
    const t = table({ 'cash.hitAndRunProtection': true });
    t.actor.join('a', 'a', 0, 500);
    expect(t.actor.viewFor('a').returnStack).toBe(0);
    t.actor.leave('a');
    expect(t.actor.viewFor('a').returnStack).toBe(500);
    expect(t.actor.viewFor(null).returnStack).toBe(0);
  });

  it('po uplynutí doby ochrany už se nevyžaduje stejný stack', () => {
    const t = table({ 'cash.hitAndRunProtection': true, 'cash.hitAndRunMinutes': 10 });
    t.actor.join('a', 'a', 0, 900);
    t.actor.leave('a');
    expect(() => t.actor.join('a', 'a', 0, 200)).toThrowError(expect.objectContaining({ code: 'HIT_AND_RUN' }));
    t.clock.advance(10 * 60_000 + 1);
    expect(t.actor.viewFor('a').returnStack).toBe(0);
    t.actor.join('a', 'a', 0, 200);
    expect(t.actor.totalChips()).toBe(200);
  });
});
