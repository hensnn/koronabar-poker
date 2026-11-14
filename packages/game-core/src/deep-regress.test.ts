// Regressions found by the deep fuzz (deep-fuzz-harness.ts). Each one is pinned to the seeds that used to break.
import { describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, resolveSettings } from '@kb/shared';
import { randomLegalAction, seededRandom } from './bot.js';
import { FakeClock } from './clock.js';
import { deepRun } from './deep-fuzz-harness.js';
import { TableActor, type PersistedTable, type TableEvent } from './table-actor.js';

describe('7-2 bonus together with rake', { timeout: 300_000 }, () => {
  // The bonus was taken before the rake: a player who won a side pot paid the bonus from chips the rake then took away,
  // and ended with a negative stack.
  const settings = { 'table.seats': 3, 'table.bigBlind': 20, 'table.smallBlind': 10, 'cash.minBuyInBb': 10, 'cash.maxBuyInBb': 40, 'special.sevenTwoBonus': true, 'special.sevenTwoAmountBb': 50, 'special.sevenTwoNeedsShowdown': false, 'special.bombPot': true, 'special.bombPotEveryHands': 1, 'special.bombPotAnteBb': 2, 'rake.enabled': true, 'rake.percent': 10, 'rake.cap': 100, 'time.turnSeconds': 3 };
  for (const seed of [8, 65, 67, 87]) {
    it(`seed ${seed}: nobody ends below zero and every rule holds`, () => {
      expect(deepRun(seed, settings, 500)).toEqual([]);
    });
  }
});

describe('equal small and big blind', { timeout: 300_000 }, () => {
  const reg = createDefaultRegistry();
  it('a table with blinds 10/10 starts (the engine refused to be created with them) and both blinds post the same', () => {
    const clock = new FakeClock();
    const ledger = new Ledger();
    const cash = new CashService(ledger);
    const settings = resolveSettings(reg, [{ scope: 'global', values: { 'table.smallBlind': 10, 'table.bigBlind': 10, 'cash.minBuyInBb': 10, 'cash.maxBuyInBb': 200, 'time.betweenHandsMs': 100 } }]).values;
    for (const u of ['a', 'b', 'c']) cash.mint(u, 10_000, `mint-${u}`);
    const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: seededRandom(5) });
    ['a', 'b', 'c'].forEach((u, i) => actor.join(u, u, i, 500));
    clock.advance(1000);
    const v = actor.viewFor(null);
    expect(actor.hasError()).toBeNull();
    expect(actor.currentPhase()).toBe('hand');
    expect(v.info).toMatchObject({ smallBlind: 10, bigBlind: 10 });
    expect(v.seats.map((s) => s.bet).sort((x, y) => x - y)).toEqual([0, 10, 10]);
    expect(ledger.balance(accounts.table('t'))).toBe(actor.totalChips());
  });
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: a whole session with equal blinds keeps every rule`, () => {
      expect(deepRun(seed, { 'table.smallBlind': 20, 'table.bigBlind': 20, 'table.straddleEnabled': seed === 2, 'special.runItTwice': true, 'special.runItVoteSeconds': 5, 'rake.enabled': seed !== 1, 'time.turnSeconds': 3, 'cash.minBuyInBb': 10 }, 500)).toEqual([]);
    });
  }
});

describe('a restart between hands', { timeout: 120_000 }, () => {
  const reg = createDefaultRegistry();
  /** Plays hands until `hands` of them are completely over; returns the table and the state it saved last. */
  function playUntilOver(over: Record<string, number | boolean | string>, hands: number, seed: number) {
    const clock = new FakeClock();
    const ledger = new Ledger();
    const cash = new CashService(ledger);
    const settings = resolveSettings(reg, [{ scope: 'global', values: { 'cash.minBuyInBb': 10, 'cash.maxBuyInBb': 200, 'time.betweenHandsMs': 5000, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.showCardsMs': 0, 'odds.enabled': false, ...over } }]).values;
    let saved: PersistedTable | null = null;
    let finished = 0;
    const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: seededRandom(seed), persist: (snap) => (saved = JSON.parse(JSON.stringify(snap))), onEvent: (e: TableEvent) => void (e.type === 'handFinished' && finished++) });
    const users = ['a', 'b', 'c'];
    for (const u of users) cash.mint(u, 100_000, `mint-${u}`);
    users.forEach((u, i) => actor.join(u, u, i, 400));
    const rnd = seededRandom(seed * 3 + 1);
    for (let step = 0; step < 5000 && finished < hands; step++) {
      const v = actor.viewFor(null);
      if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((s) => s.seat === v.actingSeat)!;
        const legal = actor.viewFor(p.playerId).legal;
        if (legal) actor.act(p.playerId, randomLegalAction(legal, rnd));
      }
      if (v.vote?.status === 'open') for (const voter of v.vote.voters) try { actor.voteRunIt(voter.userId, true); } catch { /* already decided */ }
      clock.advance(60);
    }
    return { actor, clock, cash, ledger, settings, users, saved: saved as PersistedTable | null, finished };
  }

  for (const [name, over] of [
    ['plain', {}],
    ['rake and rakeback', { 'rake.enabled': true, 'rake.percent': 10, 'rake.cap': 100, 'rake.rakebackPercent': 20 }],
    ['run it three times', { 'special.runItTwice': true, 'special.runItTimes': 3, 'special.runItVoteSeconds': 5 }],
    ['bomb pot and 7-2 bonus', { 'special.bombPot': true, 'special.bombPotEveryHands': 1, 'special.bombPotAnteBb': 2, 'special.sevenTwoBonus': true, 'special.sevenTwoAmountBb': 5 }],
  ] as const) {
    it(`${name}: a finished hand is neither taken back nor are its side effects kept alone`, () => {
      let checked = 0;
      for (const seed of [3, 4, 5, 6, 7, 8]) {
        const m = playUntilOver(over, 2, seed);
        // a seed where the bots bust each other before two hands are over proves nothing about the pause: skip it
        if (m.finished < 2 || m.actor.currentPhase() !== 'pause') continue;
        checked++;
        const now = Object.fromEntries(m.users.map((u) => [u, m.actor.chipsOf(u)]));
        // what the table saved is what everybody has, and it is what the ledger says is at the table
        expect(Object.fromEntries(m.saved!.seats.map((e) => [e.userId, e.chips + e.pendingChips])), `seed ${seed}`).toEqual(now);
        // a restart: the new table gives everybody the same chips
        const restored = new TableActor({ tableId: 't', settings: () => m.settings, clock: new FakeClock(), cash: m.cash, restore: m.saved! });
        expect(Object.fromEntries(m.users.map((u) => [u, restored.chipsOf(u)])), `seed ${seed}`).toEqual(now);
        expect(restored.totalChips()).toBe(m.ledger.balance(accounts.table('t')));
      }
      expect(checked).toBeGreaterThanOrEqual(2);
    });
  }

  it('a hand in progress returns whole: the chips from before it, without the correction for several runs', () => {
    // all-in with three runs: while the boards are being dealt the table has already put the correction aside
    const clock = new FakeClock();
    const ledger = new Ledger();
    const cash = new CashService(ledger);
    const settings = resolveSettings(reg, [{ scope: 'global', values: { 'cash.minBuyInBb': 10, 'cash.maxBuyInBb': 200, 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 2000, 'time.allInRiverDramaMs': 2000, 'time.showdownMs': 2000, 'time.runItDelayMs': 2000, 'time.potToWinnerMs': 2000, 'special.runItTwice': true, 'special.runItTimes': 3, 'special.runItVoteSeconds': 5, 'odds.enabled': false } }]).values;
    let checked = 0;
    for (let seed = 1; seed <= 30 && checked < 5; seed++) {
      const actor = new TableActor({ tableId: `t${seed}`, settings: () => settings, clock, cash, randomProvider: seededRandom(seed) });
      const users = [`a${seed}`, `b${seed}`];
      for (const u of users) cash.mint(u, 100_000, `mint-${u}`);
      users.forEach((u, i) => actor.join(u, u, i, 400));
      clock.advance(200);
      // both go all-in before the flop
      for (let i = 0; i < 4 && actor.viewFor(null).actingSeat !== null; i++) {
        const v = actor.viewFor(null);
        const p = v.seats.find((s) => s.seat === v.actingSeat)!;
        const legal = actor.viewFor(p.playerId).legal!;
        actor.act(p.playerId, legal.canBet || legal.canRaise ? { type: 'allIn' } : { type: 'call' });
      }
      for (const u of users) try { actor.voteRunIt(u, true); } catch { /* no vote */ }
      clock.advance(500);
      if (actor.currentPhase() !== 'runout') continue;
      checked++;
      const snap = actor.persisted();
      // every player as he sat down, whatever the runs will bring
      expect(snap.seats.map((e) => e.chips + e.pendingChips), `seed ${seed}`).toEqual([400, 400]);
      actor.stop();
    }
    expect(checked).toBeGreaterThan(0);
  });
});

