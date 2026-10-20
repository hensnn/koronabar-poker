import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { accounts } from '@kb/ledger';
import { buildServer } from './app.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(over: Record<string, unknown> = {}) {
  const server = await buildServer({
    clock: new FakeClock(),
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 9), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 1000, 'economy.transferEnabled': true, 'economy.transferTargets': 'jiná hra, turnajovka', 'economy.transferMin': 100, 'economy.transferMax': 800, ...over },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  const { userId: player } = await server.accounts.register({ inviteCode: inv, nickname: 'Hrac', email: 'hrac@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
  const login = async (identifier: string, password: string) => String((await server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier, password }, headers: { origin: 'http://localhost' } })).headers['set-cookie']).split(';')[0]!;
  const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown) => server.app.inject({ method, url, headers: { cookie, origin: 'http://localhost' }, payload: payload as never });
  return { server, admin: admin!, player, login, call };
}

describe('převod Koron do jiné aplikace (žádost o výběr)', () => {
  it('hráč požádá, pokladník schválí: Korony se odepíšou na účet převodu, kniha zůstane vyrovnaná', async () => {
    const c = await start();
    const hrac = await c.login('Hrac', 'heslo-hrace-123');
    const admin = await c.login('Admin', 'admin-heslo-123');
    expect((await c.call('GET', '/api/wallet/transfer', hrac)).json()).toEqual({ enabled: true, targets: ['jiná hra', 'turnajovka'], min: 100, max: 800 });

    const req = await c.call('POST', '/api/requests', hrac, { kind: 'prevod', amount: 300, message: 'do druhé hry', target: 'jiná hra' });
    expect(req.statusCode).toBe(200);
    const id = req.json().id as string;
    // do schválení se nic nehýbe a sám sobě žádost schválit nemůže
    expect(c.server.ledger.balance(accounts.wallet(c.player))).toBe(1000);
    expect((await c.call('POST', `/api/requests/${id}/decide`, hrac, { approve: true })).statusCode).toBe(403);

    const ok = await c.call('POST', `/api/requests/${id}/decide`, admin, { approve: true, note: 'vyřízeno' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().txId).toBeGreaterThan(0);
    expect(c.server.ledger.balance(accounts.wallet(c.player))).toBe(700);
    expect(c.server.ledger.balance(accounts.external('jiná hra'))).toBe(300);
    expect(c.server.ledger.totalIsZero([accounts.mint(), accounts.house(), accounts.wallet(c.player), accounts.wallet(c.admin), accounts.external('jiná hra')])).toBe(true);
    const hist = (await c.call('GET', '/api/wallet/history', hrac)).json() as { kind: string; amount: number; note: string }[];
    expect(hist[0]).toMatchObject({ kind: 'transfer_out', amount: -300 });
    expect(hist[0]!.note).toContain('jiná hra');
    // schválená žádost se nedá vyřídit podruhé
    expect((await c.call('POST', `/api/requests/${id}/decide`, admin, { approve: true })).statusCode).toBeGreaterThanOrEqual(400);
    expect(c.server.ledger.balance(accounts.wallet(c.player))).toBe(700);
  });

  it('zamítnutá žádost nic neodepíše; neplatné žádosti se odmítnou hned', async () => {
    const c = await start();
    const hrac = await c.login('Hrac', 'heslo-hrace-123');
    const admin = await c.login('Admin', 'admin-heslo-123');
    const bad = (payload: Record<string, unknown>) => c.call('POST', '/api/requests', hrac, { kind: 'prevod', message: '', ...payload });
    expect((await bad({ amount: 300, target: 'neznámá' })).statusCode).toBe(400); // cíl mimo seznam
    expect((await bad({ amount: 300 })).statusCode).toBe(400); // bez cíle
    expect((await bad({ amount: 50, target: 'jiná hra' })).statusCode).toBe(400); // pod minimem
    expect((await bad({ amount: 900, target: 'jiná hra' })).statusCode).toBe(400); // nad maximem
    await c.server.wallet.debit(c.admin, c.player, 900, 'test'); // zbývá 100 < 200
    expect((await bad({ amount: 200, target: 'jiná hra' })).statusCode).toBe(400); // víc než zůstatek

    const req = await bad({ amount: 100, target: 'turnajovka' });
    expect(req.statusCode).toBe(200);
    const rej = await c.call('POST', `/api/requests/${req.json().id}/decide`, admin, { approve: false, note: 'ne' });
    expect(rej.statusCode).toBe(200);
    expect(c.server.ledger.balance(accounts.wallet(c.player))).toBe(100);
    expect(c.server.ledger.balance(accounts.external('turnajovka'))).toBe(0);
  });

  it('schválení znovu hlídá zůstatek (hráč mezitím Korony utratil) a vypnuté převody se odmítnou', async () => {
    const c = await start();
    const hrac = await c.login('Hrac', 'heslo-hrace-123');
    const admin = await c.login('Admin', 'admin-heslo-123');
    const req = await c.call('POST', '/api/requests', hrac, { kind: 'prevod', amount: 800, message: '', target: 'jiná hra' });
    expect(req.statusCode).toBe(200);
    await c.server.wallet.debit(c.admin, c.player, 500, 'mezitím');
    expect((await c.call('POST', `/api/requests/${req.json().id}/decide`, admin, { approve: true })).statusCode).toBeGreaterThanOrEqual(400);
    expect(c.server.ledger.balance(accounts.external('jiná hra'))).toBe(0);

    const off = await start({ 'economy.transferEnabled': false });
    const h2 = await off.login('Hrac', 'heslo-hrace-123');
    expect((await off.call('GET', '/api/wallet/transfer', h2)).json().enabled).toBe(false);
    expect((await off.call('POST', '/api/requests', h2, { kind: 'prevod', amount: 300, message: '', target: 'jiná hra' })).statusCode).toBe(400);
  });
});

describe('pokladník vidí stavy účtů hráčů', () => {
  it('seznam se zůstatky, poslední pohyb a součty; obyčejný hráč ho nevidí', async () => {
    const c = await start();
    await c.server.perms.assignRole(c.admin, c.player, c.server.perms.roleByKey('pokladnik')!.id);
    const inv = await c.server.accounts.createInvite(c.admin, {});
    const { userId: other } = await c.server.accounts.register({ inviteCode: inv, nickname: 'Druhy', email: 'druhy@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
    await c.server.wallet.topUp(c.admin, other, 500, 'test');
    const pok = await c.login('Hrac', 'heslo-hrace-123');
    const r = await c.call('GET', '/api/admin/balances', pok);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { rows: { userId: string; nickname: string; balance: number; lastMoveAt: number | null }[]; totals: { wallets: number; house: number; players: number } };
    expect(body.rows.find((x) => x.userId === other)).toMatchObject({ nickname: 'Druhy', balance: 1500 });
    expect(body.rows[0]!.balance).toBeGreaterThanOrEqual(body.rows[body.rows.length - 1]!.balance); // seřazeno od největšího
    expect(body.rows.find((x) => x.userId === other)!.lastMoveAt).not.toBeNull();
    expect(body.totals.wallets).toBe(body.rows.reduce((n, x) => n + x.balance, 0));
    expect(body.totals.players).toBe(body.rows.length);

    // hráč bez role pokladníka nic nevidí
    const inv2 = await c.server.accounts.createInvite(c.admin, {});
    await c.server.accounts.register({ inviteCode: inv2, nickname: 'Treti', email: 'treti@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
    const plain = await c.login('Treti', 'heslo-hrace-123');
    expect((await c.call('GET', '/api/admin/balances', plain)).statusCode).toBe(403);
  });
});
