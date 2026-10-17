import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock, randomLegalAction, seededRandom, TournamentError } from '@kb/game-core';
import { buildServer } from './app.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const MIN = 60_000;
const FAST = {
  'time.betweenHandsMs': 100,
  'time.allInRunoutDelayMs': 50,
  'time.allInRiverDramaMs': 50,
  'time.showdownMs': 50,
  'time.potToWinnerMs': 50,
  'time.turnSeconds': 3,
  'odds.enabled': false,
  'tournament.levelMinutes': 1,
  'tournament.targetMinutes': 12,
  'tournament.startingStack': 1000,
  'tournament.buyIn': 50,
  'tournament.fee': 0,
  'tournament.minPlayers': 3,
  'tournament.autoStartWhenFull': false,
};

async function start() {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
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
    const nick = `L${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}
type Ctx = Awaited<ReturnType<typeof start>>;

/** Naplánuje turnaj série za minutu, přihlásí hráče, nechá ho spustit plánovač a dohraje ho boty. */
async function playTournament(c: Ctx, org: string, players: string[], seriesId: string, seed: number, extra: Record<string, number | boolean | string> = {}) {
  const { id } = await c.server.tournaments.scheduleTournament(org, { name: `Kolo ${seed}`, templateId: 'tour-turbo', settings: { ...FAST, ...extra }, startAt: c.clock.now() + MIN, seriesId });
  for (const p of players) await c.server.tournaments.register(p, id);
  c.clock.advance(MIN + 1000);
  await c.server.scheduler.tick();
  const actor = c.server.tables.actors.get(id)!;
  for (const p of players) {
    actor.setConnected(p, true);
    try {
      actor.sitIn(p);
    } catch {
      /* už hraje */
    }
  }
  const rnd = seededRandom(seed);
  for (let i = 0; i < 30_000 && c.server.tournaments.get(id)!.state().status === 'running'; i++) {
    const v = actor.viewFor(null);
    if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
      const pl = v.seats.find((x) => x.seat === v.actingSeat)!;
      const legal = actor.viewFor(pl.playerId).legal;
      if (legal) actor.act(pl.playerId, randomLegalAction(legal, rnd));
    }
    c.clock.advance(Math.floor(rnd() * 3000));
    await Promise.resolve();
  }
  expect(c.server.tournaments.get(id)!.state().status).toBe('finished');
  return id;
}

describe('série a ligy', { timeout: 300_000 }, () => {
  it('bodování z odehraných turnajů, žebříček série a finále jen pro nejlepší hráče', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const ps = [await c.user(), await c.user(), await c.user(), await c.user()];
    const { id: seriesId } = await c.server.series.create(org, { name: 'Podzimní liga', config: { table: [10, 6, 3], participation: 1, finalTopN: 3 } });
    await expect(c.server.series.create(ps[3]!, { name: 'Cizí liga' })).rejects.toThrow(/FORBIDDEN/);

    const t1 = await playTournament(c, org, [ps[0]!, ps[1]!, ps[2]!], seriesId, 1);
    const t2 = await playTournament(c, org, [ps[1]!, ps[2]!, ps[3]!], seriesId, 2);
    // výsledky turnajů jdou i do statistik a žebříčku
    await c.server.stats.idle();
    const lb = await c.server.stats.leaderboard({ from: null, to: null });
    expect(lb.reduce((n, r) => n + r.games, 0)).toBe(6);
    expect(lb.reduce((n, r) => n + r.wins, 0)).toBe(2);
    expect(lb.reduce((n, r) => n + r.tournamentNet, 0)).toBe(0);
    const view = await c.server.series.view(seriesId);
    expect(view.tournaments.map((t) => t.id)).toEqual([t1, t2]);
    expect(view.standings.length).toBe(4);
    // body: za místo (10/6/3) + 1 za účast; součet všech bodů = 2 × (10+6+3) + 6 účastí
    expect(view.standings.reduce((n, r) => n + r.total, 0)).toBe(2 * 19 + 6);
    const results1 = c.server.tournaments.get(t1)!.state().results!;
    const winner1 = results1[0]!.userId;
    const row = view.standings.find((r) => r.userId === winner1)!;
    expect(row.perTournament[t1]).toBe(11);
    expect(row.wins).toBeGreaterThanOrEqual(1);
    expect(view.standings[0]!.rank).toBe(1);
    expect(view.finalists).toHaveLength(3);
    expect(view.finalists).toEqual(view.standings.slice(0, 3).map((r) => r.userId));

    // finále: přihlásit se smějí jen finalisté
    const fin = await c.server.series.createFinal(org, seriesId, { templateId: 'tour-turbo', settings: { ...FAST }, startAt: c.clock.now() + 60 * MIN });
    const outside = ps.find((p) => !view.finalists.includes(p))!;
    const inside = view.finalists[0]!;
    await expect(c.server.tournaments.register(outside, fin.id)).rejects.toThrow(/FORBIDDEN/);
    await c.server.tournaments.register(inside, fin.id);
    expect((await c.server.tournaments.view(fin.id, outside)).me.canRegister).toBe(false);
    expect((await c.server.tournaments.view(fin.id, inside)).schedule!.invited).toEqual(view.finalists);
    // finále se nepočítá do žebříčku a druhé finále nejde založit
    expect((await c.server.series.view(seriesId)).finalId).toBe(fin.id);
    await expect(c.server.series.createFinal(org, seriesId, { templateId: 'tour-turbo', startAt: c.clock.now() + 120 * MIN })).rejects.toBeInstanceOf(TournamentError);
  });

  it('nastavení bodování jde měnit a žebříček se přepočítá; neplatné se odmítne', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const ps = [await c.user(), await c.user(), await c.user()];
    const { id: seriesId } = await c.server.series.create(org, { name: 'Liga', config: { table: [10, 6, 3], participation: 0 } });
    await playTournament(c, org, ps, seriesId, 3);
    const before = (await c.server.series.view(seriesId)).standings.reduce((n, r) => n + r.total, 0);
    expect(before).toBe(19);
    await c.server.series.update(org, seriesId, { config: { mode: 'linear', linearFactor: 5, participation: 0 } });
    const after = (await c.server.series.view(seriesId)).standings.reduce((n, r) => n + r.total, 0);
    expect(after).toBe((3 + 2 + 1) * 5);
    await expect(c.server.series.update(org, seriesId, { config: { table: [-1] } })).rejects.toBeInstanceOf(TournamentError);
    await c.server.series.remove(org, seriesId);
    await expect(c.server.series.view(seriesId)).rejects.toBeInstanceOf(TournamentError);
  });
});
