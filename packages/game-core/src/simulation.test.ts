import { describe, it, expect } from 'vitest';
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

function run(seed: number, over: Record<string, number | boolean | string> = {}, steps = 1500) {
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
  }
  return { sim, hands: handsSeen.size };
}

describe('simulace s boty: invarianty peněz a stavu', { timeout: 120_000 }, () => {
  const seeds = process.env.SWEEP ? Array.from({ length: 30 }, (_, i) => 100 + i) : [1, 2, 3];
  for (const seed of seeds) {
    it(`seed ${seed}: tisíce akcí, měna se nikdy neztratí ani nevznikne`, () => {
      const { hands } = run(seed);
      expect(hands).toBeGreaterThan(20);
    });
  }

  it('s ante, krátkými časovači a time bankem', () => {
    const { hands } = run(11, { 'table.ante': 1, 'time.turnSeconds': 3, 'time.timeBankSeconds': 2, 'time.timeoutsToSitOut': 2 });
    expect(hands).toBeGreaterThan(30);
  });

  for (const [seed, mode] of [[41, 'chips'], [42, 'fischer'], [43, 'bronstein'], [44, 'chess'], [45, 'none']] as const) {
    it(`time bank v režimu ${mode}: simulace bez chyb, kniha sedí`, () => {
      const { hands } = run(seed, { 'time.bankMode': mode, 'time.turnSeconds': 4, 'time.timeBankSeconds': 12, 'time.timeChips': 2, 'time.timeChipSeconds': 3, 'time.timeoutsToSitOut': 3, 'time.callClockEnabled': true, 'time.bankRefillEveryHands': 3 }, 700);
      expect(hands).toBeGreaterThan(10);
    });
  }

  it('se zapnutými šancemi na výhru (přesný výčet)', () => {
    const { hands } = run(21, { 'odds.enabled': true }, 500);
    expect(hands).toBeGreaterThan(10);
  });

  it('s rake a jackpoty: kniha sedí, dům i jackpotový fond dostanou svoje, nic nevznikne ani nezmizí', () => {
    const { sim, hands } = run(31, { 'rake.enabled': true, 'rake.percent': 5, 'rake.cap': 5, 'rake.jackpotPercent': 40, 'jackpot.royalFlushEnabled': true, 'jackpot.badBeatEnabled': true, 'jackpot.badBeatMinHand': 'quads' }, 1500);
    expect(hands).toBeGreaterThan(20);
    expect(sim.ledger.balance(accounts.house())).toBeGreaterThan(0);
    const raked = sim.ledger.transactions().filter((t) => t.kind === 'rake').length;
    expect(raked).toBeGreaterThan(0);
    // jackpotový fond se plní z rake (po případných výplatách může být menší, ale není záporný)
    expect(sim.ledger.balance(accounts.fund('jackpot'))).toBeGreaterThanOrEqual(0);
    for (const t of sim.tables) t.actor.close();
    const ids = [accounts.mint(), accounts.house(), accounts.fund('jackpot'), ...USERS.map(accounts.wallet), ...sim.tables.map((t) => accounts.table(t.id))];
    expect(sim.ledger.totalIsZero(ids)).toBe(true);
    const wallets = USERS.reduce((n, u) => n + sim.ledger.balance(accounts.wallet(u)), 0);
    expect(wallets + sim.ledger.balance(accounts.house()) + sim.ledger.balance(accounts.fund('jackpot'))).toBe(USERS.length * 100_000);
  });

  for (const seed of [51, 52, 53]) {
    it(`speciální prvky (run it twice/třikrát, 7-2, bomb pot, rabbit hunt, ukázání karet), seed ${seed}: kniha a žetony vždy sedí`, () => {
      const { hands } = run(seed, { 'special.runItTwice': true, 'special.runItTimes': seed === 52 ? 3 : 2, 'special.runItVoteSeconds': 4, 'special.sevenTwoBonus': true, 'special.sevenTwoAmountBb': 1, 'special.bombPot': true, 'special.bombPotEveryHands': 4, 'special.bombPotAnteBb': 1, 'special.rabbitHunt': true, 'special.showCards': true, 'cash.minBuyInBb': 20 }, 1500);
      expect(hands).toBeGreaterThan(15);
    });
  }

  for (const [seed, mode] of [[61, 'fixedLimit'], [62, 'potLimit']] as const) {
    it(`sázkový limit ${mode}: simulace s boty, kniha a žetony sedí`, () => {
      const { hands } = run(seed, { 'table.bettingLimit': mode, 'table.limitMaxBets': 3 }, 1200);
      expect(hands).toBeGreaterThan(15);
    });
  }

  it('rakeback, poplatek za čas a high hand: kniha sedí a každý mechanismus se projeví', () => {
    const { sim } = run(33, { 'rake.enabled': true, 'rake.percent': 8, 'rake.cap': 0, 'rake.jackpotPercent': 50, 'rake.rakebackPercent': 30, 'rake.timeChargeEnabled': true, 'rake.timeChargeMinutes': 1, 'rake.timeChargeAmount': 2, 'jackpot.highHandEnabled': true, 'jackpot.highHandMinutes': 1, 'jackpot.highHandPercent': 50 }, 2500);
    const kinds = new Set(sim.ledger.transactions().map((t) => t.kind));
    expect(kinds.has('rake')).toBe(true);
    expect(kinds.has('rakeback')).toBe(true);
    expect(kinds.has('time_charge')).toBe(true);
    expect(kinds.has('jackpot_payout')).toBe(true);
    for (const t of sim.tables) t.actor.close();
    const ids = [accounts.mint(), accounts.house(), accounts.fund('jackpot'), ...USERS.map(accounts.wallet), ...sim.tables.map((t) => accounts.table(t.id))];
    expect(sim.ledger.totalIsZero(ids)).toBe(true);
    expect(sim.ledger.balance(accounts.house())).toBeGreaterThan(0);
    const wallets = USERS.reduce((n, u) => n + sim.ledger.balance(accounts.wallet(u)), 0);
    expect(wallets + sim.ledger.balance(accounts.house()) + sim.ledger.balance(accounts.fund('jackpot'))).toBe(USERS.length * 100_000);
  });

  it('po zrušení všech stolů jsou všechny peníze zpět v peněženkách', () => {
    const { sim } = run(5, {}, 600);
    for (const t of sim.tables) t.actor.close();
    expect(sim.ledger.totalIsZero([accounts.mint(), accounts.house(), ...USERS.map(accounts.wallet), ...sim.tables.map((t) => accounts.table(t.id))])).toBe(true);
    for (const t of sim.tables) expect(sim.ledger.balance(accounts.table(t.id))).toBe(0);
    const wallets = USERS.reduce((n, u) => n + sim.ledger.balance(accounts.wallet(u)), 0);
    expect(wallets).toBe(USERS.length * 100_000);
  });
});
