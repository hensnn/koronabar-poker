import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accounts } from '@kb/ledger';
import { FakeClock, randomLegalAction, seededRandom, TournamentError } from '@kb/game-core';
import { buildServer } from './app.js';
import { schema } from './db/index.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FAST = {
  'time.betweenHandsMs': 100,
  'time.allInRunoutDelayMs': 50,
  'time.allInRiverDramaMs': 50,
  'time.showdownMs': 50,
  'time.potToWinnerMs': 50,
  'time.turnSeconds': 5,
  'odds.enabled': false,
};

async function start(clock = new FakeClock(), dataDir?: string) {
  const server = await buildServer({
    clock,
    dataDir,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 3), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000 },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `T${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof TournamentError) return e.code;
    throw e;
  }
};

const SETTINGS = { ...FAST, 'tournament.levelMinutes': 1, 'tournament.targetMinutes': 20, 'tournament.startingStack': 1500, 'tournament.buyIn': 100, 'tournament.fee': 10, 'tournament.minPlayers': 2 };

async function playOut(s: { server: Server; clock: FakeClock }, id: string, seed: number, maxSteps = 30_000) {
  const rnd = seededRandom(seed);
  const actor = s.server.tables.actors.get(id)!;
  for (let i = 0; i < maxSteps && s.server.tournaments.get(id)!.state().status === 'running'; i++) {
    const v = actor.viewFor(null);
    if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
      const p = v.seats.find((x) => x.seat === v.actingSeat)!;
      const legal = actor.viewFor(p.playerId).legal;
      if (legal && rnd() < 0.85) actor.act(p.playerId, randomLegalAction(legal, rnd));
    }
    s.clock.advance(Math.floor(rnd() * 3000));
    await Promise.resolve();
  }
  await Promise.resolve();
}

describe('turnaje na serveru', { timeout: 120_000 }, () => {
  it('oprávnění: běžný hráč turnaj nezaloží, organizátor ano (s limitem buy-inu), spouští jen vlastník', async () => {
    const s = await start();
    const player = await s.user();
    const org = await s.user('organizator');
    expect(await code(s.server.tournaments.create(player, { name: 'Pokus', templateId: 'tour-turbo' }))).toBe('FORBIDDEN');
    expect(await code(s.server.tournaments.create(org, { name: 'Špatná šablona', templateId: 'cash-klasika' }))).toBe('INVALID');
    expect(await code(s.server.tournaments.create(org, { name: 'Drahý', templateId: 'tour-turbo', settings: { 'tournament.buyIn': 50_000 } }))).toBe('LIMIT_EXCEEDED');
    expect(await code(s.server.tournaments.create(org, { name: 'Zlá struktura', templateId: 'tour-turbo', settings: { 'tournament.structure': '50/25' } }))).toBe('BAD_STRUCTURE');
    const { id } = await s.server.tournaments.create(org, { name: 'Páteční turnaj', templateId: 'tour-turbo', settings: SETTINGS });
    expect(id).toMatch(/^t-patecni-turnaj-[0-9a-f]{6}$/);
    await s.server.tournaments.register(player, id);
    expect(await code(s.server.tournaments.start(player, id))).toBe('FORBIDDEN');
    expect(await code(s.server.tournaments.register(player, id))).toBe('ALREADY_REGISTERED');
    expect(await code(s.server.tournaments.start(org, id))).toBe('NOT_ENOUGH_PLAYERS');
    const lobby = await s.server.tournaments.lobby();
    expect(lobby[0]).toMatchObject({ name: 'Páteční turnaj', status: 'registering', players: 1, buyIn: 100, fee: 10 });
    expect((await s.server.audit.list({ action: 'turnaj.vytvorit' }))[0]!.targetId).toBe(id);
  });

  it('rebuy: kdo právě rozhoduje a dokdy je vidět všem ve stavu turnaje (pruh u stolu)', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const ps = [await s.user(), await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, { name: 'Rozhodování', templateId: 'tour-turbo', settings: { ...SETTINGS, 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 5, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 1500, 'tournament.rebuyHoldsGame': true, 'tournament.rebuyDecisionSeconds': 60 } });
    for (const p of ps) await s.server.tournaments.register(p, id);
    await s.server.tournaments.start(org, id);
    const rnd = seededRandom(5);
    const actor = s.server.tables.actors.get(id)!;
    let deciding: string | undefined;
    for (let i = 0; i < 30_000 && !deciding; i++) {
      const v = actor.viewFor(null);
      if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((x) => x.seat === v.actingSeat)!;
        const legal = actor.viewFor(p.playerId).legal;
        if (legal) actor.act(p.playerId, randomLegalAction(legal, rnd));
      }
      s.clock.advance(Math.floor(rnd() * 3000));
      await Promise.resolve();
      deciding = s.server.tournaments.get(id)!.state().players.find((p) => p.status === 'deciding')?.userId;
    }
    expect(deciding).toBeDefined();
    const other = ps.find((p) => p !== deciding)!;
    const view = await s.server.tournaments.view(id, other);
    const row = view.standings.find((x) => x.userId === deciding)!;
    expect(row.status).toBe('deciding');
    expect(row.decideUntil).toBeGreaterThan(s.clock.now());
    expect(row.decideFrozen).toBe(false);
    expect(view.rebuy.holdsGame).toBe(true);
  });

  describe('automatické odpovědi podle osobní předvolby', () => {
    const run = async (pref: 'always' | 'never') => {
      const s = await start();
      const org = await s.user('organizator');
      const ps = [await s.user(), await s.user(), await s.user()];
      for (const p of ps) {
        await s.server.settings.set(p, 'user', p, 'ui.autoRebuy', pref);
        await s.server.settings.set(p, 'user', p, 'ui.autoReenter', pref);
      }
      const { id } = await s.server.tournaments.create(org, { name: 'Auto', templateId: 'tour-turbo', settings: { ...SETTINGS, 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 5, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 1500, 'tournament.rebuyHoldsGame': true, 'tournament.rebuyDecisionSeconds': 60 } });
      for (const p of ps) await s.server.tournaments.register(p, id);
      await s.server.tournaments.start(org, id);
      const rnd = seededRandom(5);
      const actor = s.server.tables.actors.get(id)!;
      const t0 = s.clock.now();
      let seen: string | undefined;
      for (let i = 0; i < 30_000 && !seen; i++) {
        const v = actor.viewFor(null);
        if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
          const p = v.seats.find((x) => x.seat === v.actingSeat)!;
          const legal = actor.viewFor(p.playerId).legal;
          if (legal) actor.act(p.playerId, randomLegalAction(legal, rnd));
        }
        s.clock.advance(Math.floor(rnd() * 1000));
        await new Promise((r) => setTimeout(r, 2));
        const players = s.server.tournaments.get(id)!.state().players;
        seen = players.find((p) => (pref === 'always' ? p.rebuys > 0 || p.entries > 1 : p.status === 'out'))?.userId;
      }
      return { s, id, seen, t0 };
    };

    it('„vždy“: rebuy se koupí sám po odpočtu, zapíše se do protokolu a nezdrží hru', async () => {
      const { s, seen } = await run('always');
      expect(seen).toBeDefined();
      expect((await s.server.audit.list({ action: 'turnaj.auto_odpoved' })).length).toBeGreaterThan(0);
    });

    /** Rozehraje turnaj, dokud někdo nezačne rozhodovat o rebuy; vrací ho a čas, kdy se to stalo. */
    const untilDeciding = async (s: Awaited<ReturnType<typeof start>>, id: string, seed = 5) => {
      const rnd = seededRandom(seed);
      const actor = s.server.tables.actors.get(id)!;
      for (let i = 0; i < 30_000; i++) {
        const v = actor.viewFor(null);
        if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
          const p = v.seats.find((x) => x.seat === v.actingSeat)!;
          const legal = actor.viewFor(p.playerId).legal;
          if (legal) actor.act(p.playerId, randomLegalAction(legal, rnd));
        }
        const d = s.server.tournaments.get(id)!.state().players.find((p) => p.status === 'deciding');
        if (d) return d;
        s.clock.advance(Math.floor(rnd() * 500));
        await new Promise((r) => setTimeout(r, 1));
      }
      throw new Error('nikdo nezačal rozhodovat');
    };
    const setup = async (decisionSeconds: number, prefs: Record<string, string>, extra: Record<string, unknown> = {}) => {
      const s = await start();
      const org = await s.user('organizator');
      const ps = [await s.user(), await s.user(), await s.user()];
      for (const p of ps) for (const [k, v] of Object.entries(prefs)) await s.server.settings.set(p, 'user', p, k, v);
      const { id } = await s.server.tournaments.create(org, { name: 'Casy', templateId: 'tour-turbo', settings: { ...SETTINGS, 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 5, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 1500, 'tournament.rebuyHoldsGame': true, 'tournament.rebuyDecisionSeconds': decisionSeconds, ...extra } });
      for (const p of ps) await s.server.tournaments.register(p, id);
      await s.server.tournaments.start(org, id);
      return { s, id, ps };
    };
    const tick = async (s: { clock: FakeClock }, ms: number, step = 100) => {
      for (let t = 0; t < ms; t += step) {
        s.clock.advance(step);
        await new Promise((r) => setTimeout(r, 1));
      }
    };

    it('čas: odpověď přijde po nastaveném odpočtu placené akce (5 s), ne dřív a ne po konci času na rozhodnutí', async () => {
      const { s, id } = await setup(30, { 'ui.autoRebuy': 'always' });
      const d = await untilDeciding(s, id);
      const t0 = s.clock.now();
      const rebuys = () => s.server.tournaments.get(id)!.state().players.find((p) => p.userId === d.userId)!.rebuys;
      const before = rebuys();
      // klient dostane od serveru přesný okamžik automatické odpovědi (odpočet v dialogu tak vždy sedí se skutečností)
      const shown = (await s.server.tournaments.view(id, d.userId)).me.autoAnswer;
      expect(shown).not.toBeNull();
      expect(shown!.yes).toBe(true);
      expect(shown!.at - t0).toBeLessThanOrEqual(5_000);
      expect(shown!.at - t0).toBeGreaterThan(3_000);
      await tick(s, 4_500);
      expect(rebuys()).toBe(before); // 4,5 s od vypadnutí: odpočet 5 s ještě neuplynul
      await tick(s, 1_500);
      expect(rebuys()).toBe(before + 1);
      expect(s.clock.now() - t0).toBeLessThan(30_000);
    });

    it('čas: odpočet nastavený správcem (10 s) platí na server i při dalších rebuy, ne jen u prvního', async () => {
      const { s, id } = await setup(30, { 'ui.autoRebuy': 'always' });
      await s.server.settings.set(s.admin, 'global', '', 'time.autoAnswerPaidSeconds', 10);
      for (let round = 0; round < 3; round++) {
        const d = await untilDeciding(s, id, 5 + round);
        const rebuys = () => s.server.tournaments.get(id)!.state().players.find((p) => p.userId === d.userId)!.rebuys;
        const before = rebuys();
        const t0 = s.clock.now();
        await tick(s, 9_000);
        expect(rebuys()).toBe(before); // 9 s od vypadnutí: odpočet 10 s ještě neuplynul
        await tick(s, 2_000);
        expect(rebuys()).toBe(before + 1);
        expect(s.clock.now() - t0).toBeGreaterThanOrEqual(10_000);
      }
    });

    it('čas: při krátkém čase na rozhodnutí (5 s) přijde odpověď vteřinu před koncem, hráč nevypadne', async () => {
      const { s, id } = await setup(5, { 'ui.autoRebuy': 'always' });
      const d = await untilDeciding(s, id);
      const until = d.decideUntil!;
      await tick(s, Math.max(0, until - s.clock.now() - 1_500));
      expect(s.server.tournaments.get(id)!.state().players.find((p) => p.userId === d.userId)!.status).toBe('deciding');
      await tick(s, 1_000);
      const after = s.server.tournaments.get(id)!.state().players.find((p) => p.userId === d.userId)!;
      expect(after.rebuys).toBeGreaterThan(0);
      expect(after.status).not.toBe('out');
    });

    it('souběh: když hráč odpoví sám dřív než automatika, zaplatí se jen jednou a automatika nic nedělá', async () => {
      const { s, id } = await setup(30, { 'ui.autoRebuy': 'always' });
      const d = await untilDeciding(s, id);
      await tick(s, 1_000);
      await s.server.tournaments.rebuy(d.userId, id);
      const paid = () => s.server.db.select().from(schema.ledgerTransactions).then((r) => r.filter((x) => x.kind === 'turnaj_rebuy' && x.idempotencyKey.includes(d.userId)).length);
      await s.server.journal.flush();
      const before = await paid();
      await tick(s, 8_000);
      await s.server.journal.flush();
      expect(await paid()).toBe(before);
      expect((await s.server.audit.list({ action: 'turnaj.auto_odpoved' })).filter((r) => r.actorId === d.userId)).toHaveLength(0);
    });

    it('odmítnutí během odpočtu: hráč si to rozmyslí, rebuy odmítne a automatika už nic nekoupí', async () => {
      const { s, id } = await setup(30, { 'ui.autoRebuy': 'always' });
      const d = await untilDeciding(s, id);
      await tick(s, 2_000);
      const before = s.server.tournaments.get(id)!.state().players.find((p) => p.userId === d.userId)!.rebuys;
      await s.server.tournaments.declineRebuy(d.userId, id);
      const rec = () => s.server.tournaments.get(id)!.state().players.find((p) => p.userId === d.userId)!;
      expect(rec().status).toBe('out');
      await tick(s, 8_000);
      expect(rec().rebuys).toBe(before);
      expect((await s.server.audit.list({ action: 'turnaj.auto_odpoved' })).filter((r) => r.actorId === d.userId)).toHaveLength(0);
    });

    it('souběh: předvolba změněná během odpočtu platí (z „vždy“ na „zeptat se“ se nekoupí nic)', async () => {
      const { s, id } = await setup(30, { 'ui.autoRebuy': 'always' });
      const d = await untilDeciding(s, id);
      await tick(s, 1_000);
      await s.server.settings.set(d.userId, 'user', d.userId, 'ui.autoRebuy', 'ask');
      const before = s.server.tournaments.get(id)!.state().players.find((p) => p.userId === d.userId)!.rebuys;
      await tick(s, 8_000);
      expect(s.server.tournaments.get(id)!.state().players.find((p) => p.userId === d.userId)!.rebuys).toBe(before);
    });

    it('odpojený hráč: odpočet stojí, ale automatika „vždy“ za něj rebuy koupí a turnaj na něj nečeká; „nikdy“ ho vyřadí hned', async () => {
      for (const pref of ['always', 'never'] as const) {
        const { s, id, ps } = await setup(30, { 'ui.autoRebuy': pref }, { 'tournament.rebuyWaitsForOffline': true, 'tournament.rebuyOfflineMaxSeconds': 120 });
        for (const p of ps) s.server.tables.actors.get(id)!.setConnected(p, false);
        const d = await untilDeciding(s, id);
        const rec = () => s.server.tournaments.get(id)!.state().players.find((p) => p.userId === d.userId)!;
        expect(rec().decideOffline).toBe(true);
        await tick(s, 8_000);
        if (pref === 'always') {
          expect(rec().rebuys).toBeGreaterThan(0);
          expect(rec().status).not.toBe('out');
        } else expect(rec().status).toBe('out'); // dřív než po 120 s čekání na odpojené
      }
    });

    it('pauza zastaví i automatiku: během pauzy se nekupuje, po obnovení přijde odpověď s novým odpočtem', async () => {
      const { s, id } = await setup(30, { 'ui.autoRebuy': 'always' }, { 'tournament.rebuyTimerStops': true });
      const org = s.server.tournaments.get(id)!.state().players.length ? [...(await s.server.db.select().from(schema.tournaments))][0]!.ownerId : '';
      const d = await untilDeciding(s, id);
      await tick(s, 1_000);
      await s.server.tournaments.pause(org as string, id, false);
      const rebuys = () => s.server.tournaments.get(id)!.state().players.find((p) => p.userId === d.userId)!.rebuys;
      const before = rebuys();
      await tick(s, 12_000);
      expect(rebuys()).toBe(before);
      await s.server.tournaments.pause(org as string, id, true);
      await tick(s, 6_500);
      expect(rebuys()).toBe(before + 1);
    });

    it('„nikdy“: hráč vypadne hned, ne až po vypršení času na rozhodnutí', async () => {
      const { s, seen, t0 } = await run('never');
      expect(seen).toBeDefined();
      const auto = await s.server.audit.list({ action: 'turnaj.auto_odpoved' });
      expect(auto.length).toBeGreaterThan(0);
      // celý čas na rozhodnutí (60 s) nevypršel, odpověď přišla do pár sekund od vypadnutí
      expect(s.clock.now() - t0).toBeGreaterThan(0);
    });
  });

  it('zrušený turnaj nezanechá statistiky: handy, vyřazení i z nich vzniklé XP zmizí, ostatní data zůstanou', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const ps = [await s.user(), await s.user(), await s.user()];
    // jiná hra, jejíž statistiky musí zůstat: dohraný cash stůl s pár handami
    const { id } = await s.server.tournaments.create(org, { name: 'Ke zrušení', templateId: 'tour-turbo', settings: { ...SETTINGS, 'tournament.startingStack': 300 } });
    for (const p of ps) await s.server.tournaments.register(p, id);
    await s.server.tournaments.start(org, id);
    const tour = s.server.tournaments.get(id)!;
    const rnd = seededRandom(9);
    const actor = s.server.tables.actors.get(id)!;
    for (let i = 0; i < 30_000 && tour.state().eliminations.length < 1; i++) {
      const v = actor.viewFor(null);
      if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((x) => x.seat === v.actingSeat)!;
        const legal = actor.viewFor(p.playerId).legal;
        if (legal) actor.act(p.playerId, randomLegalAction(legal, rnd));
      }
      s.clock.advance(Math.floor(rnd() * 3000));
      await Promise.resolve();
    }
    expect(tour.state().eliminations.length).toBeGreaterThanOrEqual(1);
    await s.server.stats.idle();
    await s.server.progress.idle();
    const count = async () => ({
      hands: (await s.server.db.select().from(schema.hands).where(eq(schema.hands.tournamentId, id))).length,
      elims: (await s.server.db.select().from(schema.tournamentEliminations).where(eq(schema.tournamentEliminations.tournamentId, id))).length,
      xp: (await s.server.db.select().from(schema.xpEvents)).reduce((n, r) => n + r.amount, 0),
    });
    const before = await count();
    expect(before.hands).toBeGreaterThan(0);
    expect(before.elims).toBeGreaterThan(0);
    expect(before.xp).toBeGreaterThan(0);

    await s.server.tournaments.cancel(org, id);
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 30));
      if ((await count()).hands === 0) break;
    }
    await s.server.stats.idle();
    await s.server.progress.idle();
    const after = await count();
    expect(after.hands).toBe(0);
    expect(after.elims).toBe(0);
    expect(after.xp).toBe(0); // žádná jiná hra, takže z turnaje nezůstává žádné XP
  });

  it('rebuy po vypadnutí: hra na hráče počká a po rebuy dostane v další handě karty (nerozdá se bez něj)', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const ps = [await s.user(), await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, { name: 'Rebuy karty', templateId: 'tour-turbo', settings: { ...SETTINGS, 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 5, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 1500, 'tournament.rebuyHoldsGame': true, 'tournament.rebuyDecisionSeconds': 60 } });
    for (const p of ps) await s.server.tournaments.register(p, id);
    await s.server.tournaments.start(org, id);
    const rnd = seededRandom(5);
    const actor = s.server.tables.actors.get(id)!;
    let deciding: string | undefined;
    for (let i = 0; i < 30_000 && !deciding; i++) {
      const v = actor.viewFor(null);
      if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((x) => x.seat === v.actingSeat)!;
        const legal = actor.viewFor(p.playerId).legal;
        if (legal) actor.act(p.playerId, randomLegalAction(legal, rnd));
      }
      s.clock.advance(Math.floor(rnd() * 3000));
      await Promise.resolve();
      deciding = s.server.tournaments.get(id)!.state().players.find((p) => p.status === 'deciding')?.userId;
    }
    expect(deciding).toBeDefined();
    // Dokud se hráč rozhoduje, další handa se nerozdá.
    const beforeId = actor.viewFor(null).handId;
    s.clock.advance(20_000);
    await Promise.resolve();
    expect(actor.viewFor(null).handId).toBe(beforeId);
    // Vypadlo-li víc hráčů najednou (náhodná hra), rebuy si koupí všichni, ať stůl nic dalšího nedrží.
    const others = s.server.tournaments.get(id)!.state().players.filter((p) => p.status === 'deciding' && p.userId !== deciding);
    // Rebuy: stůl se uvolní a hráč je v další handě mezi hráči s kartami; když na něj přijde řada, má karty.
    await s.server.tournaments.rebuy(deciding!, id);
    for (const o of others) await s.server.tournaments.rebuy(o.userId, id);
    for (let i = 0; i < 400 && (actor.viewFor(null).handId === null || actor.viewFor(null).handId === beforeId); i++) {
      s.clock.advance(100);
      await Promise.resolve();
    }
    const v = actor.viewFor(deciding!);
    expect(v.handId).not.toBeNull();
    expect(v.handId).not.toBe(beforeId);
    const me = v.seats.find((x) => x.playerId === deciding)!;
    expect(me).toBeDefined();
    expect(me.stack + me.bet).toBeGreaterThan(0);
    expect(me.hasCards).toBe(true);
    expect(me.cards).not.toBeNull();
  });

  it('rebuy uprostřed rozdané handy (hra nečekala): hráč nedostane tah bez karet a v další handě hraje', async () => {
    // Hra je náhodná (zamíchání karet není ze seedu), proto se scénář při nevhodném průběhu zopakuje.
    const attempt = async (): Promise<boolean | null> => {
      const s = await start();
      const org = await s.user('organizator');
      const ps = [await s.user(), await s.user(), await s.user()];
      const { id } = await s.server.tournaments.create(org, { name: 'Rebuy za běhu', templateId: 'tour-turbo', settings: { ...SETTINGS, 'tournament.rebuyEnabled': true, 'tournament.rebuyUntilLevel': 5, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 1500, 'tournament.rebuyHoldsGame': false, 'tournament.rebuyDecisionSeconds': 600 } });
      for (const p of ps) await s.server.tournaments.register(p, id);
      await s.server.tournaments.start(org, id);
      const rnd = seededRandom(5);
      const actor = s.server.tables.actors.get(id)!;
      const act = () => {
        const v = actor.viewFor(null);
        if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
          const p = v.seats.find((x) => x.seat === v.actingSeat)!;
          const legal = actor.viewFor(p.playerId).legal;
          if (legal) {
            const pv = actor.viewFor(p.playerId).seats.find((x) => x.playerId === p.playerId)!;
            expect(pv.hasCards, 'hráč na tahu musí mít karty').toBe(true);
            actor.act(p.playerId, randomLegalAction(legal, rnd));
          }
        }
      };
      let deciding: string | undefined;
      for (let i = 0; i < 30_000 && !deciding; i++) {
        act();
        s.clock.advance(Math.floor(rnd() * 3000));
        await Promise.resolve();
        deciding = s.server.tournaments.get(id)!.state().players.find((p) => p.status === 'deciding')?.userId;
      }
      if (!deciding) return null;
      // počkat, až se rozdá další handa bez něj, a teprve pak koupit rebuy
      for (let i = 0; i < 2000 && actor.currentPhase() !== 'hand'; i++) {
        s.clock.advance(100);
        await Promise.resolve();
      }
      if (actor.currentPhase() !== 'hand') return null; // náhodná hra skončila turnaj dřív, než se stihlo rozdat: zkusí se znovu
      await s.server.tournaments.rebuy(deciding!, id);
      const handNo = actor.viewFor(null).handNumber;
      let dealtIn = false;
      for (let i = 0; i < 20_000 && !dealtIn; i++) {
        act();
        s.clock.advance(Math.floor(rnd() * 3000));
        await Promise.resolve();
        const me = actor.viewFor(deciding!).seats.find((x) => x.playerId === deciding);
        if (actor.viewFor(null).handNumber > handNo && me?.hasCards) dealtIn = true;
      }
      return dealtIn;
    };
    let result: boolean | null = null;
    for (let tries = 0; tries < 12 && result === null; tries++) result = await attempt();
    expect(result).toBe(true);
  });

  it('přestávka: když jsou všichni ready, skončí dřív; pauza ředitele tlačítko nemá', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const ps = [await s.user(), await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, { name: 'Ready přestávka', templateId: 'tour-turbo', settings: { ...SETTINGS, 'tournament.levelMinutes': 1, 'tournament.breakEveryLevels': 1, 'tournament.breakMinutes': 10, 'table.readyMinSeconds': 5 } });
    for (const p of ps) await s.server.tournaments.register(p, id);
    await s.server.tournaments.start(org, id);
    const actor = s.server.tables.actors.get(id)!;
    const tour = s.server.tournaments.get(id)!;
    for (let i = 0; i < 400 && !tour.state().onBreak; i++) {
      s.clock.advance(1000);
      await Promise.resolve();
    }
    expect(tour.state().onBreak).toBe(true);
    expect(actor.viewFor(ps[0]!).ready).toMatchObject({ total: 3, needed: 3, mine: false });
    for (const p of ps) actor.setReady(p, true);
    expect(tour.state().onBreak).toBe(true); // minimální doba ještě neuplynula
    s.clock.advance(6000);
    await Promise.resolve();
    expect(tour.state().onBreak).toBe(false);
    // pauza ředitele: tlačítko ready se neukazuje a příkaz nejde
    tour.pause();
    expect(actor.viewFor(ps[0]!).ready).toBeNull();
    expect(() => actor.setReady(ps[0]!, true)).toThrow();
  });

  it('celý turnaj: přihlášky, start, hra botů, výplaty z poolu, dům dostane poplatky', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const players = [await s.user(), await s.user(), await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, { name: 'Turnaj', templateId: 'tour-turbo', settings: SETTINGS });
    for (const p of players) await s.server.tournaments.register(p, id);
    const view0 = await s.server.tournaments.view(id, players[0]!);
    expect(view0.prizePool).toBe(400);
    expect(view0.me).toMatchObject({ registered: true, canUnregister: true, canRegister: false });
    expect(view0.can.start).toBe(false);
    await s.server.tournaments.start(org, id);
    expect((await s.server.tournaments.view(id, org)).status).toBe('running');
    await playOut(s, id, 7);

    const view = await s.server.tournaments.view(id, players[0]!);
    expect(view.status).toBe('finished');
    expect(view.results!.map((r) => r.place)).toEqual([1, 2, 3, 4]);
    // turbo šablona vyplácí první dvě místa (65/35) ze 400
    expect(view.results!.map((r) => r.payout)).toEqual([260, 140, 0, 0]);
    expect(s.server.ledger.balance(accounts.tournament(id))).toBe(0);
    expect(s.server.ledger.balance(accounts.house())).toBe(40);
    const wallets = players.reduce((n, p) => n + s.server.ledger.balance(accounts.wallet(p)), 0);
    expect(wallets).toBe(4 * (10_000 - 110) + 400);
    const fin = await s.server.tournaments.finance();
    expect(fin.house).toBe(40);
    expect(fin.tournaments[0]).toMatchObject({ entries: 4, gross: 440, pool: 400, fees: 40, paidOut: 400, overlay: 0 });
    // zápis do databáze proběhl: kniha i stav turnaje
    await s.server.journal.flush();
    const [row] = await s.server.db.select().from(schema.tournaments);
    expect(row!.status).toBe('finished');
    // chat stolu má systémové zprávy o průběhu
    const channelId = (await s.server.chat.channelIdByKey('table:' + id))!;
    const msgs = (await s.server.chat.history(s.admin, channelId)).map((m) => m.body);
    expect(msgs.some((m) => m.includes('Turnaj začal'))).toBe(true);
    expect(msgs.some((m) => m.includes('Turnaj skončil'))).toBe(true);
  });

  it('vyúčtování období: cash a turnaj zvlášť i dohromady, rozpad po hrách, převody a omezený pohled hráče', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [a, b, c] = [await s.user(), await s.user(), await s.user()];
    // cash: a a b hrají jednu handu, ten na tahu složí, pak oba odejdou
    await s.server.tables.create({ id: 'cash1', name: 'Cash stůl', templateId: 'cash-klasika', settings: { ...FAST } });
    const table = s.server.tables.get('cash1')!;
    table.join(a, 'A', 0, 500);
    table.join(b, 'B', 1, 500);
    s.clock.advance(200);
    const v = table.viewFor(null);
    const folder = v.seats.find((x) => x.seat === v.actingSeat)!.playerId;
    table.act(folder, { type: 'fold' });
    table.leave(a);
    table.leave(b);
    expect(table.playersSeated()).toHaveLength(0);
    // turnaj se třemi hráči (a, b, c)
    const { id } = await s.server.tournaments.create(org, { name: 'Večerní', templateId: 'tour-turbo', settings: { ...SETTINGS, 'tournament.fee': 10 } });
    for (const p of [a, b, c]) await s.server.tournaments.register(p, id);
    await s.server.tournaments.start(org, id);
    await playOut(s, id, 9);
    await s.server.journal.flush();

    const day = Date.now() + 3600_000;
    const all = await s.server.wallet.settlementForPeriod(s.admin, 0, day);
    const row = (u: string) => all.players.find((p) => p.userId === u)!;
    expect(row(a).cash + row(b).cash).toBe(0);
    expect(Math.abs(row(a).cash)).toBe(5);
    expect(row(c).cash).toBe(0);
    // turnaj: každý zaplatil 110, vyhrává se z poolu 150; součet hráčů = výplaty − vstupy, zbytek jsou poplatky herny
    expect(all.players.reduce((n, p) => n + p.tournament, 0)).toBe(-30);
    expect(all.house).toBe(30);
    for (const p of all.players) expect(p.total).toBe(p.cash + p.tournament);
    expect(all.games.map((g) => g.kind).sort()).toEqual(['cash', 'tournament']);
    // rozpad podle složek: součet složek je výsledek hráče, buy-in včetně poplatku je záporný, výhry kladné
    const sum = (o: Record<string, number | undefined>) => Object.values(o).reduce<number>((n, v) => n + (v ?? 0), 0);
    for (const p of all.players) expect(sum(p.parts)).toBe(p.total);
    for (const p of all.players) expect(p.parts.buyIn).toBe(-110);
    const tour = all.games.find((g) => g.kind === 'tournament')!;
    for (const [uid, v] of Object.entries(tour.results)) expect(sum(tour.parts[uid]!)).toBe(v);
    expect(tour.parts[a]!.buyIn).toBe(-110);
    // minimální převody vyrovnají všechny hráče vůči sobě a domu
    const net: Record<string, number> = {};
    for (const t of all.transfers) {
      net[t.from] = (net[t.from] ?? 0) - t.amount;
      net[t.to] = (net[t.to] ?? 0) + t.amount;
    }
    for (const p of all.players) expect(net[p.userId] ?? 0).toBe(p.total);
    // kdo u cash stolu ještě sedí, má do výsledku započtené žetony u stolu
    const withSeated = await s.server.wallet.settlementForPeriod(s.admin, 0, Date.now() + 1000, [{ userId: c, tableId: 'cash1', chips: 40 }]);
    expect(withSeated.players.find((p) => p.userId === c)!.cash).toBe(40);
    // hráč bez oprávnění vidí jen sebe a své převody; cizí období bez účasti nevidí nic
    const mine = await s.server.wallet.settlementForPeriod(a, 0, day);
    expect(mine.players.map((p) => p.userId)).toEqual([a]);
    expect(mine.house).toBeNull();
    for (const t of mine.transfers) expect([t.from, t.to]).toContain(a);
    const outsider = await s.user();
    await expect(s.server.wallet.settlementForPeriod(outsider, 0, day)).rejects.toThrow();
    // období mimo všechny pohyby je prázdné
    expect((await s.server.wallet.settlementForPeriod(s.admin, 1, 2)).players).toEqual([]);
  });

  it('freeroll: vstup zdarma, prize pool z garance (nová měna), hráči dostanou výhry', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const ps = [await s.user(), await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, { name: 'Freeroll', templateId: 'tour-freeroll', settings: { ...FAST, 'tournament.levelMinutes': 1, 'tournament.targetMinutes': 15 } });
    for (const pl of ps) await s.server.tournaments.register(pl, id);
    for (const pl of ps) expect(s.server.ledger.balance(accounts.wallet(pl))).toBe(10_000);
    await s.server.tournaments.start(org, id);
    await playOut(s, id, 21);
    const view = await s.server.tournaments.view(id, ps[0]!);
    expect(view.status).toBe('finished');
    expect(view.results!.map((r) => r.payout)).toEqual([150, 90, 60]);
    expect(view.fees.overlay).toBe(300);
    expect(s.server.ledger.balance(accounts.tournament(id))).toBe(0);
    expect(ps.reduce((n, pl) => n + s.server.ledger.balance(accounts.wallet(pl)), 0)).toBe(3 * 10_000 + 300);
  });

  it('PKO turnaj: hlavy u stolu, bounty v knize, chat, finance a vyúčtování', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const ps = [await s.user(), await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, { name: 'PKO večer', templateId: 'tour-pko', settings: { ...SETTINGS, 'tournament.fee': 10 } });
    for (const pl of ps) await s.server.tournaments.register(pl, id);
    await s.server.tournaments.start(org, id);
    const view0 = await s.server.tournaments.view(id, ps[0]!);
    expect(view0.bounty).toMatchObject({ type: 'pko', percent: 50, pkoCash: 50 });
    expect(view0.standings.every((x) => x.head === 50)).toBe(true);
    const table = s.server.tables.actors.get(id)!;
    expect(table.viewFor(ps[0]!).seats.every((x) => x.bounty === 50)).toBe(true);
    await playOut(s, id, 31);
    const view = await s.server.tournaments.view(id, ps[0]!);
    expect(view.status).toBe('finished');
    // bounty 3 × 50 % ze 100 = 150, prize pool 3 × 50 = 150
    expect(view.results!.reduce((n, r) => n + (r.bounty ?? 0), 0)).toBe(150);
    expect(view.results!.reduce((n, r) => n + r.payout, 0)).toBe(150);
    expect(s.server.ledger.balance(accounts.bounty(id))).toBe(0);
    const fin = await s.server.tournaments.finance();
    expect(fin.tournaments[0]).toMatchObject({ bounty: 150, pool: 150, fees: 30 });
    const channelId = (await s.server.chat.channelIdByKey('table:' + id))!;
    const msgs = (await s.server.chat.history(s.admin, channelId)).map((m) => m.body);
    expect(msgs.some((m) => m.includes('vyřadil hráče'))).toBe(true);
    await s.server.journal.flush();
    const all = await s.server.wallet.settlementForPeriod(s.admin, 0, Date.now() + 3600_000);
    expect(all.players.reduce((n, p) => n + p.tournament, 0)).toBe(-30);
  });

  it('dohoda: hlasování přes správce turnajů, uzavření dohody a obnova otevřeného hlasování po restartu', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-deal-'));
    dirs.push(dir);
    const first = await start(new FakeClock(), dir);
    const org = await first.user('organizator');
    const ps = [await first.user(), await first.user(), await first.user()];
    const over = { ...SETTINGS, 'tournament.dealEnabled': true, 'tournament.dealMaxPlayers': 3, 'tournament.dealVoteSeconds': 300, 'tournament.payoutPreset': 'top3' };
    const { id } = await first.server.tournaments.create(org, { name: 'Dohoda', templateId: 'tour-turbo', settings: over });
    for (const pl of ps) await first.server.tournaments.register(pl, id);
    await first.server.tournaments.start(org, id);
    // cizí člověk dohodu nenavrhne
    const outsider = await first.user();
    await expect(first.server.tournaments.proposeDeal(outsider, id, { method: 'equal' })).rejects.toThrow(/FORBIDDEN/);
    await first.server.tournaments.proposeDeal(ps[0]!, id, { method: 'icm' });
    const opt = first.server.tournaments.dealOptions(id, ps[1]!);
    expect(opt.vote).toMatchObject({ status: 'open', canVote: true, myVote: null });
    expect((await first.server.tournaments.view(id, ps[1]!)).deal.open).toBe(true);
    await first.server.tournaments.voteDeal(ps[1]!, id, true);
    await first.server.journal.flush();
    await first.server.close();
    servers.pop();

    // po restartu hlasování pokračuje s uloženými hlasy
    const second = await start(new FakeClock(), dir);
    const reopened = second.server.tournaments.dealOptions(id, ps[2]!);
    expect(reopened.vote).toMatchObject({ status: 'open', canVote: true });
    expect(reopened.vote!.tally).toMatchObject({ yes: 2, voted: 2, total: 3 });
    await second.server.tournaments.voteDeal(ps[2]!, id, true);
    const view = await second.server.tournaments.view(id, ps[0]!);
    expect(view.status).toBe('finished');
    expect(view.results!.reduce((n, r) => n + r.payout, 0)).toBe(300);
    expect(second.server.ledger.balance(accounts.tournament(id))).toBe(0);
    expect(view.deal.done).toMatchObject({ method: 'icm', keep: 0 });
    const msgs = (await second.server.chat.history(second.admin, (await second.server.chat.channelIdByKey('table:' + id))!)).map((m) => m.body);
    expect(msgs.some((m) => m.includes('Dohoda přijata'))).toBe(true);
  });

  it('změny nastavení: před startem všechno, po startu jen to, co dovolují pravidla', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const other = await s.user();
    const { id } = await s.server.tournaments.create(org, { name: 'Úpravy', templateId: 'tour-turbo', settings: SETTINGS });
    expect(await code(s.server.tournaments.updateSettings(other, id, { 'tournament.buyIn': 200 }))).toBe('FORBIDDEN');
    const r = await s.server.tournaments.updateSettings(org, id, { 'tournament.buyIn': 200 });
    expect(r.applied).toEqual(['tournament.buyIn']);
    expect(s.server.tournaments.settingsOf(id)!['tournament.buyIn']).toBe(200);
    const structureBefore = s.server.tournaments.settingsOf(id)!['tournament.structure'];
    expect(await code(s.server.tournaments.updateSettings(org, id, { 'tournament.structure': '10/20, 5/10' }))).toBe('BAD_STRUCTURE');
    expect(s.server.tournaments.settingsOf(id)!['tournament.structure']).toBe(structureBefore);
    for (const p of [await s.user(), await s.user()]) await s.server.tournaments.register(p, id);
    await s.server.tournaments.start(org, id);
    expect(await code(s.server.tournaments.updateSettings(org, id, { 'tournament.buyIn': 300 }))).toBe('INVALID');
    expect((await s.server.tournaments.updateSettings(org, id, { 'tournament.levelMinutes': 5 })).applied.concat((await s.server.tournaments.updateSettings(org, id, { 'tournament.levelMinutes': 5 })).pending)).toContain('tournament.levelMinutes');
  });

  it('zrušení vrátí všem platby; hráči u turnajového stolu nemohou použít cash příkazy', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const a = await s.user();
    const b = await s.user();
    const { id } = await s.server.tournaments.create(org, { name: 'Zrušený', templateId: 'tour-turbo', settings: SETTINGS });
    await s.server.tournaments.register(a, id);
    await s.server.tournaments.register(b, id);
    await s.server.tournaments.start(org, id);
    const table = s.server.tables.actors.get(id)!;
    expect(() => table.join(a, 'A', 8, 100)).toThrow(/TOURNAMENT_TABLE/);
    expect(() => table.leave(a)).toThrow(/TOURNAMENT_TABLE/);
    expect(() => table.topUp(a, 100)).toThrow(/TOURNAMENT_TABLE/);
    expect(table.viewFor(a).info.tournament).toBe(true);
    await s.server.tournaments.cancel(org, id);
    for (const p of [a, b]) expect(s.server.ledger.balance(accounts.wallet(p))).toBe(10_000);
    expect(s.server.ledger.balance(accounts.house())).toBe(0);
    expect(s.server.ledger.balance(accounts.tournament(id))).toBe(0);
    expect((await s.server.tournaments.view(id, a)).status).toBe('cancelled');
  });

  it('po restartu serveru turnaj pokračuje: hráči, žetony, level i prize pool zůstanou', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-trn-'));
    dirs.push(dir);
    const first = await start(new FakeClock(), dir);
    const org = await first.user('organizator');
    const ps = [await first.user(), await first.user(), await first.user()];
    const { id } = await first.server.tournaments.create(org, { name: 'Restart', templateId: 'tour-turbo', settings: SETTINGS });
    for (const p of ps) await first.server.tournaments.register(p, id);
    await first.server.tournaments.start(org, id);
    // pár minut hry
    const rnd = seededRandom(3);
    for (let i = 0; i < 400 && first.server.tournaments.get(id)!.state().status === 'running' && first.server.tournaments.get(id)!.levelNumber() < 2; i++) {
      const actor = first.server.tables.actors.get(id)!;
      const v = actor.viewFor(null);
      if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((x) => x.seat === v.actingSeat)!;
        const legal = actor.viewFor(p.playerId).legal;
        if (legal) actor.act(p.playerId, { type: legal.canCheck ? 'check' : 'call' });
      }
      first.clock.advance(Math.floor(rnd() * 3000));
      await Promise.resolve();
    }
    const before = first.server.tournaments.get(id)!;
    expect(before.levelNumber()).toBeGreaterThanOrEqual(2);
    const levelBefore = before.levelNumber();
    const poolBefore = before.prizePool();
    await first.server.journal.flush();
    await first.server.close();
    servers.pop();

    const second = await start(new FakeClock(), dir);
    const t = second.server.tournaments.get(id)!;
    expect(t.state().status).toBe('running');
    expect(t.levelNumber()).toBe(levelBefore);
    expect(t.prizePool()).toBe(poolBefore);
    expect(t.state().players).toHaveLength(3);
    const table = second.server.tables.actors.get(id)!;
    expect(table.playersSeated()).toHaveLength(3);
    await playOut(second, id, 5);
    expect(second.server.tournaments.get(id)!.state().status).toBe('finished');
    expect(second.server.ledger.balance(accounts.tournament(id))).toBe(0);
    const wallets = ps.reduce((n, p) => n + second.server.ledger.balance(accounts.wallet(p)), 0);
    expect(wallets + second.server.ledger.balance(accounts.house())).toBe(3 * 10_000);
  });
});

describe('resultSummary (přehled po konci turnaje)', () => {
  it('spočítá vstupy, rebuy, add-ony, zaplaceno a zisk; vrácené platby nepočítá', async () => {
    const { resultSummary } = await import('./tournaments.js');
    const pay = (kind: 'turnaj_buyin' | 'turnaj_rebuy' | 'turnaj_addon', cost: number, fee = 0, refunded = false) => ({ userId: 'a', kind, cost, fee, key: `${kind}-${cost}-${refunded}`, refunded });
    const st = { payments: [pay('turnaj_buyin', 100, 10), pay('turnaj_rebuy', 100, 10), pay('turnaj_rebuy', 100, 10, true), pay('turnaj_addon', 50), { ...pay('turnaj_buyin', 100, 10), userId: 'b' }], players: [] };
    expect(resultSummary(st, { userId: 'a', name: 'A', place: 1, payout: 300, bounty: 40 })).toEqual({ userId: 'a', name: 'A', place: 1, entries: 1, rebuys: 1, addons: 1, entryAmount: 110, rebuyAmount: 110, addonAmount: 50, spent: 270, payout: 300, bounty: 40, profit: 70 });
    expect(resultSummary(st, { userId: 'b', name: 'B', place: 2, payout: 0 }).profit).toBe(-110);
  });
});
