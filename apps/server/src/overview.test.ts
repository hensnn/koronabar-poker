import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';

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

describe('vklad do domu a výběr z domu (HTTP)', () => {
  it('správce vloží měnu do domu a vybere; kniha zůstane vyrovnaná, hráč to nesmí', async () => {
    const s = await start();
    const login = async (identifier: string, password: string) => String((await s.server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier, password }, headers: { origin: 'http://localhost' } })).headers['set-cookie']).split(';')[0]!;
    const admin = await login('Admin', 'admin-heslo-123');
    const house = async () => (await s.server.app.inject({ method: 'GET', url: '/api/admin/house', headers: { cookie: admin } })).json().house as number;
    const before = await house();
    const inn = await s.server.app.inject({ method: 'POST', url: '/api/admin/wallet/house', headers: { cookie: admin, origin: 'http://localhost' }, payload: { direction: 'in', amount: 5000, reason: 'Počáteční vklad' } });
    expect(inn.statusCode).toBe(200);
    expect(await house()).toBe(before + 5000);
    const out = await s.server.app.inject({ method: 'POST', url: '/api/admin/wallet/house', headers: { cookie: admin, origin: 'http://localhost' }, payload: { direction: 'out', amount: 2000, reason: 'Oprava' } });
    expect(out.statusCode).toBe(200);
    expect(await house()).toBe(before + 3000);
    const tooMuch = await s.server.app.inject({ method: 'POST', url: '/api/admin/wallet/house', headers: { cookie: admin, origin: 'http://localhost' }, payload: { direction: 'out', amount: 999_999, reason: 'x' } });
    expect(tooMuch.statusCode).toBeGreaterThanOrEqual(400);
    const player = await login('Hrac', 'heslo-hrace-123');
    const denied = await s.server.app.inject({ method: 'POST', url: '/api/admin/wallet/house', headers: { cookie: player, origin: 'http://localhost' }, payload: { direction: 'in', amount: 10, reason: 'x' } });
    expect(denied.statusCode).toBe(403);
  });
});
