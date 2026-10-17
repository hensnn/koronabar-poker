import { describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { FakeClock } from './clock.js';
import { TableActor, type TableEvent } from './table-actor.js';

const reg = createDefaultRegistry();

function make(seed: number, players = ['a', 'b']) {
  const clock = new FakeClock();
  const cash = new CashService(new Ledger());
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'time.betweenHandsMs': 100, 'time.showdownMs': 100, 'time.potToWinnerMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'odds.enabled': false } as SettingValues;
  const events: TableEvent[] = [];
  let n = seed;
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff), onEvent: (e) => events.push(e) });
  players.forEach((p, i) => {
    cash.mint(p, 100_000, `m-${p}`);
    actor.join(p, p.toUpperCase(), i, 1000);
  });
  clock.advance(100);
  return { clock, actor, events };
}

const acting = (actor: TableActor) => {
  const v = actor.viewFor(null);
  return v.seats.find((s) => s.seat === v.actingSeat)?.playerId;
};

describe('šance při all-inu', () => {
  it('heads-up all-in uloží šance obou hráčů, které dávají dohromady jedničku', () => {
    for (const seed of [1, 2, 3]) {
      const m = make(seed);
      for (let i = 0; i < 12 && m.actor.currentPhase() === 'hand'; i++) {
        const p = acting(m.actor);
        if (!p) break;
        const legal = m.actor.viewFor(p).legal!;
        m.actor.act(p, legal.callAmount > 0 && legal.callAmount >= legal.maxRaiseTo ? { type: 'call' } : { type: 'allIn' });
      }
      for (let i = 0; i < 400 && m.actor.currentPhase() !== 'pause'; i++) m.clock.advance(25);
      const end = m.events.find((e) => e.type === 'handEnd');
      expect(end).toBeTruthy();
      if (end?.type !== 'handEnd') throw new Error('x');
      const eq = end.record.allInEquity!;
      expect(eq).toBeTruthy();
      expect(eq.a! + eq.b!).toBeCloseTo(1, 2);
      expect(eq.a!).toBeGreaterThan(0);
      expect(eq.a!).toBeLessThan(1);
    }
  });

  it('handa bez all-inu nemá žádné šance', () => {
    const m = make(4);
    const p = acting(m.actor)!;
    m.actor.act(p, { type: 'fold' });
    for (let i = 0; i < 400 && m.actor.currentPhase() !== 'pause'; i++) m.clock.advance(25);
    const end = m.events.find((e) => e.type === 'handEnd');
    if (end?.type !== 'handEnd') throw new Error('x');
    expect(end.record.allInEquity).toBeNull();
    expect(accounts).toBeTruthy();
  });
});
