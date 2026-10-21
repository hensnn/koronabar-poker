import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { schema } from './db/index.js';
import { PublicBoardError } from './public-boards.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(over: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  clock.advance(100 * 86_400_000);
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 5), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'stats.publicEnabled': true, ...over },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (nick: string) => {
    const inv = await server.accounts.createInvite(admin!, {});
    n++;
    return (await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick.toLowerCase()}${n}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true })).userId;
  };
  /** Turnajový výsledek: místo, výdaj a výplata (z toho zisk). */
  const result = async (userId: string, ref: string, place: number, spent: number, payout: number, daysAgo = 1) =>
    server.db.insert(schema.gameResults).values({ kind: 'tournament', ref, userId, finishedAt: new Date(clock.now() - daysAgo * 86_400_000), place, field: 4, spent, payout, bounty: 0, rebuys: 0 });
  return { server, clock, admin: admin!, user, result };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof PublicBoardError ? e.code : String(e);
  }
};

describe('veřejné přehledy hráčů', () => {
  it('obsah podle nastavení: řazení, limit, skrytí hráče, přezdívka, peníze; žádné soukromé údaje', async () => {
    const c = await start();
    const [a, b, d, h] = [await c.user('Karel'), await c.user('Lenka'), await c.user('Milan'), await c.user('Skryty')];
    await c.result(a, 't1', 1, 100, 400);
    await c.result(b, 't1', 2, 100, 200);
    await c.result(d, 't1', 3, 100, 0);
    await c.result(h, 't1', 4, 100, 0);
    c.server.progress.grant(b, 'test', 500);
    await c.server.progress.idle();
    const created = await c.server.publicBoards.create(c.admin, { name: 'Domácí liga', config: { columns: ['profit', 'xp', 'level', 'games'], limit: 3, hiddenUserIds: [h] } });
    const v = await c.server.publicBoards.view(created.token, '1.1.1.1');
    expect(v.title).toBe('Domácí liga');
    expect(v.rows.map((r) => r.nickname)).toEqual(['Karel', 'Lenka', 'Milan']);
    expect(v.rows[0]).toMatchObject({ rank: 1, profit: 300, games: 1 });
    expect(v.rows.find((r) => r.nickname === 'Lenka')!.xp).toBe(500);
    // soukromé údaje se neposílají
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/@example\.cz/);
    expect(json).not.toContain(a);
    expect(json).not.toContain('Skryty');

    // peníze skryté, jen první písmeno, řazení podle zkušeností
    await c.server.publicBoards.update(c.admin, created.id, { config: { columns: ['profit', 'cashProfit', 'bounty', 'xp'], showMoney: false, nameMode: 'initial', sort: 'xp', limit: 0 } });
    const w = await c.server.publicBoards.view(created.token, '1.1.1.2');
    expect(w.columns).toEqual(['xp']);
    expect(w.rows[0]).toMatchObject({ nickname: 'L•••', xp: 500 });
    expect(w.rows[0]).not.toHaveProperty('profit');
    expect(w.rows.every((r) => !('bounty' in r))).toBe(true);
  });

  it('stav peněženky a graf vývoje zisku z turnajů; bez částek žádné z toho', async () => {
    const c = await start();
    const [a, b] = [await c.user('Alfa'), await c.user('Beta')];
    await c.result(a, 't1', 1, 100, 400, 10);
    await c.result(a, 't2', 2, 100, 50, 5);
    await c.result(b, 't1', 2, 100, 0, 10);
    const board = await c.server.publicBoards.create(c.admin, { name: 'G', config: { columns: ['profit', 'balance'], chartPlayers: 1, limit: 0 } });
    const v = await c.server.publicBoards.view(board.token, '5.5.5.5');
    expect(v.columns).toEqual(['profit', 'balance']);
    expect(typeof v.rows[0]!.balance).toBe('number');
    expect(v.chart).toHaveLength(1);
    expect(v.chart[0]!.name).toBe('Alfa');
    expect(v.chart[0]!.points.map((p) => p[1])).toEqual([300, 250]);
    expect(JSON.stringify(v)).not.toContain(a);
    await c.server.publicBoards.update(c.admin, board.id, { config: { columns: ['profit', 'balance'], showMoney: false } });
    const w = await c.server.publicBoards.view(board.token, '5.5.5.6');
    expect(w.chart).toEqual([]);
    expect(w.rows.every((r) => !('balance' in r) && !('profit' in r))).toBe(true);
  });

  it('období: starší výsledky se nezapočítají; minimum her', async () => {
    const c = await start();
    const [a, b] = [await c.user('Stary'), await c.user('Novy')];
    await c.result(a, 'old', 1, 100, 900, 200);
    await c.result(b, 'new', 1, 100, 300, 5);
    const board = await c.server.publicBoards.create(c.admin, { name: 'P', config: { columns: ['profit', 'games'], periodDays: 30, limit: 0 } });
    const v = await c.server.publicBoards.view(board.token, '2.2.2.2');
    expect(v.rows.map((r) => r.nickname)).toEqual(['Novy']);
    await c.server.publicBoards.update(c.admin, board.id, { config: { columns: ['profit', 'games'], periodDays: 0, minGames: 2, limit: 0 } });
    expect((await c.server.publicBoards.view(board.token, '2.2.2.3')).rows).toEqual([]);
  });

  it('neexistující, vypnutý, vyměněný odkaz i vypnutá funkce vypadají stejně: nenalezeno', async () => {
    const c = await start();
    const board = await c.server.publicBoards.create(c.admin, { name: 'Odkaz' });
    expect(await code(c.server.publicBoards.view(board.token, '3.3.3.3'))).toBe('OK');
    expect(await code(c.server.publicBoards.view('x'.repeat(30), '3.3.3.3'))).toBe('NOT_FOUND');
    expect(await code(c.server.publicBoards.view('kratky', '3.3.3.3'))).toBe('NOT_FOUND');
    await c.server.publicBoards.update(c.admin, board.id, { enabled: false });
    expect(await code(c.server.publicBoards.view(board.token, '3.3.3.3'))).toBe('NOT_FOUND');
    await c.server.publicBoards.update(c.admin, board.id, { enabled: true });
    const rotated = await c.server.publicBoards.rotate(c.admin, board.id);
    expect(rotated.token).not.toBe(board.token);
    expect(await code(c.server.publicBoards.view(board.token, '3.3.3.3'))).toBe('NOT_FOUND');
    expect(await code(c.server.publicBoards.view(rotated.token, '3.3.3.3'))).toBe('OK');
    await c.server.publicBoards.remove(c.admin, board.id);
    expect(await code(c.server.publicBoards.view(rotated.token, '3.3.3.3'))).toBe('NOT_FOUND');

    const off = await start({ 'stats.publicEnabled': false });
    const b2 = await off.server.publicBoards.create(off.admin, { name: 'Vypnuto' });
    expect(await code(off.server.publicBoards.view(b2.token, '4.4.4.4'))).toBe('NOT_FOUND');
  });

  it('správa jen s oprávněním a omezení počtu dotazů z jedné adresy', async () => {
    const c = await start();
    const hrac = await c.user('Hrac');
    expect(await code(c.server.publicBoards.create(hrac, { name: 'X' }))).toBe('FORBIDDEN');
    expect(await code(c.server.publicBoards.list(hrac))).toBe('FORBIDDEN');
    expect(await code(c.server.publicBoards.create(c.admin, { name: '  ' }))).toBe('INVALID');
    const board = await c.server.publicBoards.create(c.admin, { name: 'Limit' });
    let limited = 0;
    for (let i = 0; i < 70; i++) if ((await code(c.server.publicBoards.view(board.token, '9.9.9.9'))) === 'RATE_LIMIT') limited++;
    expect(limited).toBeGreaterThan(0);
    // jiná adresa to neovlivní
    expect(await code(c.server.publicBoards.view(board.token, '8.8.8.8'))).toBe('OK');
  });

  it('veřejná stránka přes HTTP: bez přihlášení, bez indexace', async () => {
    const c = await start();
    const board = await c.server.publicBoards.create(c.admin, { name: 'HTTP' });
    const ok = await c.server.app.inject({ method: 'GET', url: `/api/public/board/${board.token}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-robots-tag']).toContain('noindex');
    expect(ok.json().title).toBe('HTTP');
    expect(ok.json().appearance).toMatchObject({ background: 'felt', width: 'normal', medals: true });
    // vzhled uložený u přehledu se promítne do veřejné stránky
    await c.server.publicBoards.update(c.admin, board.id, { config: { appearance: { width: 'wide', density: 'compact', colorMode: 'dark', footerText: 'Liga u Karla' } } });
    c.clock.advance(60_000);
    const styled = await c.server.app.inject({ method: 'GET', url: `/api/public/board/${board.token}` });
    expect(styled.json().appearance).toMatchObject({ width: 'wide', density: 'compact', colorMode: 'dark', footerText: 'Liga u Karla' });
    expect((await c.server.app.inject({ method: 'GET', url: '/api/public/board/neexistuje-neexistuje-neexistuje' })).statusCode).toBe(404);
    expect((await c.server.app.inject({ method: 'GET', url: '/api/admin/public-boards' })).statusCode).toBe(401);
  });
});
