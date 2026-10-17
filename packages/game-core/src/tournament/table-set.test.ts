import { describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger, TournamentMoney } from '@kb/ledger';
import { createDefaultRegistry, resolveSettings, type SettingValues } from '@kb/shared';
import { randomLegalAction, seededRandom } from '../bot.js';
import { FakeClock } from '../clock.js';
import { TableActor } from '../table-actor.js';
import { TournamentTableSet, type TableSetEvent } from './table-set.js';
import { Tournament } from './tournament.js';

const reg = createDefaultRegistry();

interface H {
  clock: FakeClock;
  ledger: Ledger;
  tour: Tournament;
  set: TournamentTableSet;
  actors: Map<string, TableActor>;
  users: string[];
  events: TableSetEvent[];
  settings: SettingValues;
}

function harness(over: Record<string, number | boolean | string> = {}, players = 9, seed = 1): H {
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
        'table.seats': 3,
        'tournament.maxTables': 4,
        'tournament.buyIn': 100,
        'tournament.fee': 0,
        'tournament.startingStack': 1500,
        'tournament.levelMinutes': 1,
        'tournament.targetMinutes': 20,
        'tournament.minPlayers': 2,
        ...over,
      },
    },
  ]).values;
  const users = Array.from({ length: players }, (_, i) => `u${i + 1}`);
  for (const u of users) cash.mint(u, 10_000, `mint-${u}`);
  const actors = new Map<string, TableActor>();
  const events: TableSetEvent[] = [];
  const tourRef: { current?: Tournament } = {};
  const setRef: { current?: TournamentTableSet } = {};
  let n = 0;
  const set = new TournamentTableSet({
    tournamentId: 'T',
    seatsPerTable: () => Number(settings['table.seats']),
    maxTables: () => Number(settings['tournament.maxTables']),
    balanceMaxDiff: () => Number(settings['tournament.balanceMaxDiff']),
    handForHand: () => !!settings['tournament.handForHand'],
    handForHandActive: () => !!tourRef.current?.handForHandActive(),
    createTable: (id) => {
      const actor = new TableActor({
        tableId: id,
        tournament: true,
        tournamentId: 'T',
        settings: () => tourRef.current!.tableSettings(),
        clock,
        cash,
        randomProvider: seededRandom(seed * 100 + n++),
        onEvent: (e) => tourRef.current!.onTableEvent(e, { lead: setRef.current!.isLead(id) }),
        onBoundary: () => setRef.current!.onBoundary(id),
      });
      actors.set(id, actor);
      return actor;
    },
    destroyTable: (id) => void actors.delete(id),
    onTablesChanged: (ids) => tourRef.current?.recordTables(ids),
    onEvent: (e) => events.push(e),
  });
  setRef.current = set;
  const tour = new Tournament({ id: 'T', settings: () => settings, clock, money });
  tourRef.current = tour;
  set.init();
  tour.attachTable(set);
  return { clock, ledger, tour, set, actors, users, events, settings };
}

const granted = (h: H) => h.tour.state().players.reduce((n, p) => n + p.entries * Number(h.settings['tournament.startingStack']), 0);

/** Součet žetonů u všech stolů + hráči, kteří už vypadli, mají nula. */
const onTables = (h: H) => [...h.actors.values()].reduce((n, a) => n + a.totalChips(), 0);

async function play(h: H, seed: number, check: () => void, maxSteps = 60_000) {
  const rnd = seededRandom(seed);
  for (let step = 0; step < maxSteps && h.tour.state().status === 'running'; step++) {
    for (const actor of h.actors.values()) {
      const v = actor.viewFor(null);
      if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((s) => s.seat === v.actingSeat)!;
        const legal = actor.viewFor(p.playerId).legal;
        if (legal && rnd() < 0.85) actor.act(p.playerId, randomLegalAction(legal, rnd));
      }
    }
    h.clock.advance(Math.floor(rnd() * 3000));
    await Promise.resolve();
    check();
  }
  await Promise.resolve();
}

function invariants(h: H) {
  const seen = new Set<string>();
  for (const [id, a] of h.actors) {
    expect(a.hasError()).toBeNull();
    const seated = a.playersSeated();
    expect(seated.length).toBeLessThanOrEqual(Number(h.settings['table.seats']));
    for (const s of seated) {
      expect(seen.has(s.userId), `hráč ${s.userId} sedí u dvou stolů (${id})`).toBe(false);
      seen.add(s.userId);
    }
  }
  if (h.tour.state().status === 'running') expect(onTables(h)).toBe(granted(h));
}

describe('turnaj na více stolech', { timeout: 120_000 }, () => {
  it('rozsadí vyváženě, hraje se na víc stolech a sejde se do finálového stolu s jedním vítězem', async () => {
    const h = harness();
    for (const u of h.users) h.tour.register(u, u);
    h.tour.start();
    expect(h.set.tableCount()).toBe(3);
    const sizes = [...h.actors.values()].map((a) => a.playersSeated().length).sort();
    expect(sizes).toEqual([3, 3, 3]);
    expect(h.tour.state().tableIds).toEqual(['T', 'T~2', 'T~3']);
    expect(h.tour.state().players.every((p) => p.tableId && p.seat !== undefined)).toBe(true);

    let maxDiff = 0;
    await play(h, 7, () => {
      invariants(h);
      const counts = [...h.actors.values()].map((a) => a.playersSeated().filter((s) => s.mode !== 'leaving').length);
      if (counts.length > 1 && h.tour.state().status === 'running') maxDiff = Math.max(maxDiff, Math.max(...counts) - Math.min(...counts));
    });
    expect(h.tour.state().status).toBe('finished');
    expect(h.tour.state().results!.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(h.events.some((e) => e.type === 'tableBroken')).toBe(true);
    expect(h.events.filter((e) => e.type === 'finalTable')).toHaveLength(1);
    expect(maxDiff).toBeLessThanOrEqual(3);
    expect(h.ledger.totalIsZero([accounts.mint(), accounts.house(), accounts.tournament('T'), accounts.bounty('T'), ...h.users.map(accounts.wallet)])).toBe(true);
    expect(h.ledger.balance(accounts.tournament('T'))).toBe(0);
  });

  it('více náhodných turnajů: žetony se neztratí, nikdo nesedí u dvou stolů, vždy vyjde jeden vítěz', async () => {
    for (const seed of [2, 3, 4, 5]) {
      const h = harness({ 'tournament.payoutPreset': 'wta' }, 7 + (seed % 4), seed);
      for (const u of h.users) h.tour.register(u, u);
      h.tour.start();
      await play(h, seed * 11, () => invariants(h));
      expect(h.tour.state().status).toBe('finished');
      expect(h.tour.state().results).toHaveLength(h.users.length);
      expect(h.ledger.balance(accounts.tournament('T'))).toBe(0);
    }
  });

  it('jednostolový turnaj (výchozí) zůstává jeden stůl bez přesazování', async () => {
    const h = harness({ 'tournament.maxTables': 1, 'table.seats': 6 }, 5);
    for (const u of h.users) h.tour.register(u, u);
    h.tour.start();
    expect(h.set.tableCount()).toBe(1);
    expect(h.tour.state().tableIds).toBeUndefined();
    await play(h, 5, () => invariants(h));
    expect(h.tour.state().status).toBe('finished');
    expect(h.events.filter((e) => e.type !== 'seated')).toEqual([]);
  });

  it('pozdní registrace usadí hráče k nejméně obsazenému stolu a přidá stůl, když jsou plné', () => {
    const h = harness({ 'tournament.lateRegLevels': 5 }, 8);
    for (const u of h.users.slice(0, 6)) h.tour.register(u, u);
    h.tour.start();
    expect(h.set.tableCount()).toBe(2);
    h.tour.register('u7', 'u7');
    h.tour.register('u8', 'u8');
    const counts = [...h.actors.values()].map((a) => a.playersSeated().length).sort();
    expect(counts).toEqual([2, 3, 3]);
    expect(h.set.tableCount()).toBe(3);
  });

  it('hand-for-hand: na bublině se stoly zadrží, dokud nedohrají všechny', async () => {
    const h = harness({ 'tournament.payoutPreset': 'top3', 'tournament.handForHand': true }, 9, 9);
    for (const u of h.users) h.tour.register(u, u);
    h.tour.start();
    let seenHfh = false;
    await play(h, 13, () => {
      invariants(h);
      if (h.events.some((e) => e.type === 'handForHand' && e.active)) seenHfh = true;
    });
    expect(h.tour.state().status).toBe('finished');
    expect(seenHfh).toBe(true);
    expect(h.events.some((e) => e.type === 'handForHand' && !e.active)).toBe(true);
  });

  it('vypnutý hand-for-hand ho nikdy nezapne', async () => {
    const h = harness({ 'tournament.payoutPreset': 'top3', 'tournament.handForHand': false }, 9, 9);
    for (const u of h.users) h.tour.register(u, u);
    h.tour.start();
    await play(h, 13, () => invariants(h));
    expect(h.events.some((e) => e.type === 'handForHand')).toBe(false);
  });
});
