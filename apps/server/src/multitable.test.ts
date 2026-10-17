import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accounts } from '@kb/ledger';
import { FakeClock, randomLegalAction, seededRandom } from '@kb/game-core';
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
const SETTINGS = { ...FAST, 'table.seats': 3, 'tournament.maxTables': 3, 'tournament.levelMinutes': 1, 'tournament.targetMinutes': 20, 'tournament.startingStack': 1500, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.minPlayers': 2, 'tournament.payoutPreset': 'top3' };

async function start(clock = new FakeClock(), dataDir?: string) {
  const server = await buildServer({
    clock,
    dataDir,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 21), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, 'system.mailRequestsPerHour': 100 },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `M${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}

async function playSome(s: Awaited<ReturnType<typeof start>>, id: string, seed: number, steps: number) {
  const rnd = seededRandom(seed);
  for (let i = 0; i < steps && s.server.tournaments.get(id)!.state().status === 'running'; i++) {
    for (const tableId of s.server.tournaments.tableIdsOf(id)) {
      const actor = s.server.tables.actors.get(tableId);
      if (!actor) continue;
      const v = actor.viewFor(null);
      if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((x) => x.seat === v.actingSeat)!;
        const legal = actor.viewFor(p.playerId).legal;
        if (legal && rnd() < 0.85) actor.act(p.playerId, randomLegalAction(legal, rnd));
      }
    }
    s.clock.advance(Math.floor(rnd() * 3000));
    await Promise.resolve();
  }
}

describe('turnaj na více stolech (server)', { timeout: 180_000 }, () => {
  it('start rozsadí hráče na více stolů, pohled ukazuje stoly a hráč má „svůj stůl“, turnaj se dohraje a peníze sedí', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const players: string[] = [];
    for (let i = 0; i < 7; i++) players.push(await s.user());
    const { id } = await s.server.tournaments.create(org, { name: 'Víc stolů', templateId: 'tour-turbo', settings: SETTINGS });
    for (const p of players) await s.server.tournaments.register(p, id);
    await s.server.tournaments.start(org, id);

    const ids = s.server.tournaments.tableIdsOf(id);
    expect(ids).toEqual([id, `${id}~2`, `${id}~3`]);
    expect(ids.every((t) => s.server.tables.actors.has(t))).toBe(true);
    const v = await s.server.tournaments.view(id, players[0]!);
    expect(v.maxTables).toBe(3);
    expect(v.tables.map((t) => t.players.length).sort()).toEqual([2, 2, 3]);
    expect(v.tables.flatMap((t) => t.players).length).toBe(7);
    expect(v.me.tableId).toBe(s.server.tournaments.tableOfPlayer(id, players[0]!));
    expect(ids).toContain(v.me.tableId);
    // pohled stolu ví, ke kterému turnaji patří
    expect(s.server.tables.actors.get(`${id}~2`)!.viewFor(null).info.tournamentId).toBe(id);
    // chat turnaje je přístupný hráči i bez prvního stolu
    expect(s.server.tournaments.isPlaying(id, players[0]!)).toBe(true);

    await playSome(s, id, 5, 80_000);
    expect(s.server.tournaments.get(id)!.state().status).toBe('finished');
    await s.server.journal.flush();
    const results = s.server.tournaments.get(id)!.state().results!;
    expect(results.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(s.server.ledger.balance(accounts.tournament(id))).toBe(0);
    const wallets = players.reduce((n, p) => n + s.server.ledger.balance(accounts.wallet(p)), 0);
    expect(wallets).toBe(7 * 10_000 - 700 + results.reduce((n, r) => n + r.payout, 0));
    // statistiky hand se ukládají po stolech, ale k jednomu turnaji
    await s.server.stats.idle();
    const hands = await s.server.db.select().from(schema.hands);
    expect(hands.length).toBeGreaterThan(0);
    expect(new Set(hands.map((h) => h.tournamentId))).toEqual(new Set([id]));
    expect(new Set(hands.map((h) => h.tableId)).size).toBeGreaterThan(1);
  });

  it('po restartu serveru se obnoví všechny stoly a turnaj se dohraje', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-multi-'));
    dirs.push(dir);
    const first = await start(new FakeClock(), dir);
    const org = await first.user('organizator');
    const players: string[] = [];
    for (let i = 0; i < 6; i++) players.push(await first.user());
    const { id } = await first.server.tournaments.create(org, { name: 'Restart', templateId: 'tour-turbo', settings: SETTINGS });
    for (const p of players) await first.server.tournaments.register(p, id);
    await first.server.tournaments.start(org, id);
    await playSome(first, id, 3, 4);
    expect(first.server.tournaments.get(id)!.state().status).toBe('running');
    const before = first.server.tournaments.tableIdsOf(id);
    expect(before.length).toBe(2);
    const seatedBefore = new Map(players.map((p) => [p, first.server.tournaments.tableOfPlayer(id, p)]));
    await first.server.journal.flush();
    await first.server.close();
    servers.pop();

    const second = await start(new FakeClock(), dir);
    expect(second.server.tournaments.tableIdsOf(id)).toEqual(before);
    for (const p of players) {
      const was = seatedBefore.get(p);
      if (second.server.tournaments.get(id)!.state().players.find((x) => x.userId === p)?.status === 'out') continue;
      expect(second.server.tournaments.tableOfPlayer(id, p)).toBe(was);
    }
    await playSome(second, id, 9, 80_000);
    expect(second.server.tournaments.get(id)!.state().status).toBe('finished');
    expect(second.server.ledger.balance(accounts.tournament(id))).toBe(0);
  });

  it('výchozí turnaj zůstává na jednom stole', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const ps = [await s.user(), await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, { name: 'Jeden', templateId: 'tour-turbo', settings: { ...SETTINGS, 'tournament.maxTables': 1, 'table.seats': 6 } });
    for (const p of ps) await s.server.tournaments.register(p, id);
    await s.server.tournaments.start(org, id);
    expect(s.server.tournaments.tableIdsOf(id)).toEqual([id]);
    expect((await s.server.tournaments.view(id, org)).tables).toHaveLength(1);
  });
});
