import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger, TournamentMoney } from '@kb/ledger';
import { createDefaultRegistry, resolveSettings, type SettingValues } from '@kb/shared';
import { randomLegalAction, seededRandom } from '../bot.js';
import { FakeClock } from '../clock.js';
import { watchTable } from '../deep-fuzz-harness.js';
import { TableActor } from '../table-actor.js';
import { auditPayouts } from './tied-payouts.js';
import { Tournament, TournamentError, type Payment } from './tournament.js';

/**
 * Randomised simulation of whole tournaments: every run draws a different combination of payout table, rounding,
 * guarantee, cuts, rebuy, add-on, re-entry, late registration, bounty type and deals, lets bots play it to the end and
 * then checks every amount against an oracle written from the rules (not by calling the engine's own helpers).
 *
 * SIM_RUNS / SIM_FROM choose how many and which seeds run (default: a small regression set); SIM_REPORT writes all
 * findings to a JSON file instead of stopping at the first one.
 */
const reg = createDefaultRegistry();
const WALLET = 1_000_000;
const RUNS = Number(process.env.SIM_RUNS ?? 300);
const FROM = Number(process.env.SIM_FROM ?? 1);
const REPORT = process.env.SIM_REPORT;

type Over = Record<string, number | boolean | string>;
type Rnd = () => number;
const pick = <T>(rnd: Rnd, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const chance = (rnd: Rnd, p: number) => rnd() < p;

/** One random but valid tournament setup. Combinations that break a cross-field rule are drawn again. */
function randomSetup(seed: number): { over: Over; players: number; late: number } {
  const rnd = seededRandom(seed * 7919 + 13);
  for (;;) {
    const players = pick(rnd, [2, 2, 3, 3, 4, 4, 5, 6, 6, 7, 8, 9]);
    const buyIn = pick(rnd, [0, 37, 50, 100, 100, 333, 1000]);
    const over: Over = {
      'table.seats': 9,
      'tournament.buyIn': buyIn,
      'tournament.fee': pick(rnd, [0, 0, 2, 10]),
      'tournament.startingStack': 1500,
      'tournament.levelMinutes': 1,
      'tournament.targetMinutes': 20,
      'tournament.houseCutPercent': pick(rnd, [0, 0, 5, 10, 13]),
      'tournament.fundPercent': pick(rnd, [0, 0, 3, 7]),
      'tournament.guarantee': pick(rnd, [0, 0, 0, 300, 2500, 9999]),
      'tournament.payoutPreset': pick(rnd, ['standard', 'standard', 'wta', 'top2', 'top3', 'custom', 'custom']),
      'tournament.payoutCustom': pick(rnd, ['50,30,20', '70,30', '100', '40,25,15,10,10', '33.34,33.33,33.33', '60,25,10,5', '45.5,30.25,24.25']),
      'tournament.payoutRoundTo': pick(rnd, [1, 1, 5, 10, 25, 100]),
      'tournament.payoutRemainder': pick(rnd, ['first', 'house', 'spread']),
      'tournament.breakEveryLevels': pick(rnd, [0, 0, 3]),
      'tournament.breakMinutes': 1,
      'special.runItTwice': chance(rnd, 0.2),
      'special.runItTimes': pick(rnd, [2, 3]),
      'special.runItVoteSeconds': 3,
      'special.rabbitHunt': chance(rnd, 0.15),
      'table.bettingLimit': pick(rnd, ['noLimit', 'noLimit', 'noLimit', 'potLimit', 'fixedLimit']),
    };
    if (chance(rnd, 0.15)) Object.assign(over, { 'special.bombPot': true, 'special.bombPotEveryHands': 3, 'special.bombPotAnteBb': 1 });
    // A share of the runs is a plain freezeout with deals, so that deals are not always blocked by open rebuy or late registration.
    const dealFocus = chance(rnd, 0.3);
    if (!dealFocus && chance(rnd, 0.5)) {
      Object.assign(over, {
        'tournament.rebuyEnabled': true,
        'tournament.rebuyWhen': pick(rnd, ['busted', 'belowStart']),
        'tournament.rebuyUntilLevel': pick(rnd, [2, 3, 5]),
        'tournament.rebuyCost': pick(rnd, [buyIn || 50, 50, 77]),
        'tournament.rebuyChips': pick(rnd, [1500, 1000, 3000]),
        'tournament.rebuyMax': pick(rnd, [1, 2, 5]),
        'tournament.rebuyDecisionSeconds': pick(rnd, [10, 30]),
      });
    }
    if (!dealFocus && chance(rnd, 0.4)) {
      const from = pick(rnd, [1, 2, 3]);
      Object.assign(over, {
        'tournament.addonEnabled': true,
        'tournament.addonFromLevel': from,
        'tournament.addonUntilLevel': from + pick(rnd, [0, 1]),
        'tournament.addonCost': pick(rnd, [50, 100, 133]),
        'tournament.addonChips': pick(rnd, [1000, 4500]),
        'tournament.addonMode': pick(rnd, ['window', 'offer', 'both']),
        'tournament.addonOfferSeconds': 20,
      });
    }
    const lateLevels = !dealFocus && chance(rnd, 0.35) ? pick(rnd, [2, 4]) : 0;
    if (lateLevels) over['tournament.lateRegLevels'] = lateLevels;
    if (!dealFocus && chance(rnd, 0.3)) Object.assign(over, { 'tournament.reentryEnabled': true, 'tournament.reentryMax': pick(rnd, [1, 2]), 'tournament.lateRegLevels': lateLevels || 3 });
    const bountyType = pick(rnd, ['none', 'none', 'fixed', 'pko', 'mystery']);
    if (bountyType !== 'none') {
      Object.assign(over, {
        'tournament.bountyType': bountyType,
        'tournament.bountyMode': pick(rnd, ['percent', 'amount']),
        'tournament.bountyPercent': pick(rnd, [10, 30, 50, 90]),
        'tournament.bountyAmount': pick(rnd, [1, 10, 25, 49]),
        'tournament.pkoCashPercent': pick(rnd, [0, 30, 50, 100]),
        'tournament.bountyPayout': pick(rnd, ['instant', 'end']),
        'tournament.bountySplit': pick(rnd, ['equal', 'byWinnings']),
      });
    }
    if (dealFocus || chance(rnd, 0.3)) {
      Object.assign(over, {
        'tournament.dealEnabled': true,
        'tournament.dealMaxPlayers': pick(rnd, [2, 3, 4, 6]),
        'tournament.dealVoteSeconds': 30,
        'tournament.dealCooldownSeconds': pick(rnd, [0, 30]),
        'tournament.dealKeepMaxPercent': pick(rnd, [0, 20, 50]),
      });
    }
    const values = resolveSettings(reg, [{ scope: 'global', values: over }]).values;
    if (reg.crossRules().every((r) => r.check(values))) return { over, players, late: lateLevels ? pick(rnd, [0, 1, 2]) : 0 };
  }
}

interface Sim {
  clock: FakeClock;
  ledger: Ledger;
  money: TournamentMoney;
  table: TableActor;
  tour: Tournament;
  settings: SettingValues;
  users: string[];
  lateUsers: string[];
  /** Every bust the table reported, with each player's entry and rebuy count at that moment (to tell later who came back). */
  busts: { userId: string; startStack: number; stamp: string }[][];
  seen: { rebuy: number; addon: number; reentry: number; late: number; dealPassed: number; dealKeep: number; tie: number };
  /** Rules of the table itself (hidden cards, a stuck hand, offered actions, hand records), checked after every step. */
  watch: { check: () => void };
  broken: string[];
}

function build(seed: number, over: Over, players: number, late: number): Sim {
  const clock = new FakeClock();
  const ledger = new Ledger();
  const cash = new CashService(ledger);
  const money = new TournamentMoney(ledger);
  const settings = resolveSettings(reg, [
    { scope: 'global', values: { 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.turnSeconds': 5, 'odds.enabled': false, ...over } },
  ]).values;
  const users = Array.from({ length: players }, (_, i) => `u${i + 1}`);
  const lateUsers = Array.from({ length: late }, (_, i) => `late${i + 1}`);
  for (const u of [...users, ...lateUsers]) cash.mint(u, WALLET, `mint-${u}`);
  const busts: Sim['busts'] = [];
  const tour = new Tournament({ id: 'T', settings: () => settings, clock, money });
  const broken: string[] = [];
  const watch = watchTable(() => table, clock, (rule, detail) => void broken.push(`${rule}: ${detail}`), () => Number(tour.tableSettings()['table.seats']), undefined, () => !!tour.tableSettings()['table.bbAnte'] || !!tour.tableSettings()['special.bombPot']);
  const table: TableActor = new TableActor({ tableId: 'T', tournament: true, settings: () => tour.tableSettings(), clock, cash, randomProvider: seededRandom(seed), onEvent: (e) => {
      watch.onEvent(e);
      if (e.type === 'bust') busts.push(e.players.map((b) => ({ userId: b.userId, startStack: b.startStack, stamp: stampOf(tour, b.userId) })));
      tour.onTableEvent(e);
    },
  });
  tour.attachTable(table);
  return { clock, ledger, money, table, tour, settings, users, lateUsers, busts, seen: { rebuy: 0, addon: 0, reentry: 0, late: 0, dealPassed: 0, dealKeep: 0, tie: 0 }, watch, broken };
}

/** Entry number and rebuys paid so far: changes whenever the player comes back into the game. */
function stampOf(tour: Tournament, userId: string): string {
  const st = tour.state();
  return `${st.players.find((p) => p.userId === userId)?.entries ?? 0}:${st.payments.filter((p) => p.userId === userId && p.kind === 'turnaj_rebuy' && !p.refunded).length}`;
}

const tryIt = (fn: () => void): boolean => {
  try {
    fn();
    return true;
  } catch (e) {
    if (!(e instanceof TournamentError)) throw e;
    return false;
  }
};

const allAccounts = (h: Sim) => [accounts.mint(), accounts.house(), accounts.fund('sezona'), accounts.tournament('T'), accounts.bounty('T'), ...[...h.users, ...h.lateUsers].map(accounts.wallet)];

/** Chips the tournament has handed out so far (entries, rebuys, add-ons). */
function granted(h: Sim): number {
  const s = h.settings;
  const st = h.tour.state();
  const chips = { turnaj_rebuy: Number(s['tournament.rebuyChips']), turnaj_addon: Number(s['tournament.addonChips']) };
  return st.players.reduce((a, p) => a + p.entries * Number(s['tournament.startingStack']), 0) + st.payments.filter((p) => !p.refunded && p.kind !== 'turnaj_buyin').reduce((a, p) => a + chips[p.kind as 'turnaj_rebuy' | 'turnaj_addon'], 0);
}

/** Bots play the tournament; players also rebuy, add on, re-enter, register late and negotiate deals at random. */
async function play(h: Sim, seed: number): Promise<void> {
  const rnd = seededRandom(seed * 31 + 7);
  for (let step = 0; step < 60_000 && h.tour.state().status === 'running'; step++) {
    const v = h.table.viewFor(null);
    if (h.table.currentPhase() === 'hand' && v.actingSeat !== null) {
      const p = v.seats.find((s) => s.seat === v.actingSeat)!;
      const legal = h.table.viewFor(p.playerId).legal;
      if (legal && rnd() < 0.85) h.table.act(p.playerId, randomLegalAction(legal, rnd));
    }
    for (const p of h.tour.state().players) {
      const r = rnd();
      if (p.status === 'deciding') {
        if (r < 0.3) tryIt(() => h.tour.rebuy(p.userId));
        else if (r < 0.4) tryIt(() => h.tour.reenter(p.userId));
        else if (r < 0.45) tryIt(() => h.tour.declineDecision(p.userId));
      } else if (p.status === 'out' && r < 0.02) tryIt(() => h.tour.reenter(p.userId));
      else if (p.status === 'playing' && r < 0.03) tryIt(() => h.tour.addon(p.userId));
      else if (p.status === 'playing' && r < 0.05) tryIt(() => h.tour.rebuy(p.userId));
    }
    for (const u of h.lateUsers) if (!h.tour.state().players.some((p) => p.userId === u) && rnd() < 0.01) tryIt(() => h.tour.register(u, u));
    if (h.settings['tournament.dealEnabled'] && rnd() < 0.15) {
      const opt = h.tour.dealOptions();
      if (opt.vote?.status === 'open') {
        // Most votes pass, some are refused or left to expire.
        const mood = rnd();
        for (const voter of opt.participants) if (mood < 0.75 || rnd() < 0.5) tryIt(() => h.tour.voteDeal(voter.userId, mood < 0.75));
      } else if (opt.blocked === null && opt.participants.length >= 2 && opt.allowed.length > 0) {
        const method = pick(rnd, opt.allowed);
        const keep = opt.keepMax > 0 && rnd() < 0.4 ? Math.floor(rnd() * (opt.keepMax + 1)) : 0;
        const rest = opt.total - keep;
        let custom: Record<string, number> | undefined;
        if (method === 'custom') {
          // A random split of the shared money that adds up exactly.
          const cuts = opt.participants.map(() => rnd());
          const sum = cuts.reduce((a, b) => a + b, 0);
          const parts = cuts.map((c) => Math.floor((rest * c) / sum));
          parts[0]! += rest - parts.reduce((a, b) => a + b, 0);
          custom = Object.fromEntries(opt.participants.map((p, i) => [p.userId, parts[i]!]));
        }
        tryIt(() => h.tour.proposeDeal(pick(rnd, opt.participants).userId, { method, keep, custom }));
      }
    }
    h.clock.advance(Math.floor(rnd() * 3000));
    await Promise.resolve();
    if (!h.ledger.totalIsZero(allAccounts(h))) throw new Error(`ledger is not balanced at step ${step}`);
    const err = h.table.hasError() as Error | null;
    if (err) throw new Error(`table error at step ${step}: ${err.stack}`);
    if (h.tour.state().status === 'running' && h.table.totalChips() !== granted(h)) throw new Error(`chips at the table ${h.table.totalChips()} differ from chips granted ${granted(h)} at step ${step}`);
    h.watch.check();
    if (h.broken.length) throw new Error(`table rule broken at step ${step}: ${h.broken[0]}`);
  }
  await Promise.resolve();
}

// ---------- the oracle: written from the rules, independent of the engine's helpers ----------

const STANDARD: number[][] = [[100], [65, 35], [50, 30, 20], [45, 27, 17, 11], [40, 25, 17, 11, 7], [38, 24, 16, 11, 7, 4], [35, 23, 16, 11, 8, 4, 3], [33, 22, 16, 11, 8, 5, 3, 2], [32, 21, 15, 11, 8, 6, 4, 2, 1]];

/** Percentages of the pool by place, in hundredths of a percent. */
function oraclePercents(s: SettingValues, players: number): number[] {
  const preset = String(s['tournament.payoutPreset']);
  if (preset === 'custom') {
    const pct = String(s['tournament.payoutCustom'])
      .split(',')
      .map((x) => Math.round(Number(x.trim()) * 100));
    if (pct.length <= players) return pct;
    // Fewer players than paid places: the taken places keep their ratios and are scaled up to 100 %.
    const kept = pct.slice(0, players);
    const total = kept.reduce((a, b) => a + b, 0);
    const scaled = kept.map((x) => Math.floor((x * 10_000) / total));
    scaled[0]! += 10_000 - scaled.reduce((a, b) => a + b, 0);
    return scaled;
  }
  // Standard: 1 paid place up to 3 players, 2 up to 6, 3 up to 10, then 15 % of the field (rounded up).
  const places = preset === 'wta' ? 1 : preset === 'top2' ? Math.min(2, players) : preset === 'top3' ? Math.min(3, players) : players <= 3 ? 1 : players <= 6 ? 2 : players <= 10 ? 3 : Math.ceil(players * 0.15);
  return STANDARD[places - 1]!.map((x) => x * 100);
}

/** Payout table: each place rounded down to the unit, the rest by the chosen rule. */
function oraclePayouts(pool: number, pct: number[], unit: number, rule: string): { amounts: number[]; toHouse: number } {
  const amounts = pct.map((bp) => Math.floor(Math.floor((pool * bp) / 10_000) / unit) * unit);
  let rest = pool - amounts.reduce((a, b) => a + b, 0);
  if (rule === 'house') return { amounts, toHouse: rest };
  if (rule === 'spread') {
    for (let i = 0; rest >= unit; i = (i + 1) % amounts.length) {
      amounts[i]! += unit;
      rest -= unit;
    }
  }
  amounts[0]! += rest;
  return { amounts, toHouse: 0 };
}

interface Finding {
  kind: 'bug' | 'design';
  text: string;
}

/** Checks a finished tournament; returns everything that does not add up. */
function verify(h: Sim): Finding[] {
  const out: Finding[] = [];
  const bug = (text: string) => out.push({ kind: 'bug', text });
  const design = (text: string) => out.push({ kind: 'design', text });
  const st = h.tour.state();
  const s = h.settings;
  const n = (key: string) => Number(s[key]);
  if (st.status !== 'finished' || !st.results) return [{ kind: 'bug', text: `tournament did not finish (status ${st.status})` }];
  const res = st.results;
  const everyone = [...h.users, ...h.lateUsers];
  const entered = st.players.map((p) => p.userId);
  const bal = (a: string) => h.ledger.balance(a);

  // places: everybody who entered has exactly one place, 1..n
  if (res.map((r) => r.place).join() !== res.map((_, i) => i + 1).join()) bug(`places are not 1..n: ${res.map((r) => r.place).join()}`);
  if (new Set(res.map((r) => r.userId)).size !== res.length || res.length !== entered.length || res.some((r) => !entered.includes(r.userId))) bug(`results do not list every entrant exactly once (${res.length} rows, ${entered.length} entrants)`);

  // money in: every payment split by the rules
  const pays = st.payments.filter((p) => !p.refunded);
  const bountyOn = String(s['tournament.bountyType']) !== 'none';
  const expectSplit = (p: Payment) => {
    const house = Math.floor((p.cost * n('tournament.houseCutPercent')) / 100);
    const fund = Math.floor((p.cost * n('tournament.fundPercent')) / 100);
    let bounty = 0;
    if (bountyOn && p.kind !== 'turnaj_addon') {
      const wanted = String(s['tournament.bountyMode']) === 'amount' ? n('tournament.bountyAmount') : Math.floor((p.cost * n('tournament.bountyPercent')) / 100);
      bounty = Math.max(0, Math.min(wanted, p.cost - house - fund));
    }
    return { house, fund, bounty };
  };
  const costOf = { turnaj_buyin: n('tournament.buyIn'), turnaj_rebuy: n('tournament.rebuyCost'), turnaj_addon: n('tournament.addonCost') };
  for (const p of pays) {
    const e = expectSplit(p);
    if ((p.house ?? 0) !== e.house || (p.fund ?? 0) !== e.fund || (p.bounty ?? 0) !== e.bounty) bug(`payment ${p.key}: split house/fund/bounty ${p.house}/${p.fund}/${p.bounty}, expected ${e.house}/${e.fund}/${e.bounty}`);
    if (p.cost !== costOf[p.kind]) bug(`payment ${p.key}: cost ${p.cost}, expected ${costOf[p.kind]}`);
    if (p.fee !== (p.kind === 'turnaj_buyin' ? n('tournament.fee') : 0)) bug(`payment ${p.key}: fee ${p.fee}`);
    if (p.cost - (p.house ?? 0) - (p.fund ?? 0) - (p.bounty ?? 0) < 0) bug(`payment ${p.key}: more is taken than was paid`);
  }
  const sum = (f: (p: Payment) => number) => pays.reduce((a, p) => a + f(p), 0);
  const poolIn = sum((p) => p.cost - (p.house ?? 0) - (p.fund ?? 0) - (p.bounty ?? 0));
  const overlay = Math.max(0, n('tournament.guarantee') - poolIn);
  const pool = poolIn + overlay;
  if ((st.overlay ?? 0) !== overlay) bug(`overlay ${st.overlay ?? 0}, expected ${overlay} (guarantee ${n('tournament.guarantee')}, collected ${poolIn})`);

  // per-player limits
  for (const p of st.players) {
    const own = pays.filter((x) => x.userId === p.userId);
    const addons = own.filter((x) => x.kind === 'turnaj_addon').length;
    // A free entry (no buy-in and no fee) leaves no payment behind: count entries from the record then.
    const free = n('tournament.buyIn') + n('tournament.fee') === 0;
    const entries = free ? p.entries : own.filter((x) => x.kind === 'turnaj_buyin').length;
    if (entries !== p.entries) bug(`${p.userId}: ${entries} paid entries, record says ${p.entries}`);
    if (!s['tournament.reentryEnabled'] && entries > 1) bug(`${p.userId}: re-entered although re-entry is off`);
    if (s['tournament.reentryEnabled'] && entries > 1 + n('tournament.reentryMax')) bug(`${p.userId}: ${entries} entries, limit ${1 + n('tournament.reentryMax')}`);
    if (!s['tournament.addonEnabled'] && addons > 0) bug(`${p.userId}: add-on although add-on is off`);
    if (addons > entries) bug(`${p.userId}: ${addons} add-ons in ${entries} entries`);
    if (!s['tournament.rebuyEnabled'] && own.some((x) => x.kind === 'turnaj_rebuy')) bug(`${p.userId}: rebuy although rebuy is off`);
    // rebuys per entry (the key carries entry number and rebuy number)
    const perEntry = new Map<string, number>();
    for (const x of own.filter((y) => y.kind === 'turnaj_rebuy')) perEntry.set(x.key.split(':')[4]!, (perEntry.get(x.key.split(':')[4]!) ?? 0) + 1);
    for (const [entry, count] of perEntry) if (count > n('tournament.rebuyMax')) bug(`${p.userId}: ${count} rebuys in entry ${entry}, limit ${n('tournament.rebuyMax')}`);
  }

  // payout table
  const pct = oraclePercents(s, res.length);
  const unit = n('tournament.payoutRoundTo');
  const rule = String(s['tournament.payoutRemainder']);
  const table = pool > 0 ? oraclePayouts(pool, pct, unit, rule) : { amounts: [] as number[], toHouse: 0 };
  const amountAt = (i: number) => table.amounts[i] ?? 0;
  if (pool > 0) {
    if (table.amounts.reduce((a, b) => a + b, 0) + table.toHouse !== pool) bug('oracle: payout table does not add up to the pool');
    for (let i = 1; i < pct.length; i++) {
      if (amountAt(i) > amountAt(i - 1)) (pct[i]! <= pct[i - 1]! ? bug : design)(`payout table pays place ${i + 1} more than place ${i} (${amountAt(i)} > ${amountAt(i - 1)}; percents ${pct.map((x) => x / 100).join('/')}, ${res.length} players, pool ${pool}, round to ${unit}, rest ${rule})`);
      else if (amountAt(i) === amountAt(i - 1) && amountAt(i) > 0 && pct[i]! < pct[i - 1]!) design(`payout table pays places ${i} and ${i + 1} the same (${amountAt(i)}) although their percents differ (pool ${pool}, round to ${unit})`);
    }
    pct.forEach((bp, i) => {
      if (bp > 0 && amountAt(i) === 0) design(`paid place ${i + 1} (${bp / 100} %) gets nothing: pool ${pool}, round to ${unit}, rest ${rule}`);
    });
    if (rule === 'house' && table.toHouse >= unit * pct.length) bug(`house keeps ${table.toHouse} from rounding, more than ${pct.length} units of ${unit}`);
  }

  // what was really paid
  const deal = st.deal ?? null;
  const paid = res.map((r) => r.payout);
  const paidSum = paid.reduce((a, b) => a + b, 0);
  const toHouse = pool - paidSum;
  if (paid.some((x) => !Number.isInteger(x) || x < 0)) bug(`payouts are not whole non-negative numbers: ${paid.join()}`);
  if (toHouse !== table.toHouse) bug(`paid ${paidSum} of pool ${pool}: house rounding share ${toHouse}, expected ${table.toHouse}`);
  // the engine's own recheck tool must agree with what the engine paid
  const audit = auditPayouts({ results: res, amounts: table.amounts, deal, tiedGroups: st.tiedGroups ?? [], rebought: new Set() });
  if (audit.verdict !== 'ok') bug(`payouts ${paid.join('/')} differ from the recomputation ${audit.correct.join('/')} (${audit.verdict})`);
  // Ties, followed by the simulation itself: players who busted in the same hand with equal stacks and never came back
  // share the payouts of their places, but only when the places are neighbours; everybody else gets exactly the table.
  const inDeal = (userId: string) => !!deal && userId in deal.amounts;
  const placeOf = new Map(res.map((r, i) => [r.userId, i]));
  const sharing = new Set<number>();
  for (const bust of h.busts) {
    const byStack = new Map<number, number[]>();
    for (const x of bust) {
      if (stampOf(h.tour, x.userId) !== x.stamp || inDeal(x.userId) || !placeOf.has(x.userId)) continue;
      byStack.set(x.startStack, [...(byStack.get(x.startStack) ?? []), placeOf.get(x.userId)!]);
    }
    for (const idx of byStack.values()) {
      idx.sort((x, y) => x - y);
      if (idx.length < 2 || idx[0] === 0 || idx[idx.length - 1]! - idx[0]! !== idx.length - 1) continue;
      h.seen.tie++;
      for (const i of idx) sharing.add(i);
      const total = idx.reduce((sum2, i) => sum2 + amountAt(i), 0);
      const got = idx.map((i) => paid[i]!);
      if (got.reduce((x, y) => x + y, 0) !== total) bug(`tie on places ${idx.map((i) => i + 1).join('+')}: shared ${got.join('+')} is not ${total}`);
      if (Math.max(...got) - Math.min(...got) > 1) bug(`tie on places ${idx.map((i) => i + 1).join('+')}: shares differ by more than 1 (${got.join('/')})`);
    }
  }
  res.forEach((r, i) => {
    if (!sharing.has(i) && !inDeal(r.userId) && r.payout !== amountAt(i)) bug(`place ${r.place} got ${r.payout}, the payout table says ${amountAt(i)} (paid ${paid.join('/')})`);
  });
  if (deal) {
    h.seen.dealPassed++;
    if (deal.keep > 0) h.seen.dealKeep++;
    const k = deal.participants.length;
    const shared = Object.values(deal.amounts).reduce((a, b) => a + b, 0);
    const top = res.slice(0, k).map((r) => r.userId).sort().join();
    if (top !== [...deal.participants].sort().join()) bug(`deal: participants ${deal.participants.join()} are not the top ${k} places (${top})`);
    const prizes = Array.from({ length: k }, (_, i) => amountAt(i)).reduce((a, b) => a + b, 0);
    if (shared + deal.keep !== prizes) bug(`deal: shared ${shared} + kept ${deal.keep} is not the money for the top ${k} places (${prizes})`);
    if (Object.values(deal.amounts).some((x) => !Number.isInteger(x) || x < 0)) bug(`deal: amounts ${Object.values(deal.amounts).join()}`);
    if (deal.keep > Math.floor((prizes * n('tournament.dealKeepMaxPercent')) / 100)) bug(`deal: kept ${deal.keep} is over the limit`);
    res.slice(0, k).forEach((r, i) => {
      const want = (deal.amounts[r.userId] ?? 0) + (i === 0 ? deal.keep : 0);
      if (r.payout !== want) bug(`deal: place ${r.place} got ${r.payout}, agreed ${want}`);
    });
  }

  // bounty: everything collected is paid out, nobody earns without the feature
  const bountyIn = sum((p) => p.bounty ?? 0);
  const earned = st.players.reduce((a, p) => a + (p.bountyEarned ?? 0), 0);
  if (earned !== bountyIn) bug(`bounty: collected ${bountyIn}, players earned ${earned}`);
  if (st.players.some((p) => (p.bountyEarned ?? 0) < 0 || (p.bountyUnpaid ?? 0) !== 0)) bug('bounty: negative or unpaid bounty left on a player');
  if (res.some((r) => (r.bounty ?? 0) !== (st.players.find((p) => p.userId === r.userId)?.bountyEarned ?? 0))) bug('bounty: results show a different bounty than the player record');

  // ledger: closed accounts, every wallet, house and fund
  if (bal(accounts.tournament('T')) !== 0) bug(`tournament account holds ${bal(accounts.tournament('T'))} after the end`);
  if (bal(accounts.bounty('T')) !== 0) bug(`bounty account holds ${bal(accounts.bounty('T'))} after the end`);
  if (!h.ledger.totalIsZero(allAccounts(h))) bug('ledger total is not zero');
  for (const u of everyone) {
    const own = pays.filter((p) => p.userId === u);
    const row = res.find((r) => r.userId === u);
    const want = WALLET - own.reduce((a, p) => a + p.cost + p.fee, 0) + (row?.payout ?? 0) + (st.players.find((p) => p.userId === u)?.bountyEarned ?? 0);
    if (bal(accounts.wallet(u)) !== want) bug(`wallet ${u}: ${bal(accounts.wallet(u))}, expected ${want}`);
  }
  if (bal(accounts.fund('sezona')) !== sum((p) => p.fund ?? 0)) bug(`fund holds ${bal(accounts.fund('sezona'))}, expected ${sum((p) => p.fund ?? 0)}`);
  const houseAndMint = bal(accounts.house()) + bal(accounts.mint()) + WALLET * everyone.length;
  const wantHouse = sum((p) => p.fee + (p.house ?? 0)) + table.toHouse - overlay;
  if (houseAndMint !== wantHouse) bug(`house and newly issued money: ${houseAndMint}, expected ${wantHouse} (fees and cuts ${sum((p) => p.fee + (p.house ?? 0))}, rounding ${table.toHouse}, guarantee top-up ${overlay})`);
  if (bal(accounts.house()) < 0) bug(`house account is negative: ${bal(accounts.house())}`);

  h.seen.rebuy += pays.filter((p) => p.kind === 'turnaj_rebuy').length;
  h.seen.addon += pays.filter((p) => p.kind === 'turnaj_addon').length;
  h.seen.reentry += st.players.filter((p) => p.entries > 1).length;
  h.seen.late += st.players.filter((p) => p.userId.startsWith('late')).length;
  return out;
}

describe('turnaj: simulace náhodných kombinací výplat a speciálních prvků', { timeout: 3_600_000 }, () => {
  const report: { seed: number; setup: ReturnType<typeof randomSetup>; findings: Finding[] }[] = [];
  const seen = { rebuy: 0, addon: 0, reentry: 0, late: 0, dealPassed: 0, dealKeep: 0, tie: 0, bounty: 0 };

  it(`odehraje ${RUNS} náhodných turnajů (od semínka ${FROM}) a každá částka sedí`, async () => {
    for (let seed = FROM; seed < FROM + RUNS; seed++) {
      const setup = randomSetup(seed);
      const h = build(seed, setup.over, setup.players, setup.late);
      let findings: Finding[];
      try {
        for (const u of h.users) h.tour.register(u, u);
        h.tour.start();
        await play(h, seed);
        findings = verify(h);
      } catch (e) {
        findings = [{ kind: 'bug', text: `crash: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}` }];
      }
      for (const k of ['rebuy', 'addon', 'reentry', 'late', 'dealPassed', 'dealKeep', 'tie'] as const) seen[k] += h.seen[k];
      if (setup.over['tournament.bountyType']) seen.bounty++;
      if (findings.length > 0) report.push({ seed, setup, findings });
    }
    if (REPORT) writeFileSync(REPORT, JSON.stringify({ from: FROM, runs: RUNS, seen, report }, null, 2));
    const bugs = report.flatMap((r) => r.findings.filter((f) => f.kind === 'bug').map((f) => `seed ${r.seed}: ${f.text}`));
    expect(bugs, bugs.slice(0, 20).join('\n')).toEqual([]);
  });

  it('simulace skutečně vyzkoušela rebuy, add-on, re-entry, pozdní registraci, bounty i dohody', () => {
    if (RUNS < 100) return;
    expect(seen.rebuy).toBeGreaterThan(0);
    expect(seen.addon).toBeGreaterThan(0);
    expect(seen.reentry).toBeGreaterThan(0);
    expect(seen.bounty).toBeGreaterThan(0);
    expect(seen.dealPassed).toBeGreaterThan(0);
  });
});
