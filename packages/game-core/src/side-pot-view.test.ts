// Oznámení o výhře se skládá z hlavního a vedlejšího potu: součet výher jednoho hráče se sloučí, výherci různých potů zůstanou zvlášť.
import { describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { FakeClock } from './clock.js';
import { TableActor } from './table-actor.js';

const reg = createDefaultRegistry();

function play(seed: number) {
  const clock = new FakeClock();
  const ledger = new Ledger();
  const cash = new CashService(ledger);
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'time.betweenHandsMs': 100, 'time.showdownMs': 100, 'time.potToWinnerMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.dealMs': 0, 'odds.enabled': false } as SettingValues;
  let n = seed;
  const rnd = () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: rnd });
  const stacks: Record<string, number> = { a: 200, b: 1000, c: 1000 };
  [...Object.entries(stacks)].forEach(([p, stack], i) => {
    cash.mint(p, 100_000, `m-${p}`);
    actor.join(p, p.toUpperCase(), i, stack);
  });
  clock.advance(100);
  for (let i = 0; i < 20 && actor.currentPhase() === 'hand'; i++) {
    const v = actor.viewFor(null);
    const p = v.seats.find((s) => s.seat === v.actingSeat)?.playerId;
    if (!p) break;
    actor.act(p, { type: 'allIn' });
  }
  for (let i = 0; i < 400 && actor.currentPhase() !== 'pause'; i++) clock.advance(25);
  return { view: actor.viewFor('a'), actor, ledger };
}

describe('výhry z hlavního a vedlejšího potu', { timeout: 60_000 }, () => {
  it('součet výher sedí s potem, výherce je v oznámení jednou; různí výherci hlavního a vedlejšího potu zůstanou zvlášť', () => {
    let sawSplit = false;
    let sawSingle = false;
    for (let seed = 1; seed <= 30; seed++) {
      const { view, actor, ledger } = play(seed);
      const winners = view.winners!;
      expect(winners).not.toBeNull();
      expect(new Set(winners.map((w) => w.seat)).size).toBe(winners.length);
      const total = winners.reduce((s, w) => s + w.amount, 0);
      expect(total).toBe(2200); // 200 + 1000 + 1000: nic nevzniklo ani nezmizelo
      expect(actor.totalChips()).toBe(2200);
      expect(ledger.balance(accounts.table('t'))).toBe(2200);
      if (winners.length === 1) sawSingle = true;
      if (winners.length >= 2) {
        sawSplit = true;
        // krátký stack smí vyhrát nejvýš hlavní pot: 3 × 200 = 600
        const short = winners.find((w) => view.seats.find((s) => s.seat === w.seat)?.playerId === 'a');
        if (short) expect(short.amount).toBeLessThanOrEqual(600);
      }
    }
    expect(sawSplit).toBe(true);
    expect(sawSingle).toBe(true);
  });
});
