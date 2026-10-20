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
    // rozpad vydané měny: vydáno = peněženky + dům + fondy + stoly + turnaje + převody ven; dobití 500 je mezi vydáními
    const rec = (body as unknown as { reconciliation: { issued: number; wallets: number; house: number; funds: number; tables: number; tournaments: number; external: number; issuedBy: { amount: number; to: string; kind: string; note: string }[] } }).reconciliation;
    expect(rec.issued).toBe(rec.wallets + rec.house + rec.funds + rec.tables + rec.tournaments + rec.external);
    expect(rec.wallets).toBe(body.totals.wallets);
    expect(rec.issuedBy.find((m) => m.to === 'Druhy' && m.amount === 500)).toMatchObject({ kind: 'mint', note: 'test' });
    expect(rec.issuedBy.filter((m) => m.amount === 1000).length).toBeGreaterThanOrEqual(3); // počáteční zůstatky při registraci

    // hráč bez role pokladníka nic nevidí
    const inv2 = await c.server.accounts.createInvite(c.admin, {});
    await c.server.accounts.register({ inviteCode: inv2, nickname: 'Treti', email: 'treti@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
    const plain = await c.login('Treti', 'heslo-hrace-123');
    expect((await c.call('GET', '/api/admin/balances', plain)).statusCode).toBe(403);
  });
});

describe('účetní kniha s filtry', () => {
  it('filtruje podle druhu, účtu, textu, částky a data; limit a oprávnění', async () => {
    const c = await start();
    await c.server.perms.assignRole(c.admin, c.player, c.server.perms.roleByKey('pokladnik')!.id);
    const inv = await c.server.accounts.createInvite(c.admin, {});
    const { userId: other } = await c.server.accounts.register({ inviteCode: inv, nickname: 'Druhy', email: 'druhy@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
    await c.server.wallet.topUp(c.admin, other, 500, 'Výhra v SÁZCE');
    await c.server.wallet.debit(c.admin, other, 120, 'srážka za škodu');
    const pok = await c.login('Hrac', 'heslo-hrace-123');
    const get = async (qs: string) => (await c.call('GET', `/api/admin/ledger${qs}`, pok)).json() as { id: number; kind: string; note: string | null; at: string; entries: { account: string; amount: number }[] }[];

    expect((await get('')).length).toBeGreaterThanOrEqual(4);
    expect((await get('?kind=manual_adjustment')).map((t) => t.note)).toEqual(['srážka za škodu']);
    expect((await get('?q=sázce')).map((t) => t.note)).toEqual(['Výhra v SÁZCE']); // bez ohledu na velikost písmen
    expect(await get('?q=%25')).toHaveLength(0); // procento se bere doslova
    const mine = await get(`?account=${encodeURIComponent(`wallet:${other}`)}`);
    expect(mine.every((t) => t.entries.some((e) => e.account === `wallet:${other}`))).toBe(true);
    expect(mine.length).toBeGreaterThanOrEqual(3); // počáteční zůstatek, dobití, srážka
    expect((await get('?min=400')).every((t) => t.entries.some((e) => Math.abs(e.amount) >= 400))).toBe(true);
    expect((await get('?min=1000000'))).toHaveLength(0);
    expect((await get('?limit=2'))).toHaveLength(2);
    const future = Date.now() + 86_400_000 * 365;
    expect(await get(`?from=${future}`)).toHaveLength(0);
    expect((await get(`?to=${future}&kind=mint&q=sázce`)).length).toBe(1);
    // řazení: čas (nejnovější první a naopak), druh, největší částka
    const ids = (rows: { id: number }[]) => rows.map((x) => x.id);
    const desc = ids(await get(''));
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    expect(ids(await get('?sort=time&dir=asc'))).toEqual([...desc].sort((a, b) => a - b));
    const kindsAsc = (await get('?sort=kind&dir=asc')).map((x) => x.kind);
    expect(kindsAsc).toEqual([...kindsAsc].sort());
    const biggest = (rows: { entries: { amount: number }[] }[]) => rows.map((x) => Math.max(...x.entries.map((e) => Math.abs(e.amount))));
    const amountsDesc = biggest(await get('?sort=amount&dir=desc'));
    expect(amountsDesc).toEqual([...amountsDesc].sort((a, b) => b - a));
    const amountsAsc = biggest(await get('?sort=amount&dir=asc'));
    expect(amountsAsc).toEqual([...amountsAsc].sort((a, b) => a - b));
    expect(amountsDesc[0]).toBeGreaterThanOrEqual(1000); // počáteční zůstatky jsou největší
    expect((await c.call('GET', '/api/admin/ledger?sort=nesmysl', pok)).statusCode).toBe(400);
    // export do CSV se stejnými filtry a řazením, účty s přezdívkami
    const csv = await c.call('GET', `/api/admin/ledger/export.csv?kind=manual_adjustment&sort=amount&dir=desc`, pok);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.startsWith('\uFEFF')).toBe(true);
    const csvLines = csv.body.replace('\uFEFF', '').trim().split('\r\n');
    expect(csvLines).toHaveLength(2); // hlavička a jediná srážka
    expect(csvLines[1]).toContain('Druhy: -120');
    expect(csvLines[1]).toContain('srážka za škodu');
    expect((await c.call('GET', '/api/admin/ledger/export.csv', pok)).body.trim().split('\r\n').length).toBeGreaterThan(4);
    // seznam druhů pohybů pro filtr
    const kinds = ((await c.call('GET', '/api/admin/ledger/kinds', pok)).json() as { kinds: string[] }).kinds;
    expect(kinds).toEqual(expect.arrayContaining(['mint', 'manual_adjustment']));
    // hráč bez oprávnění knihu nevidí
    const inv2 = await c.server.accounts.createInvite(c.admin, {});
    await c.server.accounts.register({ inviteCode: inv2, nickname: 'Treti', email: 'treti@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
    const plain = await c.login('Treti', 'heslo-hrace-123');
    expect((await c.call('GET', '/api/admin/ledger?kind=mint', plain)).statusCode).toBe(403);
    expect((await c.call('GET', '/api/admin/ledger/kinds', plain)).statusCode).toBe(403);
    expect((await c.call('GET', '/api/admin/ledger/export.csv', plain)).statusCode).toBe(403);
  });
});
