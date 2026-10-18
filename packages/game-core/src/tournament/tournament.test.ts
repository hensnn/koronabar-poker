import { describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger, TournamentMoney } from '@kb/ledger';
import { createDefaultRegistry, resolveSettings, type SettingValues } from '@kb/shared';
import { randomLegalAction, seededRandom } from '../bot.js';
import { FakeClock } from '../clock.js';
import { TableActor } from '../table-actor.js';
import { poolPart, Tournament, TournamentError, type TournamentEvent } from './tournament.js';

const reg = createDefaultRegistry();
const WALLET = 10_000;

interface Harness {
  clock: FakeClock;
  ledger: Ledger;
  money: TournamentMoney;
  table: TableActor;
  tour: Tournament;
  settings: SettingValues;
  users: string[];
  events: TournamentEvent[];
  handStarts: number[];
  tableBlinds: () => number[];
}

function harness(over: Record<string, number | boolean | string> = {}, count = 6, seed = 1): Harness {
  const clock = new FakeClock();
  const ledger = new Ledger();
  const cash = new CashService(ledger);
  const money = new TournamentMoney(ledger);
  const settings = resolveSettings(reg, [
    {
      scope: 'global',
      values: {
        'time.betweenHandsMs': 100,
        'time.allInRunoutDelayMs': 50,
        'time.allInRiverDramaMs': 50,
        'time.showdownMs': 50,
        'time.potToWinnerMs': 50,
        'time.turnSeconds': 5,
        'odds.enabled': false,
        'tournament.buyIn': 100,
        'tournament.fee': 10,
        'tournament.startingStack': 1500,
        'tournament.levelMinutes': 1,
        'tournament.targetMinutes': 20,
        ...over,
      },
    },
  ]).values;
  const users = Array.from({ length: count }, (_, i) => `u${i + 1}`);
  for (const u of users) cash.mint(u, WALLET, `mint-${u}`);
  const events: TournamentEvent[] = [];
  const handStarts: number[] = [];
  const tour = new Tournament({ id: 'T', settings: () => settings, clock, money, onEvent: (e) => events.push(e) });
  const table = new TableActor({
    tableId: 'T',
    tournament: true,
    settings: () => tour.tableSettings(),
    clock,
    cash,
    randomProvider: seededRandom(seed),
    onEvent: (e) => {
      if (e.type === 'handStart') handStarts.push(clock.now());
      tour.onTableEvent(e);
    },
  });
  tour.attachTable(table);
  const tableBlinds = () => [Number(tour.tableSettings()['table.smallBlind']), Number(tour.tableSettings()['table.bigBlind'])];
  return { clock, ledger, money, table, tour, settings, users, events, handStarts, tableBlinds };
}

const allAccounts = (h: Harness) => [accounts.mint(), accounts.house(), accounts.fund('sezona'), accounts.fund('liga'), accounts.tournament('T'), accounts.bounty('T'), ...h.users.map(accounts.wallet)];

/** Chyba pravidel turnaje (ne programátorská) se při náhodném hraní ignoruje. */
const tryIt = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof TournamentError)) throw e;
  }
};

/** Žetony, které turnaj dosud přidělil (podle zaplacených vstupů, rebuy a add-onů). */
function granted(h: Harness): number {
  const s = h.settings;
  const chips = { turnaj_buyin: Number(s['tournament.startingStack']), turnaj_rebuy: Number(s['tournament.rebuyChips']), turnaj_addon: Number(s['tournament.addonChips']) };
  const starts = h.tour.state().players.reduce((n, p) => n + p.entries * chips.turnaj_buyin, 0);
  return starts + h.tour.state().payments.filter((p) => !p.refunded && p.kind !== 'turnaj_buyin').reduce((n, p) => n + chips[p.kind], 0);
}

async function play(h: Harness, opts: { seed: number; maxSteps?: number; chaos?: boolean }) {
  const rnd = seededRandom(opts.seed);
  const max = opts.maxSteps ?? 30_000;
  for (let step = 0; step < max && h.tour.state().status === 'running'; step++) {
    const v = h.table.viewFor(null);
    if (h.table.currentPhase() === 'hand' && v.actingSeat !== null) {
      const p = v.seats.find((s) => s.seat === v.actingSeat)!;
      const legal = h.table.viewFor(p.playerId).legal;
      if (legal && rnd() < 0.85) h.table.act(p.playerId, randomLegalAction(legal, rnd));
    }
    if (opts.chaos) {
      for (const p of h.tour.state().players) {
        const r = rnd();
        if (p.status === 'deciding') {
          if (r < 0.3) tryIt(() => h.tour.rebuy(p.userId));
          else if (r < 0.4) tryIt(() => h.tour.reenter(p.userId));
        } else if (p.status === 'out' && r < 0.02) tryIt(() => h.tour.reenter(p.userId));
        else if (p.status === 'playing' && r < 0.03) tryIt(() => h.tour.addon(p.userId));
        else if (p.status === 'playing' && r < 0.05) tryIt(() => h.tour.rebuy(p.userId));
      }
    }
    h.clock.advance(Math.floor(rnd() * 3000));
    await Promise.resolve();
    expect(h.ledger.totalIsZero(allAccounts(h))).toBe(true);
    expect(h.table.hasError()).toBeNull();
    if (h.tour.state().status === 'running') expect(h.table.totalChips()).toBe(granted(h));
    if (h.tour.state().status === 'running') {
      // Zůstatek účtu bounty = hlavy hráčů + nevylosované mystery hodnoty + nevyplacené odměny (+ případná nepřiřazená hodnota)
      const st = h.tour.state();
      const owned = st.players.reduce((n, p) => n + (p.head ?? 0) + (p.bountyUnpaid ?? 0), 0) + (st.bag ?? []).reduce((a, b) => a + b, 0);
      expect(h.money.bountyBank('T')).toBeGreaterThanOrEqual(owned);
    }
  }
  await Promise.resolve();
}

const registerAll = (h: Harness) => h.users.forEach((u) => h.tour.register(u, u));

describe('turnaj: registrace a peníze', () => {
  it('buy-in jde do prize poolu, poplatek herně; odhlášení před startem vrací vše', () => {
    const h = harness();
    h.tour.register('u1', 'u1');
    expect(h.ledger.balance(accounts.wallet('u1'))).toBe(WALLET - 110);
    expect(h.money.pool('T')).toBe(100);
    expect(h.ledger.balance(accounts.house())).toBe(10);
    expect(() => h.tour.register('u1', 'u1')).toThrow(TournamentError);
    h.tour.unregister('u1');
    expect(h.ledger.balance(accounts.wallet('u1'))).toBe(WALLET);
    expect(h.money.pool('T')).toBe(0);
    expect(h.ledger.balance(accounts.house())).toBe(0);
  });

  it('bez peněz v peněžence se hráč nepřihlásí, turnaj se nespustí pod minimem', () => {
    const h = harness({ 'tournament.buyIn': 100_000 });
    expect(() => h.tour.register('u1', 'u1')).toThrow(/INSUFFICIENT_FUNDS/);
    expect(h.tour.state().players).toHaveLength(0);
    const g = harness();
    g.tour.register('u1', 'u1');
    expect(() => g.tour.start()).toThrow(/NOT_ENOUGH_PLAYERS/);
  });

  it('plný turnaj další přihlášku odmítne a může se spustit sám', () => {
    const h = harness({ 'table.seats': 3, 'tournament.autoStartWhenFull': true }, 4);
    h.tour.register('u1', 'u1');
    h.tour.register('u2', 'u2');
    h.tour.register('u3', 'u3');
    expect(h.tour.state().status).toBe('running');
    expect(() => h.tour.register('u4', 'u4')).toThrow(TournamentError);
  });

  it('zrušení vrátí všem všechny platby včetně rebuy a add-onu', async () => {
    const h = harness({ 'tournament.rebuyEnabled': true, 'tournament.rebuyWhen': 'belowStart', 'tournament.rebuyUntilLevel': 5, 'tournament.addonEnabled': true, 'tournament.addonFromLevel': 1, 'tournament.addonUntilLevel': 3 });
    registerAll(h);
    h.tour.start();
    h.tour.addon('u1');
    h.tour.rebuy('u2');
    expect(h.money.pool('T')).toBe(6 * 100 + 200);
    h.tour.cancel();
    await Promise.resolve();
    for (const u of h.users) expect(h.ledger.balance(accounts.wallet(u))).toBe(WALLET);
    expect(h.money.pool('T')).toBe(0);
    expect(h.ledger.balance(accounts.house())).toBe(0);
    expect(h.tour.state().status).toBe('cancelled');
  });
});

const seen = { rebuy: 0, addon: 0, reentry: 0 };

describe('turnaj: průběh a výplaty (simulace s boty)', { timeout: 180_000 }, () => {
  for (const seed of [1, 2, 3]) {
    it(`freezeout, seed ${seed}: jeden vítěz, pool vyplacen do posledního haléře, žetony nikdy v knize`, async () => {
      const h = harness({}, 6, seed);
      registerAll(h);
      h.tour.start();
      await play(h, { seed });
      const st = h.tour.state();
      expect(st.status).toBe('finished');
      const res = st.results!;
      expect(res.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(res.map((r) => r.userId)).size).toBe(6);
      // standardní výplata pro 6 hráčů: 2 místa (65/35) z poolu 600
      expect(res.map((r) => r.payout)).toEqual([390, 210, 0, 0, 0, 0]);
      expect(h.money.pool('T')).toBe(0);
      expect(h.ledger.balance(accounts.house())).toBe(60);
      for (const r of res) expect(h.ledger.balance(accounts.wallet(r.userId))).toBe(WALLET - 110 + r.payout);
      // v knize jsou jen peněženky, účet turnaje, dům a mint: žádné turnajové žetony
      for (const tx of h.ledger.transactions()) for (const e of tx.entries) expect(/^(wallet:|tournament:|house$|mint$)/.test(e.account)).toBe(true);
      expect(h.events.some((e) => e.type === 'finished')).toBe(true);
      expect(h.events.filter((e) => e.type === 'eliminated')).toHaveLength(5);
      expect(h.events.filter((e) => e.type === 'bubble')).toHaveLength(1);
    });
  }

  for (const seed of [11, 12, 13, 14]) {
    it(`rebuy, add-on a re-entry, seed ${seed}: součty sedí, pool po výplatě nulový`, async () => {
      const h = harness(
        {
          'tournament.rebuyEnabled': true,
          'tournament.rebuyUntilLevel': 4,
          'tournament.rebuyCost': 100,
          'tournament.rebuyChips': 1500,
          'tournament.rebuyMax': 2,
          'tournament.rebuyDecisionSeconds': 20,
          'tournament.addonEnabled': true,
          'tournament.addonFromLevel': 4,
          'tournament.addonUntilLevel': 5,
          'tournament.addonCost': 50,
          'tournament.addonChips': 1000,
          'tournament.reentryEnabled': true,
          'tournament.reentryMax': 1,
          'tournament.lateRegLevels': 4,
          'tournament.payoutPreset': 'top3',
          'tournament.payoutRoundTo': 10,
          'tournament.payoutRemainder': 'spread',
          'tournament.breakEveryLevels': 3,
          'tournament.breakMinutes': 2,
        },
        6,
        seed,
      );
      registerAll(h);
      h.tour.start();
      await play(h, { seed, chaos: true });
      const st = h.tour.state();
      expect(st.status).toBe('finished');
      seen.rebuy += st.payments.filter((p) => p.kind === 'turnaj_rebuy').length;
      seen.addon += st.payments.filter((p) => p.kind === 'turnaj_addon').length;
      seen.reentry += st.players.filter((p) => p.entries > 1).length;
      const paidIn = st.payments.reduce((n, p) => n + poolPart(p), 0);
      const fees = st.payments.reduce((n, p) => n + p.fee, 0);
      const out = st.results!.reduce((n, r) => n + r.payout, 0);
      expect(h.money.pool('T')).toBe(0);
      expect(out).toBe(paidIn);
      expect(h.ledger.balance(accounts.house())).toBe(fees);
      expect(new Set(st.results!.map((r) => r.userId)).size).toBe(st.results!.length);
      const totalWallets = h.users.reduce((n, u) => n + h.ledger.balance(accounts.wallet(u)), 0);
      expect(totalWallets + fees).toBe(WALLET * 6);
    });
  }

  it('simulace skutečně vyzkoušely rebuy, add-on i re-entry', () => {
    expect(seen.rebuy).toBeGreaterThan(0);
    expect(seen.addon).toBeGreaterThan(0);
    expect(seen.reentry).toBeGreaterThan(0);
  });

  it('pozdní registrace: nový hráč dostane místo a startovní stack, po jejím konci už ne', async () => {
    const h = harness({ 'tournament.lateRegLevels': 2 }, 4);
    for (const u of ['u1', 'u2', 'u3']) h.tour.register(u, u);
    h.tour.start();
    expect(h.tour.lateRegOpen()).toBe(true);
    h.tour.register('u4', 'u4');
    expect(h.table.chipsOf('u4')).toBe(1500);
    expect(granted(h)).toBe(4 * 1500);
    h.clock.advance(2 * 60_000 + 1000);
    expect(h.tour.levelNumber()).toBeGreaterThanOrEqual(3);
    expect(h.tour.lateRegOpen()).toBe(false);
  });
});

describe('turnaj: odvod herně, fond a garance', { timeout: 120_000 }, () => {
  it('odvod a fond se oddělí od prize poolu, zrušení vrátí přesně to, co se vybralo', async () => {
    const h = harness({ 'tournament.houseCutPercent': 10, 'tournament.fundPercent': 5, 'tournament.fundId': 'liga', 'tournament.fee': 10 }, 4);
    registerAll(h);
    // 4 × buy-in 100: pool 85, dům 10 + poplatek 10, fond 5 — vše ×4
    expect(h.money.pool('T')).toBe(4 * 85);
    expect(h.ledger.balance(accounts.house())).toBe(4 * 20);
    expect(h.ledger.balance(accounts.fund('liga'))).toBe(4 * 5);
    h.tour.unregister('u1');
    expect(h.ledger.balance(accounts.wallet('u1'))).toBe(WALLET);
    expect(h.ledger.balance(accounts.fund('liga'))).toBe(3 * 5);
    h.tour.register('u1', 'u1');
    h.tour.start();
    h.tour.cancel();
    await Promise.resolve();
    for (const u of h.users) expect(h.ledger.balance(accounts.wallet(u))).toBe(WALLET);
    expect(h.ledger.balance(accounts.house())).toBe(0);
    expect(h.ledger.balance(accounts.fund('liga'))).toBe(0);
    expect(h.money.pool('T')).toBe(0);
  });

  it('po skončení je pool nulový a dům i fond mají svoje', async () => {
    const h = harness({ 'tournament.houseCutPercent': 10, 'tournament.fundPercent': 5, 'tournament.fee': 0 }, 5, 4);
    registerAll(h);
    h.tour.start();
    await play(h, { seed: 4 });
    const st = h.tour.state();
    expect(st.status).toBe('finished');
    expect(h.money.pool('T')).toBe(0);
    expect(h.ledger.balance(accounts.house())).toBe(5 * 10);
    expect(h.ledger.balance(accounts.fund('sezona'))).toBe(5 * 5);
    expect(st.results!.reduce((n, r) => n + r.payout, 0)).toBe(5 * 85);
  });

  it('garance: chybějící část doplní nejdřív dům, zbytek se vydá jako nová měna; výhra je z garantovaného poolu', async () => {
    const h = harness({ 'tournament.fee': 30, 'tournament.guarantee': 1000, 'tournament.payoutPreset': 'wta' }, 3, 5);
    registerAll(h);
    // vybráno 3 × 100 = 300, poplatky 90 na účtu domu; chybí 700, dům má 90
    h.tour.start();
    await play(h, { seed: 5 });
    const st = h.tour.state();
    expect(st.status).toBe('finished');
    expect(st.overlay).toBe(700);
    expect(st.results![0]!.payout).toBe(1000);
    expect(h.money.pool('T')).toBe(0);
    expect(h.ledger.balance(accounts.house())).toBe(0);
    // vydáno 610 nové měny; součet všech účtů zůstává nulový
    expect(h.ledger.balance(accounts.mint())).toBe(-(3 * WALLET) - 610);
    expect(h.ledger.totalIsZero(allAccounts(h))).toBe(true);
  });
});

describe('turnaj: matice nastavení (simulace s boty)', { timeout: 300_000 }, () => {
  const cases: { name: string; over: Record<string, number | boolean | string>; players: number; chaos?: boolean }[] = [
    { name: 'level po handách s přestávkami', over: { 'tournament.levelMode': 'hands', 'tournament.levelHands': 4, 'tournament.breakEveryLevels': 2, 'tournament.breakMinutes': 1 }, players: 5 },
    { name: 'heads-up, vítěz bere vše', over: { 'table.seats': 2, 'tournament.payoutPreset': 'wta' }, players: 2 },
    { name: 'plný desetimístný stůl, vlastní procenta', over: { 'table.seats': 10, 'tournament.payoutPreset': 'custom', 'tournament.payoutCustom': '40,30,20,10', 'tournament.payoutRoundTo': 5 }, players: 10 },
    { name: 'freeroll s garancí', over: { 'tournament.buyIn': 0, 'tournament.fee': 0, 'tournament.guarantee': 300, 'tournament.payoutPreset': 'top3' }, players: 5 },
    { name: 'odvod, fond a garance větší než pool, zbytek po jednotkách', over: { 'tournament.houseCutPercent': 12, 'tournament.fundPercent': 8, 'tournament.guarantee': 900, 'tournament.payoutRoundTo': 10, 'tournament.payoutRemainder': 'spread' }, players: 6 },
    { name: 'Fischer hodiny a zavolání času', over: { 'time.bankMode': 'fischer', 'time.timeBankSeconds': 20, 'time.incrementSeconds': 3, 'time.callClockEnabled': true }, players: 6 },
    { name: 'časové žetony a doplňování', over: { 'time.bankMode': 'chips', 'time.timeChips': 2, 'time.timeChipSeconds': 4, 'time.bankRefillEveryHands': 3 }, players: 6 },
    { name: 'rebuy, add-on, re-entry a pozdní registrace s přestávkami', over: { 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 3, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 1500, 'tournament.rebuyMax': 2, 'tournament.addonEnabled': true, 'tournament.addonFromLevel': 3, 'tournament.addonUntilLevel': 4, 'tournament.addonCost': 50, 'tournament.addonChips': 1000, 'tournament.reentryEnabled': true, 'tournament.reentryMax': 1, 'tournament.lateRegLevels': 3, 'tournament.breakEveryLevels': 2, 'tournament.breakMinutes': 1, 'tournament.houseCutPercent': 5 }, players: 7, chaos: true },
    { name: 'run it třikrát, bomb pot a ante', over: { 'special.runItTwice': true, 'special.runItTimes': 3, 'special.runItVoteSeconds': 3, 'special.bombPot': true, 'special.bombPotEveryHands': 3, 'special.bombPotAnteBb': 1, 'special.rabbitHunt': true, 'special.showCards': true, 'table.ante': 5 }, players: 6 },
    { name: 'pot limit', over: { 'table.bettingLimit': 'potLimit' }, players: 6 },
    { name: 'fixed limit', over: { 'table.bettingLimit': 'fixedLimit', 'table.limitMaxBets': 3 }, players: 5 },
    { name: 'run it dvakrát na plném stole s rebuy', over: { 'table.seats': 9, 'special.runItTwice': true, 'special.runItVoteSeconds': 3, 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 3, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 1500, 'tournament.rebuyMax': 2 }, players: 9, chaos: true },
  ];
  for (const [i, c] of cases.entries()) {
    it(`${c.name}: dohraje se, pool je nulový, součty sedí`, async () => {
      const h = harness(c.over, c.players, 100 + i);
      registerAll(h);
      h.tour.start();
      await play(h, { seed: 100 + i, chaos: c.chaos });
      const st = h.tour.state();
      expect(st.status).toBe('finished');
      expect(h.money.pool('T')).toBe(0);
      const res = st.results!;
      expect(new Set(res.map((r) => r.userId)).size).toBe(res.length);
      expect(res.map((r) => r.place)).toEqual(res.map((_, k) => k + 1));
      const paid = res.reduce((n, r) => n + r.payout, 0);
      const pooled = st.payments.reduce((n, p) => n + poolPart(p), 0);
      expect(paid).toBeGreaterThanOrEqual(pooled);
      expect(paid - pooled).toBe(st.overlay ?? 0);
      expect(h.ledger.totalIsZero(allAccounts(h))).toBe(true);
      expect(h.table.hasError()).toBeNull();
    });
  }
});

describe('turnaj: bounty', { timeout: 300_000 }, () => {
  const kinds: { name: string; over: Record<string, number | boolean | string> }[] = [
    { name: 'fixní, hned', over: { 'tournament.bountyType': 'fixed', 'tournament.bountyPercent': 30 } },
    { name: 'fixní, na konci turnaje', over: { 'tournament.bountyType': 'fixed', 'tournament.bountyPercent': 40, 'tournament.bountyPayout': 'end' } },
    { name: 'PKO 50 %', over: { 'tournament.bountyType': 'pko', 'tournament.bountyPercent': 50, 'tournament.pkoCashPercent': 50 } },
    { name: 'PKO 100 % hned (jako fixní) s dělením podle výhry', over: { 'tournament.bountyType': 'pko', 'tournament.bountyPercent': 25, 'tournament.pkoCashPercent': 100, 'tournament.bountySplit': 'byWinnings' } },
    { name: 'mystery', over: { 'tournament.bountyType': 'mystery', 'tournament.bountyPercent': 40, 'tournament.mysteryLadder': '0.5, 1, 1, 2, 5' } },
  ];
  for (const [i, k] of kinds.entries()) {
    it(`${k.name}: součty sedí, účet bounty je po skončení nulový, hráči dostanou bounty`, async () => {
      const h = harness({ ...k.over, 'tournament.fee': 10 }, 6, 200 + i);
      registerAll(h);
      h.tour.start();
      await play(h, { seed: 200 + i });
      const st = h.tour.state();
      expect(st.status).toBe('finished');
      expect(h.money.bountyBank('T')).toBe(0);
      expect(h.money.pool('T')).toBe(0);
      const part = Math.floor((100 * Number(k.over['tournament.bountyPercent'])) / 100);
      const totalBounty = part * 6;
      // všechna bounty skončila v peněženkách hráčů
      const earned = st.results!.reduce((n, r) => n + (r.bounty ?? 0), 0);
      expect(earned).toBe(totalBounty);
      const bountyTx = h.ledger.transactions().filter((t) => t.kind === 'bounty');
      const paidBack = bountyTx.reduce((n, t) => n + t.entries.filter((e) => e.account.startsWith('wallet:')).reduce((a, e) => a + e.amount, 0), 0);
      expect(paidBack).toBe(totalBounty);
      const prize = st.results!.reduce((n, r) => n + r.payout, 0);
      expect(prize).toBe((100 - part) * 6);
      expect(h.ledger.totalIsZero(allAccounts(h))).toBe(true);
      // celkově: vybráno 6 × (100 + 10) = prize pool + bounty + poplatky
      const wallets = h.users.reduce((n, u) => n + h.ledger.balance(accounts.wallet(u)), 0);
      expect(wallets + h.ledger.balance(accounts.house())).toBe(6 * WALLET);
    });
  }

  it('PKO: hlava vyřazujícího roste o nevyplacenou část', async () => {
    const h = harness({ 'tournament.bountyType': 'pko', 'tournament.bountyPercent': 50, 'tournament.pkoCashPercent': 50, 'tournament.fee': 0 }, 4, 77);
    registerAll(h);
    h.tour.start();
    const heads = () => Object.fromEntries(h.tour.state().players.map((p) => [p.userId, p.head ?? 0]));
    expect(Object.values(heads())).toEqual([50, 50, 50, 50]);
    let sawGrowth = false;
    const rnd = seededRandom(77);
    for (let i = 0; i < 20_000 && h.tour.state().status === 'running'; i++) {
      const v = h.table.viewFor(null);
      if (h.table.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((s) => s.seat === v.actingSeat)!;
        const legal = h.table.viewFor(p.playerId).legal;
        if (legal) h.table.act(p.playerId, randomLegalAction(legal, rnd));
      }
      h.clock.advance(Math.floor(rnd() * 3000));
      await Promise.resolve();
      if (Object.values(heads()).some((x) => x > 50)) sawGrowth = true;
    }
    expect(sawGrowth).toBe(true);
    expect(h.tour.state().status).toBe('finished');
  });

  it('odhlášení před startem vrací i bounty část, zrušení po vyřazeních vrací co zbylo na účtu bounty', async () => {
    const h = harness({ 'tournament.bountyType': 'fixed', 'tournament.bountyPercent': 30, 'tournament.fee': 10 }, 4, 5);
    registerAll(h);
    h.tour.unregister('u1');
    expect(h.ledger.balance(accounts.wallet('u1'))).toBe(WALLET);
    expect(h.money.bountyBank('T')).toBe(3 * 30);
    h.tour.register('u1', 'u1');
    h.tour.start();
    // pár minut hry, než někdo vypadne
    const rnd = seededRandom(5);
    for (let i = 0; i < 20_000 && h.tour.state().eliminations.length < 1 && h.tour.state().status === 'running'; i++) {
      const v = h.table.viewFor(null);
      if (h.table.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((s) => s.seat === v.actingSeat)!;
        const legal = h.table.viewFor(p.playerId).legal;
        if (legal) h.table.act(p.playerId, randomLegalAction(legal, rnd));
      }
      h.clock.advance(Math.floor(rnd() * 3000));
      await Promise.resolve();
    }
    expect(h.tour.state().eliminations.length).toBeGreaterThanOrEqual(1);
    h.tour.cancel();
    await Promise.resolve();
    expect(h.money.bountyBank('T')).toBe(0);
    expect(h.money.pool('T')).toBe(0);
    expect(h.ledger.totalIsZero(allAccounts(h))).toBe(true);
    // domu nezůstane nic z vrácených vstupů, vyplacená bounty zůstala vítězi vyřazení
    expect(h.ledger.balance(accounts.house())).toBe(0);
    const wallets = h.users.reduce((n, u) => n + h.ledger.balance(accounts.wallet(u)), 0);
    expect(wallets).toBe(4 * WALLET);
  });

  it('bounty se sčítá i s rebuy, re-entry a pozdní registrací', async () => {
    const over = { 'tournament.bountyType': 'pko', 'tournament.bountyPercent': 30, 'tournament.pkoCashPercent': 60, 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 3, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 1500, 'tournament.rebuyMax': 2, 'tournament.reentryEnabled': true, 'tournament.reentryMax': 1, 'tournament.lateRegLevels': 3, 'tournament.fee': 10 };
    for (const seed of [301, 302, 303]) {
      const h = harness(over, 6, seed);
      registerAll(h);
      h.tour.start();
      await play(h, { seed, chaos: true });
      const st = h.tour.state();
      expect(st.status).toBe('finished');
      expect(h.money.bountyBank('T')).toBe(0);
      const bountyIn = st.payments.reduce((n, p) => n + (p.bounty ?? 0), 0);
      const earned = st.results!.reduce((n, r) => n + (r.bounty ?? 0), 0);
      expect(earned).toBe(bountyIn);
      expect(h.ledger.totalIsZero(allAccounts(h))).toBe(true);
    }
  });
});

describe('turnaj: dohoda (deal)', { timeout: 300_000 }, () => {
  const DEAL = { 'tournament.dealEnabled': true, 'tournament.dealMaxPlayers': 4, 'tournament.dealVoteSeconds': 30, 'tournament.dealCooldownSeconds': 60 };
  const started = (over: Record<string, number | boolean | string> = {}, players = 4, seed = 1) => {
    const h = harness({ ...DEAL, ...over }, players, seed);
    registerAll(h);
    h.tour.start();
    return h;
  };
  const voteAll = (h: Harness, yes = true) => {
    for (const u of h.users) {
      try {
        h.tour.voteDeal(u, yes);
      } catch (e) {
        if (!(e instanceof TournamentError)) throw e;
      }
    }
  };

  it('dohoda rovným dílem ukončí turnaj: každý dostane stejně, pool je nulový, součty sedí', async () => {
    const h = started();
    expect(h.tour.dealBlocker()).toBeNull();
    const opt = h.tour.dealOptions('u1');
    expect(opt.total).toBe(400);
    expect(opt.methods.equal).toEqual({ u1: 100, u2: 100, u3: 100, u4: 100 });
    h.tour.proposeDeal('u1', { method: 'equal' });
    expect(h.tour.state().status).toBe('running');
    voteAll(h);
    await Promise.resolve();
    const st = h.tour.state();
    expect(st.status).toBe('finished');
    expect(st.results!.map((r) => r.payout)).toEqual([100, 100, 100, 100]);
    expect(h.money.pool('T')).toBe(0);
    expect(h.ledger.totalIsZero(allAccounts(h))).toBe(true);
    for (const u of h.users) expect(h.ledger.balance(accounts.wallet(u))).toBe(WALLET - 110 + 100);
    expect(h.events.some((e) => e.type === 'dealAccepted')).toBe(true);
  });

  it('jediné ne dohodu zamítne, pak platí pauza mezi návrhy', async () => {
    const h = started();
    h.tour.proposeDeal('u1', { method: 'chipChop' });
    h.tour.voteDeal('u2', true);
    h.tour.voteDeal('u3', false);
    expect(h.tour.state().status).toBe('running');
    expect(h.tour.dealBlocker()).toBe('DEAL_COOLDOWN');
    expect(() => h.tour.proposeDeal('u2', { method: 'equal' })).toThrow(/DEAL_COOLDOWN/);
    h.clock.advance(61_000);
    expect(h.tour.dealBlocker()).toBeNull();
    h.tour.proposeDeal('u2', { method: 'equal' });
    expect(h.tour.dealBlocker()).toBe('DEAL_ACTIVE');
  });

  it('kdo neodpoví do limitu, nesouhlasí', () => {
    const h = started();
    h.tour.proposeDeal('u1', { method: 'equal' });
    h.tour.voteDeal('u2', true);
    h.tour.voteDeal('u3', true);
    h.clock.advance(31_000);
    expect(h.tour.state().status).toBe('running');
    expect(h.tour.dealOptions('u1').vote!.status).toBe('expired');
    expect(h.events.some((e) => e.type === 'dealRejected')).toBe(true);
  });

  it('část ponechaná na hru: dohoda platí, hraje se dál a vítěz dostane svůj díl i ponechanou částku', async () => {
    const h = started({ 'tournament.dealKeepMaxPercent': 25, 'tournament.payoutRoundTo': 1 });
    const opt = h.tour.dealOptions('u1');
    expect(opt.keepMax).toBe(100);
    expect(() => h.tour.proposeDeal('u1', { method: 'equal', keep: 101 })).toThrow(/DEAL_INVALID/);
    h.tour.proposeDeal('u1', { method: 'equal', keep: 100 });
    voteAll(h);
    expect(h.tour.state().status).toBe('running');
    expect(h.tour.state().deal).toMatchObject({ keep: 100, method: 'equal' });
    expect(h.tour.state().deal!.amounts).toEqual({ u1: 75, u2: 75, u3: 75, u4: 75 });
    expect(h.tour.dealBlocker()).toBe('DEAL_DONE');
    await play(h, { seed: 9 });
    const st = h.tour.state();
    expect(st.status).toBe('finished');
    const pays = st.results!.map((r) => r.payout).sort((x, y) => y - x);
    expect(pays).toEqual([175, 75, 75, 75]);
    expect(h.money.pool('T')).toBe(0);
    expect(h.ledger.totalIsZero(allAccounts(h))).toBe(true);
  });

  it('ICM dává velkému stacku víc než rovný díl, ale míň než chip chop', () => {
    const h = started({ 'tournament.payoutPreset': 'top3' }, 3);
    // upravit žetony: u1 velký, ostatní malé
    const t = h.table as unknown as { seats: Map<string, { chips: number }> };
    t.seats.get('u1')!.chips = 3500;
    t.seats.get('u2')!.chips = 700;
    t.seats.get('u3')!.chips = 300;
    const o = h.tour.dealOptions('u1');
    expect(o.methods.icm!.u1!).toBeGreaterThan(o.methods.equal!.u1!);
    expect(o.methods.icm!.u1!).toBeLessThan(o.methods.chipChop!.u1!);
    for (const m of ['icm', 'chipChop', 'equal'] as const) expect(Object.values(o.methods[m]!).reduce((a, b) => a + b, 0)).toBe(o.total);
  });

  it('vlastní částky: kontrola součtu; vyřazení hráče během hlasování návrh zruší', async () => {
    const h = started();
    expect(() => h.tour.proposeDeal('u1', { method: 'custom', custom: { u1: 200, u2: 100, u3: 100, u4: 1 } })).toThrow(/DEAL_INVALID/);
    h.tour.proposeDeal('u1', { method: 'custom', custom: { u1: 250, u2: 50, u3: 50, u4: 50 } });
    expect(h.tour.dealOptions('u1').vote!.status).toBe('open');
    // simulace: hra pokračuje, dokud někdo nevypadne
    const rnd = seededRandom(3);
    for (let i = 0; i < 20_000 && h.tour.state().eliminations.length === 0 && h.tour.state().status === 'running'; i++) {
      const v = h.table.viewFor(null);
      if (h.table.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((x) => x.seat === v.actingSeat)!;
        const legal = h.table.viewFor(p.playerId).legal;
        if (legal) h.table.act(p.playerId, randomLegalAction(legal, rnd));
      }
      h.clock.advance(Math.floor(rnd() * 800));
      await Promise.resolve();
    }
    if (h.tour.state().eliminations.length > 0) {
      const vote = h.tour.dealOptions('u1').vote;
      expect(vote === null || vote.status !== 'open').toBe(true);
    }
  });

  it('dohodu zablokuje rebuy, pozdní registrace i počet hráčů; vypnutá dohoda', () => {
    const rebuy = started({ 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 2 });
    expect(rebuy.tour.dealBlocker()).toBe('DEAL_WINDOWS_OPEN');
    const late = started({ 'tournament.lateRegLevels': 2 });
    expect(late.tour.dealBlocker()).toBe('DEAL_WINDOWS_OPEN');
    const many = started({ 'tournament.dealMaxPlayers': 3 });
    expect(many.tour.dealBlocker()).toBe('DEAL_PLAYERS');
    const off = started({ 'tournament.dealEnabled': false });
    expect(off.tour.dealBlocker()).toBe('DEAL_DISABLED');
    expect(() => many.tour.proposeDeal('u1', { method: 'equal' })).toThrow(/DEAL_PLAYERS/);
    expect(() => started().tour.proposeDeal('nobody', { method: 'equal' })).toThrow(/FORBIDDEN/);
  });

  it('dohoda s PKO bounty: zbývající hlavy se vyplatí zbývajícím a účet bounty je nulový', async () => {
    const h = started({ 'tournament.bountyType': 'pko', 'tournament.bountyPercent': 40, 'tournament.pkoCashPercent': 50 });
    h.tour.proposeDeal('u1', { method: 'equal' });
    voteAll(h);
    await Promise.resolve();
    expect(h.tour.state().status).toBe('finished');
    expect(h.money.bountyBank('T')).toBe(0);
    const earned = h.tour.state().results!.reduce((n, r) => n + (r.bounty ?? 0), 0);
    expect(earned).toBe(4 * 40);
    expect(h.ledger.totalIsZero(allAccounts(h))).toBe(true);
  });

  it('návrh organizátora (bez hráče) nemá automatický souhlas', () => {
    const h = started();
    h.tour.proposeDeal(null, { method: 'equal' });
    const v = h.tour.dealOptions('u1').vote!;
    expect(v.proposer).toBeNull();
    expect(v.voters.every((x) => !x.voted)).toBe(true);
  });
});

describe('turnaj: hodiny a přestávky', () => {
  it('level roste podle času, přestávka zastaví rozdávání a hodiny, pauza zmrazí čas', () => {
    const h = harness({ 'tournament.structure': '10/20, 20/40, 30/60, 40/80', 'tournament.breakEveryLevels': 2, 'tournament.breakMinutes': 3 }, 3);
    registerAll(h);
    h.tour.start();
    expect(h.tour.currentLevel()).toEqual({ smallBlind: 10, bigBlind: 20, ante: 0 });
    expect(h.tableBlinds()).toEqual([10, 20]);
    h.clock.advance(60_000);
    expect(h.tour.levelNumber()).toBe(2);
    expect(h.tableBlinds()).toEqual([20, 40]);
    // konec 2. levelu = přestávka (rozdávání stojí, level se nemění)
    h.clock.advance(60_000);
    expect(h.tour.state().onBreak).toBe(true);
    expect(h.tour.levelNumber()).toBe(2);
    const startsBefore = h.handStarts.length;
    h.clock.advance(2 * 60_000);
    expect(h.handStarts.length).toBeLessThanOrEqual(startsBefore + 1);
    h.clock.advance(60_000 + 100);
    expect(h.tour.state().onBreak).toBe(false);
    expect(h.tour.levelNumber()).toBe(3);
    // pauza zmrazí hodiny
    const left = h.tour.clockRemainingMs()!;
    h.tour.pause();
    h.clock.advance(10 * 60_000);
    expect(h.tour.clockRemainingMs()).toBe(left);
    h.tour.resume();
    h.clock.advance(left + 10);
    expect(h.tour.levelNumber()).toBe(4);
    // konec 4. levelu = přestávka (i za posledním zadaným levelem); pak se blindy dál zdvojnásobují (turnaj se vždy dohraje)
    h.clock.advance(60_000 + 10);
    expect(h.tour.state().onBreak).toBe(true);
    h.clock.advance(3 * 60_000 + 10);
    expect(h.tour.levelNumber()).toBe(5);
    expect(h.tour.currentLevel()).toEqual({ smallBlind: 80, bigBlind: 160, ante: 0 });
    expect(h.tableBlinds()).toEqual([80, 160]);
  });

  it('přestávka jen jednou: po N-tém levelu, pak už ne', () => {
    const h = harness({ 'tournament.structure': '10/20, 20/40, 30/60, 40/80, 50/100', 'tournament.breakEveryLevels': 2, 'tournament.breakMinutes': 3, 'tournament.breakRepeat': false }, 3);
    registerAll(h);
    h.tour.start();
    h.clock.advance(2 * 60_000 + 10);
    expect(h.tour.state().onBreak).toBe(true);
    h.clock.advance(3 * 60_000 + 10);
    expect(h.tour.levelNumber()).toBe(3);
    h.clock.advance(2 * 60_000 + 10);
    expect(h.tour.state().onBreak).toBe(false);
    expect(h.tour.levelNumber()).toBe(5);
  });

  it('level podle počtu hand', async () => {
    const h = harness({ 'tournament.structure': '10/20, 20/40, 30/60', 'tournament.levelMode': 'hands', 'tournament.levelHands': 3 }, 3);
    registerAll(h);
    h.tour.start();
    const hands = () => h.events.filter((e) => e.type === 'level').length;
    expect(hands()).toBe(1);
    for (let i = 0; i < 4000 && h.tour.levelNumber() < 2 && h.tour.state().status === 'running'; i++) {
      const v = h.table.viewFor(null);
      if (h.table.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((s) => s.seat === v.actingSeat)!;
        h.table.act(p.playerId, { type: 'fold' });
      }
      h.clock.advance(300);
    }
    expect(h.tour.levelNumber()).toBe(2);
  });

  it('chybná struktura a výplaty se odmítnou při ověření', () => {
    expect(() => harness({ 'tournament.structure': '50/25' }).tour.validate()).toThrow(/BAD_STRUCTURE/);
    expect(() => harness({ 'tournament.payoutPreset': 'custom', 'tournament.payoutCustom': '50,30' }).tour.validate()).toThrow(/BAD_PAYOUT/);
    expect(() => harness().tour.validate()).not.toThrow();
  });
});
