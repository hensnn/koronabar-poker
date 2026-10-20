import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { schema } from './db/index.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(over: Record<string, string | number | boolean> = {}) {
  const server = await buildServer({
    clock: new FakeClock(),
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 3), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', ...over },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  const { userId: player } = await server.accounts.register({ inviteCode: inv, nickname: 'Hrac', email: 'hrac@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
  return { server, admin: admin!, player };
}

describe('přehled mezi hráči', () => {
  it('ukáže všechny aktivní hráče se zůstatkem a úrovní; srovnání vrací řady po hráčích', async () => {
    const s = await start();
    await s.server.wallet.topUp(s.admin, s.player, 500, 'test');
    s.server.progress.grant(s.player, 'x', 90);
    await s.server.progress.idle();
    await s.server.journal.flush();
    const o = await s.server.overview.overview();
    expect(o.rows.map((r) => r.nickname).sort()).toEqual(['Admin', 'Hrac']);
    const me = o.rows.find((r) => r.userId === s.player)!;
    expect(me.balance).toBe(10_500);
    expect(me.xp).toBe(90);
    expect(me.level).toBeGreaterThanOrEqual(1);
    const bal = await s.server.overview.compare([s.player, s.admin], 'balance');
    expect(bal.series).toHaveLength(2);
    expect(bal.series.find((x) => x.userId === s.player)!.points.at(-1)![1]).toBe(10_500);
    const xp = await s.server.overview.compare([s.player], 'xp');
    expect(xp.series[0]!.points.at(-1)![1]).toBe(90);
    const profit = await s.server.overview.compare([s.player], 'profit');
    expect(profit.series[0]!.points).toEqual([]);
    await expect(s.server.overview.compare([], 'balance')).rejects.toThrow('INVALID');
  });

  it('správce přehled vypne: čísla ostatních se nevydají', async () => {
    const s = await start({ 'stats.publicOverview': false });
    await expect(s.server.overview.overview()).rejects.toThrow('HIDDEN');
    await expect(s.server.overview.compare([s.player], 'balance')).rejects.toThrow('HIDDEN');
  });
});

describe('kategorie kdo je v čem nejlepší (HTTP)', () => {
  it('vrací kategorie jen přihlášenému a respektuje skrytý přehled', async () => {
    const s = await start();
    await s.server.wallet.topUp(s.admin, s.player, 500, 'test');
    expect((await s.server.app.inject({ method: 'GET', url: '/api/stats/categories' })).statusCode).toBe(401);
    const login = await s.server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'Hrac', password: 'heslo-hrace-123' }, headers: { origin: 'http://localhost' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const ok = await s.server.app.inject({ method: 'GET', url: '/api/stats/categories', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    const bal = (ok.json() as { categories: { id: string; entries: { nickname: string; value: number }[] }[] }).categories.find((c) => c.id === 'balance');
    expect(bal?.entries[0]?.nickname).toBe('Hrac');
    expect(bal!.entries[0]!.value).toBeGreaterThanOrEqual(500);

    const hidden = await start({ 'stats.publicOverview': false });
    const l2 = await hidden.server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'Hrac', password: 'heslo-hrace-123' }, headers: { origin: 'http://localhost' } });
    const r = await hidden.server.app.inject({ method: 'GET', url: '/api/stats/categories', headers: { cookie: String(l2.headers['set-cookie']).split(';')[0]! } });
    expect(r.statusCode).toBe(403);
  });
});

describe('účet domu: vklad a výdaje (HTTP)', () => {
  it('správce vloží měnu do domu a zapíše výdaje s kategorií; přehled je sečte, dům nejde do mínusu, hráč nemá přístup', async () => {
    const s = await start();
    const login = async (identifier: string, password: string) => String((await s.server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier, password }, headers: { origin: 'http://localhost' } })).headers['set-cookie']).split(';')[0]!;
    const admin = await login('Admin', 'admin-heslo-123');
    const post = (url: string, payload: unknown, cookie = admin) => s.server.app.inject({ method: 'POST', url, headers: { cookie, origin: 'http://localhost' }, payload: payload as never });
    const report = async () => (await s.server.app.inject({ method: 'GET', url: '/api/admin/house/report', headers: { cookie: admin } })).json() as { house: number; categories: string[]; expenses: { category: string; amount: number; note: string }[]; month: { total: number; byCategory: Record<string, number> }; year: { total: number }; income: { month: number } };
    const before = (await report()).house;

    expect((await post('/api/admin/wallet/house', { amount: 5000, reason: 'Počáteční vklad' })).statusCode).toBe(200);
    expect((await report()).house).toBe(before + 5000);

    expect((await post('/api/admin/house/expense', { category: 'provoz', amount: 1200, note: 'Server za měsíc' })).statusCode).toBe(200);
    expect((await post('/api/admin/house/expense', { category: 'ceny', amount: 300, note: 'Cena pro vítěze' })).statusCode).toBe(200);
    const r = await report();
    expect(r.house).toBe(before + 5000 - 1500);
    expect(r.categories).toEqual(['provoz', 'ceny', 'akce', 'ostatni']);
    expect(r.month.byCategory).toEqual({ provoz: 1200, ceny: 300 });
    expect(r.year.total).toBe(1500);
    expect(r.income.month).toBeGreaterThanOrEqual(5000);
    expect(r.expenses.map((e) => e.note)).toEqual(expect.arrayContaining(['Server za měsíc', 'Cena pro vítěze']));

    // neznámá kategorie, nulová částka i výdaj nad zůstatek domu se odmítnou
    expect((await post('/api/admin/house/expense', { category: 'neznama', amount: 10, note: 'x' })).statusCode).toBe(400);
    expect((await post('/api/admin/house/expense', { category: 'provoz', amount: 999_999_999, note: 'x' })).statusCode).toBe(409);
    expect((await report()).house).toBe(before + 3500);

    const player = await login('Hrac', 'heslo-hrace-123');
    expect((await post('/api/admin/wallet/house', { amount: 10, reason: 'x' }, player)).statusCode).toBe(403);
    expect((await post('/api/admin/house/expense', { category: 'provoz', amount: 10, note: 'x' }, player)).statusCode).toBe(403);
    expect((await s.server.app.inject({ method: 'GET', url: '/api/admin/house/report', headers: { cookie: player } })).statusCode).toBe(403);
  });
});

describe('výdaje domu spravuje i pokladník (se schválením)', () => {
  it('pokladník výdaj navrhne, hlavní správce ho schválí a teprve potom je v přehledu a v knize', async () => {
    const s = await start();
    const login = async (identifier: string, password: string) => String((await s.server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier, password }, headers: { origin: 'http://localhost' } })).headers['set-cookie']).split(';')[0]!;
    await s.server.perms.assignRole(s.admin, s.player, s.server.perms.roleByKey('pokladnik')!.id);
    const admin = await login('Admin', 'admin-heslo-123');
    const pok = await login('Hrac', 'heslo-hrace-123');
    const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown) => s.server.app.inject({ method, url, headers: { cookie, origin: 'http://localhost' }, payload: payload as never });
    await call('POST', '/api/admin/wallet/house', admin, { amount: 3000, reason: 'Vklad' });
    const report = async () => (await call('GET', '/api/admin/house/report', pok)).json() as { house: number; expenses: { note: string }[]; month: { total: number } };
    const before = await report();

    const req = await call('POST', '/api/admin/house/expense', pok, { category: 'provoz', amount: 400, note: 'Doména' });
    expect(req.json()).toMatchObject({ done: false });
    expect((await report()).expenses).toHaveLength(0);
    expect((await report()).house).toBe(before.house);

    const [approval] = await s.server.db.select().from(schema.approvalRequests);
    const decide = await call('POST', `/api/approvals/${approval!.id}/decide`, admin, { approve: true });
    expect(decide.statusCode).toBe(200);
    const after = await report();
    expect(after.house).toBe(before.house - 400);
    expect(after.expenses.map((e) => e.note)).toEqual(['Doména']);
    expect(after.month.total).toBe(400);
  });
});
