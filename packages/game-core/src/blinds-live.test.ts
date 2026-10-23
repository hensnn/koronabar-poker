// Blindy a button: výchozí „živý“ button přeskakuje prázdná a odsedlá místa, kasinové „mrtvé“ pravidlo je volitelné.
import { describe, expect, it } from 'vitest';
import { CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { FakeClock } from './clock.js';
import { TableActor } from './table-actor.js';

const reg = createDefaultRegistry();

function hands(over: Record<string, unknown>, sitOutSeat?: number) {
  const clock = new FakeClock();
  const cash = new CashService(new Ledger());
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'time.betweenHandsMs': 100, 'time.showdownMs': 100, 'time.potToWinnerMs': 100, 'time.dealMs': 0, 'odds.enabled': false, ...over } as SettingValues;
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: () => 0.37 });
  const seats: Record<string, number> = { a: 0, b: 2, c: 5, d: 7 };
  for (const [u, n] of Object.entries(seats)) {
    cash.mint(u, 100_000, 'm' + u);
    actor.join(u, u, n, 1000);
  }
  if (sitOutSeat !== undefined) actor.sitOut(Object.entries(seats).find(([, n]) => n === sitOutSeat)![0]);
  const out: { button: number; bets: Record<number, number> }[] = [];
  let last = 0;
  for (let step = 0; step < 4000 && out.length < 8; step++) {
    const v = actor.viewFor(null);
    if (v.handId && v.handNumber !== last) {
      last = v.handNumber;
      out.push({ button: v.buttonSeat!, bets: Object.fromEntries(v.seats.filter((s) => s.bet > 0).map((s) => [s.seat, s.bet])) });
    }
    if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
      const p = v.seats.find((s) => s.seat === v.actingSeat)!;
      const l = actor.viewFor(p.playerId).legal;
      if (l) actor.act(p.playerId, l.canCheck ? { type: 'check' } : { type: 'fold' });
    }
    clock.advance(200);
  }
  return out;
}

describe('blindy a button s prázdnými místy', () => {
  it('živý button (výchozí): button je vždy na hráči a malý i velký blind platí dva různí hráči', () => {
    const occupied = [0, 2, 5, 7];
    const hs = hands({});
    expect(hs.length).toBe(8);
    for (const h of hs) {
      expect(occupied).toContain(h.button);
      const posted = Object.keys(h.bets).map(Number);
      expect(posted.every((s) => occupied.includes(s))).toBe(true);
      expect(posted.length).toBeGreaterThanOrEqual(2); // SB i BB (po foldu BB může zůstat jen sázka, ale nikdy prázdné místo)
    }
    // button obíhá hráče po řadě
    expect(hs.slice(0, 5).map((h) => h.button)).toEqual([0, 2, 5, 7, 0]);
  });

  it('živý button přeskočí hráče v sit outu', () => {
    const hs = hands({}, 5);
    expect(hs.every((h) => h.button !== 5 && !(5 in h.bets))).toBe(true);
  });

  it('mrtvý button (volba): button se posouvá po sedadlech i přes prázdná', () => {
    const hs = hands({ 'table.deadButton': true });
    expect(hs.slice(0, 4).map((h) => h.button)).toEqual([0, 1, 2, 3]);
  });
});
