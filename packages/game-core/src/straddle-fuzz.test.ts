// Fuzz straddle: UTG i Mississippi, povinný i dobrovolný, 2 až 7 hráčů, i krátké stacky; nic nesmí vzniknout ani zmizet.
import { describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { randomLegalAction, seededRandom } from './bot.js';
import { FakeClock } from './clock.js';
import { TableActor } from './table-actor.js';
import { GameError } from './types.js';

const reg = createDefaultRegistry();
const USERS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'];

function run(seed: number, players: number, over: Record<string, number | boolean | string>) {
  const clock = new FakeClock();
  const ledger = new Ledger();
  const cash = new CashService(ledger);
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'cash.maxBuyInBb': 200, 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.showCardsMs': 0, 'time.dealMs': 0, 'odds.enabled': false, 'table.straddleEnabled': true, ...over } as SettingValues;
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: seededRandom(seed) });
  const rnd = seededRandom(seed * 7 + 1);
  const ids = USERS.slice(0, players);
  for (const u of ids) cash.mint(u, 100_000, `m-${u}`);
  ids.forEach((u, i) => actor.join(u, u, i, rnd() < 0.3 ? 100 : 100 + Math.floor(rnd() * 600)));
  let straddles = 0;
  for (let step = 0; step < 400; step++) {
    const v = actor.viewFor(null);
    if (v.straddleSeat !== null && step % 1 === 0) straddles++;
    if (!settings['table.straddleMandatory']) for (const u of ids) if (rnd() < 0.4) try { actor.setStraddle(u, rnd() < 0.7); } catch (e) { if (!(e instanceof GameError)) throw e; }
    if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
      const p = v.seats.find((s) => s.seat === v.actingSeat)!;
      const legal = actor.viewFor(p.playerId).legal;
      if (legal) actor.act(p.playerId, randomLegalAction(legal, rnd));
    }
    for (const s of v.seats) if (s.stack === 0) try { actor.topUp(s.playerId, 200); actor.sitIn(s.playerId); } catch (e) { if (!(e instanceof GameError)) throw e; }
    clock.advance(Math.floor(rnd() * 400));
    expect(actor.hasError(), `seed ${seed} krok ${step}`).toBeNull();
    const all = [accounts.mint(), accounts.house(), ...ids.map(accounts.wallet), accounts.table('t')];
    expect(ledger.totalIsZero(all)).toBe(true);
    expect(ledger.balance(accounts.table('t'))).toBe(actor.totalChips());
  }
  return straddles;
}

describe('straddle: fuzz', () => {
  for (const type of ['utg', 'mississippi']) {
    for (const mandatory of [true, false]) {
      it(`${type}, ${mandatory ? 'povinný' : 'dobrovolný'}, 2 až 7 hráčů`, () => {
        let seen = 0;
        for (let seed = 1; seed <= 6; seed++) for (const n of [2, 3, 4, 6, 7]) seen += run(seed * 100 + n, n, { 'table.straddleType': type, 'table.straddleMandatory': mandatory, 'table.straddleMultiplier': 2 + (seed % 3) });
        expect(seen).toBeGreaterThan(0);
      });
    }
  }
});
