import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock, type TableView } from '@kb/game-core';
import { buildServer } from './app.js';
import { publicTable, TvError } from './tv.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(settings: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 17), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `V${n++}x`;
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
    if (e instanceof TvError) return e.code;
    throw e;
  }
};

describe('TV režim: zařízení', { timeout: 60_000 }, () => {
  it('kód platí jednou a vyprší, token jde odvolat a nový kód ho zneplatní', async () => {
    const s = await start();
    const player = await s.user();
    expect(await code(s.server.tv.createDevice(player, 'Obývák', null))).toBe('FORBIDDEN');
    const d = await s.server.tv.createDevice(s.admin, 'Obývák', null);
    expect(d.code).toMatch(/^[A-Z2-9]{8}$/);

    const paired = await s.server.tv.pair(d.code.toLowerCase(), '1.1.1.1');
    expect(await code(s.server.tv.pair(d.code, '1.1.1.1'))).toBe('CODE_INVALID');
    const snap = await s.server.tv.snapshot(paired.token);
    expect(snap.device.name).toBe('Obývák');
    expect(await code(s.server.tv.snapshot('špatný'))).toBe('UNAUTHORIZED');
    expect(await code(s.server.tv.snapshot(undefined))).toBe('UNAUTHORIZED');

    // token se v databázi neukládá
    const rows = await s.server.db.select().from((await import('./db/index.js')).schema.tvDevices);
    expect(JSON.stringify(rows)).not.toContain(paired.token);
    expect(JSON.stringify(rows)).not.toContain(d.code);

    const renewed = await s.server.tv.renewCode(s.admin, d.id);
    expect(await code(s.server.tv.snapshot(paired.token))).toBe('UNAUTHORIZED');
    s.clock.advance(11 * 60_000);
    expect(await code(s.server.tv.pair(renewed.code, '1.1.1.1'))).toBe('CODE_INVALID');

    const again = await s.server.tv.renewCode(s.admin, d.id);
    const second = await s.server.tv.pair(again.code, '1.1.1.1');
    await s.server.tv.removeDevice(s.admin, d.id);
    expect(await code(s.server.tv.snapshot(second.token))).toBe('UNAUTHORIZED');
    const audit = await s.server.audit.list({ action: 'tv.zarizeni_odvolat' });
    expect(audit).toHaveLength(1);
  });

  it('po deseti chybných kódech se adresa na čas zablokuje', async () => {
    const s = await start();
    const d = await s.server.tv.createDevice(s.admin, 'Kuchyň', null);
    for (let i = 0; i < 10; i++) expect(await code(s.server.tv.pair('ZZZZZZZZ', '2.2.2.2'))).toBe('CODE_INVALID');
    expect(await code(s.server.tv.pair(d.code, '2.2.2.2'))).toBe('RATE');
    expect(await code(s.server.tv.pair(d.code, '3.3.3.3'))).toBe('OK');
  });

  it('vypnutý TV režim nic nevydá', async () => {
    const s = await start({ 'tv.enabled': false });
    expect(await code(s.server.tv.createDevice(s.admin, 'Obývák', null))).toBe('DISABLED');
    expect(await code(s.server.tv.snapshot('x'))).toBe('DISABLED');
  });

  it('rozvržení se ověřuje a snapshot používá rozvržení zařízení', async () => {
    const s = await start();
    expect(await code(s.server.tv.saveLayouts(s.admin, [{ id: 'Špatné ID', name: 'x', screens: [{ type: 'clock' }] }]))).toBe('INVALID');
    expect(await code(s.server.tv.saveLayouts(s.admin, [{ id: 'a', name: 'x', screens: [{ type: 'nesmysl' }] }]))).toBe('INVALID');
    expect(await code(s.server.tv.saveLayouts(s.admin, [{ id: 'a', name: 'x', screens: [{ type: 'clock', seconds: 1 }] }]))).toBe('INVALID');
    await s.server.tv.saveLayouts(s.admin, [{ id: 'jen-hodiny', name: 'Jen hodiny', screens: [{ type: 'clock', seconds: 20 }, { type: 'leaderboard' }], fontScalePercent: 150, strip: false }]);
    const d = await s.server.tv.createDevice(s.admin, 'Hospoda', 'jen-hodiny');
    const { token } = await s.server.tv.pair(d.code, '4.4.4.4');
    const snap = await s.server.tv.snapshot(token);
    expect(snap.layout.screens).toEqual([
      { type: 'clock', seconds: 20 },
      { type: 'leaderboard', seconds: 15 },
    ]);
    expect(snap.layout.fontScalePercent).toBe(150);
    expect(snap.ticker).toEqual([]);
    const plain = await s.server.tv.createDevice(s.admin, 'Bar', null);
    const snap2 = await s.server.tv.snapshot((await s.server.tv.pair(plain.code, '4.4.4.4')).token);
    expect(snap2.layout.screens).toHaveLength(8);
  });
});

describe('TV režim: obsah', { timeout: 60_000 }, () => {
  it('hodiny a výplaty živého turnaje jsou ve snapshotu, bez ID hráčů a bez soukromých údajů', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [a, b] = [await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, {
      name: 'Hospoda',
      templateId: 'tour-turbo',
      settings: { 'tournament.live': true, 'tournament.buyIn': 100, 'tournament.fee': 10, 'tournament.minPlayers': 2, 'tournament.startingStack': 1500, 'table.seats': 9 },
    });
    await s.server.tournaments.liveRegister(org, id, a);
    await s.server.tournaments.liveRegister(org, id, b);
    await s.server.tournaments.start(org, id);
    const d = await s.server.tv.createDevice(s.admin, 'TV', null);
    const snap = await s.server.tv.snapshot((await s.server.tv.pair(d.code, '5.5.5.5')).token);
    const t = snap.tournaments[0]!;
    expect(t).toMatchObject({ name: 'Hospoda', status: 'running', live: true, players: 2, alive: 2, avgStack: 1500, prizePool: 200 });
    expect(t.level).not.toBeNull();
    expect(t.clockMs).toBeGreaterThan(0);
    const json = JSON.stringify(snap);
    for (const secret of [a, b, org, 'hlas', 'email', 'example.cz']) expect(json).not.toContain(secret);
  });

  it('přenos stolu je zpožděný a karty hráčů se do něj nedostanou', async () => {
    const s = await start({ 'tv.tableDelaySeconds': 5, 'tv.cardsMode': 'never' });
    const org = await s.user('organizator');
    const players = [await s.user(), await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, {
      name: 'Online',
      templateId: 'tour-turbo',
      settings: { 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.turnSeconds': 30, 'odds.enabled': false, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.minPlayers': 2 },
    });
    for (const p of players) await s.server.tournaments.register(p, id);
    await s.server.tournaments.start(org, id);
    const d = await s.server.tv.createDevice(s.admin, 'TV', null);
    const { token } = await s.server.tv.pair(d.code, '6.6.6.6');

    const first = await s.server.tv.snapshot(token);
    expect(first.tables['auto']?.ready).toBe(false);
    const actor = s.server.tables.actors.get(id)!;
    for (let i = 0; i < 80 && actor.currentPhase() !== 'hand'; i++) {
      s.clock.advance(200);
      await Promise.resolve();
    }
    expect(actor.currentPhase()).toBe('hand');
    const hole = players.flatMap((p) => actor.viewFor(p).seats.find((x) => x.playerId === p)?.cards ?? []);
    expect(hole.length).toBeGreaterThan(0);
    const during = await s.server.tv.snapshot(token);
    expect(JSON.stringify(during)).not.toMatch(new RegExp(`"(${hole.join('|')})"`));
    s.clock.advance(6000);
    await Promise.resolve();
    const later = await s.server.tv.snapshot(token);
    expect(later.tables['auto']?.ready).toBe(true);
    expect(later.tables['auto']!.view!.seats.every((x) => x.cards === null)).toBe(true);
  });
});

describe('publicTable', () => {
  const view = (winners: TableView['winners']) =>
    ({
      handNumber: 3,
      street: 'river',
      board: ['Ah', 'Kd', '2c', '7s', '9h'],
      buttonSeat: 0,
      actingSeat: null,
      info: { seatCount: 9, smallBlind: 1, bigBlind: 2, tournament: false },
      seats: [{ seat: 0, playerId: 'secret-id', name: 'Petr', stack: 100, bet: 0, status: 'active', isDealer: true, cards: ['As', 'Ks'], hasCards: true, timeBank: 5 }],
      totalPot: 20,
      winners,
      legal: { fold: true },
      vote: { id: 'x' },
      odds: [{ pot: 1 }],
    }) as unknown as TableView;

  it('karty podle režimu a žádná skrytá data navíc', () => {
    const running = view(null);
    expect(publicTable(running, 'never').seats[0]!.cards).toBeNull();
    expect(publicTable(running, 'afterHand').seats[0]!.cards).toBeNull();
    expect(publicTable(running, 'spectator').seats[0]!.cards).toEqual(['As', 'Ks']);
    const done = view([{ seat: 0, amount: 20, hand: null }]);
    expect(publicTable(done, 'afterHand').seats[0]!.cards).toEqual(['As', 'Ks']);
    expect(publicTable(done, 'never').seats[0]!.cards).toBeNull();
    const json = JSON.stringify(publicTable(done, 'afterHand'));
    for (const hidden of ['secret-id', 'legal', 'vote', 'odds', 'timeBank']) expect(json).not.toContain(hidden);
  });
});
