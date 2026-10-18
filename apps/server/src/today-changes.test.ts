import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { accounts } from '@kb/ledger';
import { FakeClock, randomLegalAction, seededRandom } from '@kb/game-core';
import { buildServer } from './app.js';

// Dnešní změny na serveru: výsledek handy v chatu (cash i turnaj), přehled a push výsledků turnaje,
// rozšířené informace o stole a ochrana seznamu stolů.

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const FAST = { 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.turnSeconds': 5, 'odds.enabled': false };

async function start() {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 9), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, 'system.mailRequestsPerHour': 10_000 },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `D${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return { userId, nick };
  };
  return { server, clock, admin: admin!, user };
}

async function chatBodies(s: Awaited<ReturnType<typeof start>>, key: string): Promise<string[]> {
  const channelId = (await s.server.chat.channelIdByKey(key))!;
  expect(channelId).toBeTruthy();
  return (await s.server.chat.history(s.admin, channelId)).map((m) => m.body);
}

describe('výsledek handy v chatu u stolu', () => {
  it('cash: po každé handě přibude zpráva s vítězem, částkou a boardem', async () => {
    const s = await start();
    const org = (await s.user('organizator')).userId;
    const [a, b] = [await s.user(), await s.user()];
    const { id } = await s.server.tables.createTable(org, { name: 'Chat test', templateId: 'cash-klasika', settings: FAST });
    const actor = s.server.tables.actors.get(id)!;
    actor.join(a.userId, a.nick, 0, 500);
    actor.join(b.userId, b.nick, 1, 500);
    s.clock.advance(150);
    const rnd = seededRandom(5);
    for (let i = 0; i < 300 && actor.currentPhase() !== 'pause'; i++) {
      const v = actor.viewFor(null);
      if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((x) => x.seat === v.actingSeat)!;
        const legal = actor.viewFor(p.playerId).legal;
        if (legal) actor.act(p.playerId, randomLegalAction(legal, rnd));
      }
      s.clock.advance(300);
    }
    await new Promise((r) => setTimeout(r, 200));
    const msgs = (await chatBodies(s, 'table:' + id)).filter((m) => m.startsWith('Handa č.'));
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]).toMatch(/Handa č\. 1: .+ vyhrál \d+/);
    expect(msgs.some((m) => m.includes(a.nick) || m.includes(b.nick))).toBe(true);
  });

  it('turnaj: výsledek handy je i v chatu turnaje a po konci přijde výsledek každému účastníkovi (socket)', async () => {
    const s = await start();
    const org = (await s.user('organizator')).userId;
    const players = [await s.user(), await s.user()];
    const port = await s.server.listen(0);
    // přihlášený socket prvního hráče
    const sess = await s.server.accounts.login(players[0]!.nick, 'heslo-hrace-123');
    const cookie = `kb_session=${sess.token}`;
    const sock = connect(`http://127.0.0.1:${port}`, { extraHeaders: { cookie, origin: 'http://localhost' }, transports: ['websocket'], transportOptions: { websocket: { extraHeaders: { cookie, origin: 'http://localhost' } } } });
    sockets.push(sock);
    const got: { id: string; name: string; summary: { userId: string; place: number; profit: number }[] }[] = [];
    sock.on('tournament:result', (r) => got.push(r));
    await new Promise<void>((resolve) => sock.on('hello', () => resolve()));

    const { id } = await s.server.tournaments.create(org, { name: 'Výsledky', templateId: 'tour-headsup', settings: { ...FAST, 'tournament.startingStack': 200, 'tournament.buyIn': 100, 'tournament.fee': 10, 'tournament.minPlayers': 2 } });
    for (const p of players) await s.server.tournaments.register(p.userId, id);
    if (s.server.tournaments.get(id)!.state().status === 'registering') await s.server.tournaments.start(org, id);
    const actor = s.server.tables.actors.get(id)!;
    const rnd = seededRandom(11);
    for (let i = 0; i < 20_000 && s.server.tournaments.get(id)!.state().status === 'running'; i++) {
      const v = actor.viewFor(null);
      if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((x) => x.seat === v.actingSeat)!;
        const legal = actor.viewFor(p.playerId).legal;
        if (legal && rnd() < 0.9) actor.act(p.playerId, randomLegalAction(legal, rnd));
      }
      s.clock.advance(Math.floor(rnd() * 3000));
      await Promise.resolve();
    }
    await new Promise((r) => setTimeout(r, 300));
    const view = await s.server.tournaments.view(id, players[0]!.userId);
    expect(view.status).toBe('finished');
    expect((await chatBodies(s, 'table:' + id)).some((m) => m.startsWith('Handa č.'))).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe(id);
    expect(got[0]!.summary.map((r) => r.place)).toEqual([1, 2]);
    // přehled souhlasí s peněženkami
    for (const row of got[0]!.summary) {
      const before = 10_000;
      expect(s.server.ledger.balance(accounts.wallet(row.userId)) - before).toBe(row.profit);
    }
  });
});

describe('informace o stole', () => {
  it('pohled nese ante, run it, bomb pot a 7-2 bonus podle nastavení stolu', async () => {
    const s = await start();
    const org = (await s.user('organizator')).userId;
    const { id } = await s.server.tables.createTable(org, {
      name: 'Info test',
      templateId: 'cash-klasika',
      settings: { ...FAST, 'table.ante': 2, 'table.bbAnte': true, 'special.runItTwice': true, 'special.runItTimes': 3, 'special.bombPot': true, 'special.bombPotEveryHands': 5, 'special.sevenTwoBonus': true, 'special.sevenTwoAmountBb': 2 },
    });
    const info = s.server.tables.actors.get(id)!.viewFor(null).info;
    expect(info).toMatchObject({ ante: 2 * info.chipsPerCurrencyUnit, bbAnte: true, runIt: 3, bombPotEvery: 5, sevenTwoBb: 2 });
    const plain = await s.server.tables.createTable(org, { name: 'Prosty', templateId: 'cash-klasika', settings: FAST });
    expect(s.server.tables.actors.get(plain.id)!.viewFor(null).info).toMatchObject({ runIt: 0, bombPotEvery: 0, sevenTwoBb: 0 });
  });

  it('seznam stolů a struktury blindů je jen pro přihlášené', async () => {
    const s = await start();
    for (const url of ['/api/tables', '/api/structures']) {
      expect((await s.server.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });
});
