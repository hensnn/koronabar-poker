// Společná část fuzz testů: stoly s nahodilými boty a kontrola, že žetony nevznikají ani nemizí.
import { expect } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, resolveSettings, type SettingValues } from '@kb/shared';
import { randomLegalAction, seededRandom } from './bot.js';
import { FakeClock } from './clock.js';
import { GameError } from './types.js';
import { TableActor } from './table-actor.js';

const reg = createDefaultRegistry();
const USERS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'];

interface Sim {
  clock: FakeClock;
  ledger: Ledger;
  tables: { id: string; actor: TableActor }[];
  settings: SettingValues;
}

function build(seed: number, over: Record<string, number | boolean | string>, tables = 3): Sim {
  const clock = new FakeClock();
  const ledger = new Ledger();
  const cash = new CashService(ledger);
  const settings = resolveSettings(reg, [{ scope: 'global', values: { 'cash.minBuyInBb': 10, 'cash.maxBuyInBb': 200, 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'odds.enabled': false, ...over } }]).values;
  for (const u of USERS) cash.mint(u, 100_000, `mint-${u}`);
  const list = Array.from({ length: tables }, (_, i) => {
    const id = `t${i}`;
    return { id, actor: new TableActor({ tableId: id, settings: () => settings, clock, cash, randomProvider: seededRandom(seed + i) }) };
  });
  return { clock, ledger, tables: list, settings };
}

/** Invariant: nic nevzniklo ani nezmizelo. */
function checkInvariants(sim: Sim) {
  const ids = [accounts.mint(), accounts.house(), accounts.fund('jackpot'), ...USERS.map(accounts.wallet), ...sim.tables.map((t) => accounts.table(t.id))];
  expect(sim.ledger.totalIsZero(ids)).toBe(true);
  for (const t of sim.tables) {
    if (t.actor.currentPhase() === 'stopped') continue;
    expect(sim.ledger.balance(accounts.table(t.id)), `stůl ${t.id}`).toBe(t.actor.totalChips());
  }
  for (const u of USERS) expect(sim.ledger.balance(accounts.wallet(u))).toBeGreaterThanOrEqual(0);
}

export function run(seed: number, over: Record<string, number | boolean | string> = {}, steps = 1500) {
  const rnd = seededRandom(seed);
  const sim = build(seed, over);
  const handsSeen = new Set<string>();
  for (let step = 0; step < steps; step++) {
    const t = sim.tables[Math.floor(rnd() * sim.tables.length)]!;
    const user = USERS[Math.floor(rnd() * USERS.length)]!;
    const seated = t.actor.playersSeated().find((s) => s.userId === user);
    const r = rnd();
    try {
      if (!seated && !sim.tables.some((x) => x.actor.playersSeated().some((s) => s.userId === user)) && r < 0.5) {
        const free = [...Array(9).keys()].find((n) => !t.actor.playersSeated().some((s) => s.seat === n))!;
        const bb = Number(sim.settings['table.bigBlind']);
        t.actor.join(user, user, free, bb * (10 + Math.floor(rnd() * 100)));
      } else if (seated) {
        if (r < 0.04) t.actor.leave(user);
        else if (r < 0.07) t.actor.sitOut(user);
        else if (r < 0.12) t.actor.sitIn(user);
        else if (r < 0.16) t.actor.topUp(user, Number(sim.settings['table.bigBlind']) * (1 + Math.floor(rnd() * 20)));
        else if (r < 0.19) t.actor.setConnected(user, rnd() < 0.5);
      }
    } catch (e) {
      if (!(e instanceof GameError)) throw e;
    }
    // všichni boti na tahu odehrají
    for (const tb of sim.tables) {
      const v = tb.actor.viewFor(null);
      if (tb.actor.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((s) => s.seat === v.actingSeat)!;
        const legal = tb.actor.viewFor(p.playerId).legal!;
        if (rnd() < 0.8) tb.actor.act(p.playerId, randomLegalAction(legal, rnd));
        if (v.handId) handsSeen.add(v.handId);
      }
    }
    // hlasování o run it twice: boti hlasují náhodně
    for (const tb of sim.tables) {
      const vote = tb.actor.viewFor(null).vote;
      if (vote?.status === 'open') for (const v of vote.voters) if (rnd() < 0.5) try { tb.actor.voteRunIt(v.userId, rnd() < 0.7); } catch { /* už rozhodnuto */ }
      // dobrovolné ukázání karet a rabbit hunt po handě
      if (tb.actor.currentPhase() === 'pause' && rnd() < 0.3) {
        const who = USERS[Math.floor(rnd() * USERS.length)]!;
        try { tb.actor.showCards(who, rnd() < 0.5 ? 'both' : 0); } catch { /* nelze */ }
        try { tb.actor.rabbitHunt(who); } catch { /* nelze */ }
      }
    }
    sim.clock.advance(Math.floor(rnd() * 2000));
    checkInvariants(sim);
    for (const tb of sim.tables) expect(tb.actor.hasError()).toBeNull();
    // Oznámení o výhře ukazuje každého výherce jednou (výhry z více potů se sčítají).
    for (const tb of sim.tables) {
      const seats = (tb.actor.viewFor(null).winners ?? []).map((w) => w.seat);
      expect(new Set(seats).size).toBe(seats.length);
    }
  }
  return { sim, hands: handsSeen.size };
}
