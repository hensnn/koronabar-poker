import { describe, it, expect } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { FakeClock } from './clock.js';
import { seededRandom } from './bot.js';
import { TableActor, type TableEvent } from './table-actor.js';

const reg = createDefaultRegistry();

describe('nejlepší kombinace hráče a výsledek handy pro chat', () => {
  it('myBest se ukáže jen hráči a jen od flopu; handEnd nese popis kombinace s parametry', () => {
    const clock = new FakeClock();
    const ledger = new Ledger();
    const cash = new CashService(ledger);
    const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'odds.enabled': false, 'time.betweenHandsMs': 100, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50 } as SettingValues;
    const events: TableEvent[] = [];
    const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: seededRandom(7), onEvent: (e) => events.push(e) });
    for (const u of ['a', 'b']) {
      cash.mint(u, 10_000, `m-${u}`);
      actor.join(u, u.toUpperCase(), u === 'a' ? 0 : 1, 1000);
    }
    clock.advance(101);
    let sawFlopBest = false;
    for (let i = 0; i < 60 && actor.currentPhase() === 'hand'; i++) {
      const v = actor.viewFor(null);
      expect(v.myBest ?? null).toBeNull(); // divák nikdy nemá „moji“ kombinaci
      if (v.board.length < 3) for (const u of ['a', 'b']) expect(actor.viewFor(u).myBest ?? null).toBeNull();
      else {
        for (const u of ['a', 'b']) expect(actor.viewFor(u).myBest?.key).toMatch(/^hand\./);
        sawFlopBest = true;
      }
      const p = v.seats.find((s) => s.seat === v.actingSeat)!.playerId;
      const legal = actor.viewFor(p).legal!;
      actor.act(p, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' });
    }
    expect(sawFlopBest).toBe(true);
    clock.advance(2000);
    const end = events.find((e) => e.type === 'handEnd');
    expect(end).toBeTruthy();
    if (end?.type === 'handEnd' && end.showdown) for (const p of end.record.players.filter((x) => x.revealed)) expect(p.handDesc?.key).toMatch(/^hand\./);
    expect(ledger.totalIsZero([accounts.mint(), accounts.house(), accounts.table('t'), accounts.wallet('a'), accounts.wallet('b')])).toBe(true);
  });
});
