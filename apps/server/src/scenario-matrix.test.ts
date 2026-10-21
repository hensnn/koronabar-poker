import { afterEach, describe, expect, it } from 'vitest';
import { accounts } from '@kb/ledger';
import { FakeClock, GameError, randomLegalAction, seededRandom } from '@kb/game-core';
import { buildServer } from './app.js';

// Odehrané scénáře: různé druhy her a jejich kombinace přes celý server (stoly, turnaje, kniha, chat, přehled výsledků).

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const FAST = { 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.runItDelayMs': 100, 'time.turnSeconds': 5, 'odds.enabled': false };
const START = 10_000;

async function start() {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 4), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': START, 'system.mailRequestsPerHour': 10_000 },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const everyone: string[] = [admin!];
  const names = new Map<string, string>();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `S${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    everyone.push(userId);
    names.set(userId, nick);
    return userId;
  };
  return { server, clock, admin: admin!, user, everyone, names };
}

/** Celá historie kanálu po stránkách (jedna stránka má nejvýš 200 zpráv). */
async function allMessages(server: Server, userId: string, channelId: string) {
  const out: Awaited<ReturnType<Server['chat']['history']>> = [];
  let before: number | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await server.chat.history(userId, channelId, { before, limit: 200 });
    if (page.length === 0) break;
    out.push(...page);
    before = Math.min(...page.map((m) => m.id));
  }
  return out;
}

const ids = (everyone: string[], extra: string[] = []) => [accounts.mint(), accounts.house(), accounts.fund('jackpot'), accounts.fund('sezona'), accounts.fund('liga'), ...everyone.map(accounts.wallet), ...extra];

interface Scenario {
  name: string;
  template: string;
  players: number;
  over: Record<string, number | boolean | string>;
  /** Hráči po vypadnutí nahodile dokupují (rebuy, add-on, re-entry). */
  chaos?: boolean;
  /** Pevné semínko nahodilého průběhu (jinak podle pořadí scénáře). */
  seed?: number;
}

const BASE = { ...FAST, 'tournament.startingStack': 600, 'tournament.buyIn': 100, 'tournament.fee': 10, 'tournament.minPlayers': 2, 'tournament.levelMinutes': 1, 'tournament.targetMinutes': 15 };

const TOURNAMENTS: Scenario[] = [
  { name: 'fixní bounty', template: 'tour-turbo', players: 5, over: { 'tournament.bountyType': 'fixed', 'tournament.bountyPercent': 30 } },
  { name: 'PKO', template: 'tour-turbo', players: 5, over: { 'tournament.bountyType': 'pko', 'tournament.bountyPercent': 50 } },
  { name: 'mystery bounty', template: 'tour-turbo', players: 5, over: { 'tournament.bountyType': 'mystery', 'tournament.bountyPercent': 40 } },
  { name: 'rebuy, add-on, re-entry a pozdní registrace', template: 'tour-turbo', players: 5, chaos: true, over: { 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 4, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 600, 'tournament.rebuyMax': 2, 'tournament.addonEnabled': true, 'tournament.addonFromLevel': 2, 'tournament.addonUntilLevel': 4, 'tournament.addonCost': 50, 'tournament.addonChips': 400, 'tournament.reentryEnabled': true, 'tournament.reentryMax': 1, 'tournament.lateRegLevels': 2 } },
  { name: 'rebuy s PKO', template: 'tour-turbo', players: 5, chaos: true, over: { 'tournament.bountyType': 'pko', 'tournament.bountyPercent': 50, 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 3, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 600, 'tournament.rebuyMax': 1 } },
  { name: 'run it třikrát, bomb pot, ante', template: 'tour-turbo', players: 5, over: { 'special.runItTwice': true, 'special.runItTimes': 3, 'special.runItVoteSeconds': 5, 'special.bombPot': true, 'special.bombPotEveryHands': 3, 'special.bombPotAnteBb': 1 } },
  { name: 'pot limit', template: 'tour-turbo', players: 4, over: { 'table.bettingLimit': 'potLimit' } },
  { name: 'fixed limit', template: 'tour-turbo', players: 4, over: { 'table.bettingLimit': 'fixedLimit', 'table.limitMaxBets': 3 } },
  { name: 'vítěz bere vše', template: 'tour-wta', players: 5, over: {} },
  { name: 'garance, odvod herně a fond', template: 'tour-turbo', players: 5, over: { 'tournament.guarantee': 900, 'tournament.houseCutPercent': 10, 'tournament.fundPercent': 5, 'tournament.payoutRoundTo': 10 } },
  { name: 'freeroll', template: 'tour-freeroll', players: 5, over: { 'tournament.buyIn': 0, 'tournament.fee': 0, 'tournament.guarantee': 300 } },
  // Dva hráči s rebuy: součet zisků hráčů nesmí být kladný (nikdo nesmí vydělat na cizích vkladech navíc); dohrává se několik různých nahodilých průběhů.
  ...[1, 2, 3, 4, 5, 6].map((k): Scenario => ({ name: `dva hráči, rebuy (průběh ${k})`, template: 'tour-turbo', players: 2, chaos: true, seed: 5000 + k, over: { 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 4, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 600, 'tournament.rebuyMax': 2 } })),
  { name: 'dva hráči, rebuy, add-on a fixní bounty', template: 'tour-turbo', players: 2, chaos: true, seed: 6001, over: { 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 4, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 600, 'tournament.rebuyMax': 2, 'tournament.addonEnabled': true, 'tournament.addonFromLevel': 2, 'tournament.addonUntilLevel': 4, 'tournament.addonCost': 50, 'tournament.addonChips': 400, 'tournament.bountyType': 'fixed', 'tournament.bountyPercent': 30 } },
  { name: 'tři hráči, rebuy a PKO', template: 'tour-turbo', players: 3, chaos: true, seed: 6002, over: { 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 4, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 600, 'tournament.rebuyMax': 2, 'tournament.bountyType': 'pko', 'tournament.bountyPercent': 40 } },
  { name: 'heads-up s bounty', template: 'tour-headsup', players: 2, over: { 'tournament.bountyType': 'fixed', 'tournament.bountyPercent': 50 } },
];

describe('odehrané scénáře: turnaje', { timeout: 900_000 }, () => {
  // Stejné scénáře jednou z jejich vestavěných šablon a jednou z prázdného základu „vlastní nastavení“ (vše dolaďuje podrobné nastavení).
  for (const forced of [null, 'tour-vlastni'] as const)
  it(`každý scénář se dohraje, peníze sedí a přehled výsledků souhlasí s peněženkami (${forced ?? 'jejich šablony'})`, async () => {
    const s = await start();
    const org = await s.user('organizator');
    const pool: string[] = [];
    for (let i = 0; i < 6; i++) pool.push(await s.user());
    const problems: string[] = [];
    for (const [k, sc] of TOURNAMENTS.entries()) {
      const players = pool.slice(0, sc.players);
      const before = new Map(players.map((p) => [p, s.server.ledger.balance(accounts.wallet(p))]));
      const outsideBefore = s.server.ledger.balance(accounts.house()) + s.server.ledger.balance(accounts.fund('jackpot')) + s.server.ledger.balance(accounts.fund('sezona')) + s.server.ledger.balance(accounts.fund('liga')) + s.server.ledger.balance(accounts.mint());
      let id: string;
      try {
        ({ id } = await s.server.tournaments.create(org, { name: `Scénář ${k}`, templateId: forced ?? sc.template, settings: { ...BASE, ...sc.over } }));
      } catch (e) {
        problems.push(`${sc.name}: nelze založit (${(e as { code?: string }).code ?? e})`);
        continue;
      }
      for (const p of players) await s.server.tournaments.register(p, id);
      if (s.server.tournaments.get(id)!.state().status === 'registering') await s.server.tournaments.start(org, id);
      const actor = s.server.tables.actors.get(id)!;
      const rnd = seededRandom(sc.seed ?? 700 + k);
      for (let i = 0; i < 40_000 && s.server.tournaments.get(id)!.state().status === 'running'; i++) {
        const v = actor.viewFor(null);
        if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
          const p = v.seats.find((x) => x.seat === v.actingSeat)!;
          const legal = actor.viewFor(p.playerId).legal;
          if (legal && rnd() < 0.85) actor.act(p.playerId, randomLegalAction(legal, rnd));
        }
        const vote = v.vote;
        if (vote?.status === 'open') for (const voter of vote.voters) if (rnd() < 0.5) try { actor.voteRunIt(voter.userId, rnd() < 0.7); } catch { /* už rozhodnuto */ }
        if (sc.chaos) {
          for (const pl of s.server.tournaments.get(id)!.state().players) {
            const r = rnd();
            try {
              if (pl.status === 'deciding' && r < 0.3) await s.server.tournaments.rebuy(pl.userId, id);
              else if (pl.status === 'deciding' && r < 0.4) await s.server.tournaments.reenter(pl.userId, id);
              else if (pl.status === 'playing' && r < 0.01) await s.server.tournaments.addon(pl.userId, id);
            } catch {
              /* nelze */
            }
          }
        }
        s.clock.advance(Math.floor(rnd() * 3000));
        await Promise.resolve();
      }
      await Promise.resolve();
      const view = await s.server.tournaments.view(id, players[0]!);
      if (view.status !== 'finished') {
        problems.push(`${sc.name}: turnaj se nedohrál (stav ${view.status})`);
        continue;
      }
      if (actor.hasError()) problems.push(`${sc.name}: stůl skončil chybou`);
      if (s.server.ledger.balance(accounts.tournament(id)) !== 0) problems.push(`${sc.name}: pool není nulový`);
      if (!s.server.ledger.totalIsZero(ids(s.everyone, [accounts.tournament(id), accounts.bounty(id)]))) problems.push(`${sc.name}: kniha nesedí`);
      if (!view.summary || view.summary.length !== view.results!.length) problems.push(`${sc.name}: chybí přehled výsledků`);
      for (const row of (view.summary ?? []).filter((r) => players.includes(r.userId))) {
        const delta = s.server.ledger.balance(accounts.wallet(row.userId)) - before.get(row.userId)!;
        if (delta !== row.profit) problems.push(`${sc.name}: zisk ${s.names.get(row.userId)} v přehledu ${row.profit}, v peněžence ${delta}`);
      }
      // Součet zisků hráčů je přesně to, co ubylo domu, fondům a zásobě měny (bez garance se nic nevydává), takže nemůže být kladný.
      const outsideAfter = s.server.ledger.balance(accounts.house()) + s.server.ledger.balance(accounts.fund('jackpot')) + s.server.ledger.balance(accounts.fund('sezona')) + s.server.ledger.balance(accounts.fund('liga')) + s.server.ledger.balance(accounts.mint());
      const sumProfit = (view.summary ?? []).filter((r) => players.includes(r.userId)).reduce((n, r) => n + r.profit, 0);
      if (sumProfit !== outsideBefore - outsideAfter) problems.push(`${sc.name}: součet zisků hráčů ${sumProfit} nesedí s dům/fondy/zásoba ${outsideBefore - outsideAfter}`);
      if (!sc.over['tournament.guarantee'] && sumProfit > 0) problems.push(`${sc.name}: součet zisků hráčů je kladný (${sumProfit})`);
      for (const row of view.summary ?? []) {
        if (row.spent !== row.entryAmount + row.rebuyAmount + row.addonAmount) problems.push(`${sc.name}: rozpis nákladů ${s.names.get(row.userId)} nesedí se součtem`);
        if (row.profit !== row.payout + row.bounty - row.spent) problems.push(`${sc.name}: zisk ${s.names.get(row.userId)} nesedí s výhra + bounty − zaplaceno`);
      }
      const channelId = await s.server.chat.channelIdByKey('table:' + id);
      const msgs = channelId ? (await allMessages(s.server, s.admin, channelId)).map((m) => m.body) : [];
      if (!msgs.some((m) => m.startsWith('Handa č.'))) problems.push(`${sc.name}: v chatu nejsou výsledky hand`);
      if (!msgs.some((m) => m.includes('Turnaj skončil'))) problems.push(`${sc.name}: v chatu chybí konec turnaje`);
    }
    expect(problems).toEqual([]);
  });
});

const CASH: { name: string; over: Record<string, number | boolean | string> }[] = [
  { name: 'no limit, vše zapnuto', over: { 'table.bettingLimit': 'noLimit', 'table.ante': 1, 'special.runItTwice': true, 'special.runItTimes': 3, 'special.runItVoteSeconds': 5, 'special.sevenTwoBonus': true, 'special.sevenTwoAmountBb': 1, 'special.bombPot': true, 'special.bombPotEveryHands': 4, 'special.rabbitHunt': true, 'special.showCards': true, 'rake.enabled': true, 'rake.percent': 5, 'rake.cap': 5, 'rake.jackpotPercent': 40, 'jackpot.royalFlushEnabled': true, 'jackpot.badBeatEnabled': true } },
  { name: 'pot limit s rake', over: { 'table.bettingLimit': 'potLimit', 'rake.enabled': true, 'rake.percent': 8, 'rake.cap': 3 } },
  { name: 'fixed limit se straddlem', over: { 'table.bettingLimit': 'fixedLimit', 'table.limitMaxBets': 3, 'table.straddleEnabled': true } },
  { name: 'rake s jackpotem, rakebackem, high hand, bad beat a royal flush', over: { 'rake.enabled': true, 'rake.percent': 10, 'rake.cap': 5, 'rake.jackpotPercent': 20, 'rake.rakebackPercent': 15, 'jackpot.highHandEnabled': true, 'jackpot.highHandMinutes': 1, 'jackpot.highHandPercent': 50, 'jackpot.royalFlushEnabled': true, 'jackpot.royalFlushPercent': 60, 'jackpot.badBeatEnabled': true, 'jackpot.badBeatMinHand': 'quads' } },
  { name: 'ante, povinný straddle a sedm-dva bonus', over: { 'table.ante': 2, 'table.straddleEnabled': true, 'table.straddleMandatory': true, 'special.sevenTwoBonus': true, 'special.sevenTwoAmountBb': 1, 'special.sevenTwoNeedsShowdown': false } },
  { name: 'bez raku, dokupování a rebuy povolené', over: { 'rake.enabled': false, 'cash.topUpEnabled': true, 'cash.rebuyEnabled': true } },
  { name: 'rychlé časy a time bank', over: { 'time.turnSeconds': 3, 'time.timeBankSeconds': 4, 'time.timeoutsToSitOut': 2, 'time.callClockEnabled': true } },
];

describe('odehrané scénáře: cash stoly', { timeout: 600_000 }, () => {
  it('každá kombinace nastavení: peníze sedí, stůl nechybuje, výsledky hand jsou v chatu', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const users: string[] = [];
    for (let i = 0; i < 5; i++) users.push(await s.user());
    const problems: string[] = [];
    for (const [k, sc] of CASH.entries()) {
      // Hráči mezi scénáři prohrávají a rake odchází domu: před každým scénářem se jim peněženka doplní na výchozí zůstatek, aby se vždy mohli posadit.
      for (const u of users) {
        const missing = START - s.server.ledger.balance(accounts.wallet(u));
        if (missing > 0) await s.server.wallet.topUp(s.admin, u, missing, 'doplnění mezi scénáři');
      }
      let id: string;
      try {
        ({ id } = await s.server.tables.createTable(org, { name: `Cash scénář ${k}`, templateId: 'cash-klasika', settings: { ...FAST, ...sc.over } }));
      } catch (e) {
        problems.push(`${sc.name}: nelze založit (${JSON.stringify((e as { issues?: unknown }).issues ?? (e as Error).message)})`);
        continue;
      }
      const actor = s.server.tables.actors.get(id)!;
      const info = actor.viewFor(null).info;
      for (const [i, u] of users.entries()) {
        try {
          actor.join(u, s.names.get(u)!, i, Math.min(info.maxBuyIn, Math.max(info.minBuyIn, info.bigBlind * 60)));
        } catch (e) {
          if (!(e instanceof GameError)) throw e;
          problems.push(`${sc.name}: hráč ${i} se nemohl posadit (${(e as { code?: string }).code ?? e.message})`);
        }
      }
      const rnd = seededRandom(900 + k);
      let acted = 0;
      for (let step = 0; step < 350; step++) {
        const v = actor.viewFor(null);
        if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
          const p = v.seats.find((x) => x.seat === v.actingSeat)!;
          const legal = actor.viewFor(p.playerId).legal;
          if (legal && rnd() < 0.85) {
            actor.act(p.playerId, randomLegalAction(legal, rnd));
            acted++;
          }
        }
        const vote = v.vote;
        if (vote?.status === 'open') for (const voter of vote.voters) if (rnd() < 0.5) try { actor.voteRunIt(voter.userId, rnd() < 0.7); } catch { /* už rozhodnuto */ }
        // hráči bez žetonů dokupují a vracejí se do hry, aby hra pokračovala
        for (const seat of v.seats) {
          if (seat.stack === 0 && v.street === null || seat.status === 'sittingOut') {
            try {
              if (seat.stack === 0) actor.topUp(seat.playerId, info.bigBlind * 60);
              actor.sitIn(seat.playerId);
            } catch (e) {
              if (!(e instanceof GameError)) throw e;
            }
          }
        }
        s.clock.advance(Math.floor(rnd() * 2500));
        if (step % 50 === 0) {
          if (!s.server.ledger.totalIsZero(ids(s.everyone, [accounts.table(id)]))) problems.push(`${sc.name}: kniha nesedí v kroku ${step}`);
          if (s.server.ledger.balance(accounts.table(id)) !== actor.totalChips()) problems.push(`${sc.name}: žetony u stolu nesedí s knihou v kroku ${step}`);
        }
        if (actor.hasError()) {
          problems.push(`${sc.name}: stůl skončil chybou`);
          break;
        }
      }
      if (acted < 20) problems.push(`${sc.name}: odehrálo se jen ${acted} akcí`);
      await new Promise((r) => setTimeout(r, 100));
      const channelId = await s.server.chat.channelIdByKey('table:' + id);
      const msgs = channelId ? (await allMessages(s.server, s.admin, channelId)).map((m) => m.body) : [];
      if (!msgs.some((m) => m.startsWith('Handa č.'))) problems.push(`${sc.name}: v chatu nejsou výsledky hand (zpráv ${msgs.length}: ${[...new Set(msgs.map((m) => m.slice(0, 18)))].join(' | ')})`);
      await s.server.tables.closeTable(org, id);
      if (s.server.ledger.balance(accounts.table(id)) !== 0) problems.push(`${sc.name}: po zrušení stolu zůstaly žetony`);
    }
    expect(problems).toEqual([]);
  });
});

describe('odehrané scénáře: dohoda v turnaji', { timeout: 300_000 }, () => {
  for (const bounty of ['none', 'pko'] as const) {
    it(`dohoda ICM (${bounty}): turnaj skončí, přehled souhlasí s peněženkami, bounty účet je prázdný`, async () => {
      const s = await start();
      const org = await s.user('organizator');
      const players = [await s.user(), await s.user(), await s.user()];
      const before = new Map(players.map((p) => [p, s.server.ledger.balance(accounts.wallet(p))]));
      const { id } = await s.server.tournaments.create(org, {
        name: 'Dohoda',
        templateId: 'tour-turbo',
        settings: { ...BASE, 'tournament.dealEnabled': true, 'tournament.dealMaxPlayers': 3, 'tournament.dealVoteSeconds': 300, 'tournament.payoutPreset': 'top3', 'tournament.bountyType': bounty, ...(bounty === 'pko' ? { 'tournament.bountyPercent': 40 } : {}) },
      });
      for (const p of players) await s.server.tournaments.register(p, id);
      if (s.server.tournaments.get(id)!.state().status === 'registering') await s.server.tournaments.start(org, id);
      expect(s.server.tournaments.get(id)!.state().status).toBe('running');
      await s.server.tournaments.proposeDeal(players[0]!, id, { method: 'icm' });
      for (const p of players) await s.server.tournaments.voteDeal(p, id, true);
      await Promise.resolve();
      const view = await s.server.tournaments.view(id, players[0]!);
      expect(view.status).toBe('finished');
      expect(view.deal.done).not.toBeNull();
      expect(s.server.ledger.balance(accounts.tournament(id))).toBe(0);
      expect(s.server.ledger.balance(accounts.bounty(id))).toBe(0);
      expect(s.server.ledger.totalIsZero(ids(s.everyone, [accounts.tournament(id), accounts.bounty(id)]))).toBe(true);
      expect(view.summary).not.toBeNull();
      for (const row of view.summary!) expect(s.server.ledger.balance(accounts.wallet(row.userId)) - before.get(row.userId)!, s.names.get(row.userId)).toBe(row.profit);
    });
  }
});
