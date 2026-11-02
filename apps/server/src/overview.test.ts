import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { accounts } from '@kb/ledger';
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
    expect(me.division).toMatchObject({ name: 'Kapr' }); // bez odehraných her je hráč v divizi podle výchozího ratingu
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

  it('barva hráče: správce ji přidělí, přehled i srovnání ji vrací, ostatní hráči ji měnit nemohou', async () => {
    const s = await start();
    const before = await s.server.overview.overview();
    const colors = before.rows.map((r) => r.color);
    expect(new Set(colors).size).toBe(colors.length);
    await s.server.accounts.setChartColor(s.admin, s.player, 7);
    const after = await s.server.overview.overview();
    expect(after.rows.find((r) => r.userId === s.player)!.color).toBe(7);
    expect(after.rows.find((r) => r.userId === s.admin)!.color).not.toBe(7);
    const cmp = await s.server.overview.compare([s.player, s.admin], 'balance');
    expect(cmp.series.find((x) => x.userId === s.player)!.color).toBe(7);
    await expect(s.server.accounts.setChartColor(s.player, s.admin, 2)).rejects.toThrow('FORBIDDEN');
    await expect(s.server.accounts.setChartColor(s.admin, s.player, 61)).rejects.toThrow();
    await s.server.accounts.setChartColor(s.admin, s.player, null);
    expect((await s.server.overview.overview()).rows.find((r) => r.userId === s.player)!.color).not.toBe(7);
  });

  it('počet hand v přehledu zahrnuje jen cash, ne ruce z turnajů', async () => {
    const s = await start();
    const at = new Date();
    await s.server.db.insert(schema.hands).values({ id: 'h-ov-t', tableId: 't-ov', kind: 'tournament', tournamentId: 't-ov', handNumber: 1, playedAt: at, pot: 100, blinds: { sb: 1, bb: 2, ante: 0 } });
    await s.server.db.insert(schema.handPlayers).values({ handId: 'h-ov-t', userId: s.player, seat: 0, kind: 'tournament', playedAt: at, startStack: 100, invested: 50, won: 0 });
    const me = (await s.server.overview.overview()).rows.find((r) => r.userId === s.player)!;
    expect(me.hands).toBe(0);
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

describe('kategorie kdo je v čem nejlepší: správná data', () => {
  it('každá kategorie se počítá z předvídatelného zdroje (kniha, výsledky turnajů, cash ruce, XP)', async () => {
    const s = await start({ 'stats.categoryMinGames': 1, 'stats.categoryTop': 5 });
    const a = s.admin;
    const p = s.player;
    const db = s.server.db;
    const at = new Date();
    const res = (ref: string, userId: string, place: number, spent: number, payout: number, bounty = 0) => ({ kind: 'tournament', ref, userId, finishedAt: at, place, field: 5, spent, payout, bounty });
    await db.insert(schema.gameResults).values([res('T1', p, 1, 100, 400, 50), res('T2', p, 3, 100, 0), res('T3', p, 2, 100, 150), res('T1', a, 4, 100, 0)]);
    const post = (kind: 'turnaj_buyin' | 'turnaj_vyplata' | 'cash_buyin' | 'cash_cashout', userId: string, amount: number, key: string) =>
      s.server.ledger.post({ kind, idempotencyKey: key, entries: [{ account: accounts.wallet(userId), amount }, { account: accounts.mint(), amount: -amount }] });
    post('turnaj_buyin', p, -300, 'cat-1');
    post('turnaj_vyplata', p, 600, 'cat-2');
    post('turnaj_buyin', a, -100, 'cat-3');
    post('cash_buyin', p, -200, 'cat-4');
    post('cash_cashout', p, 260, 'cat-5');
    // ruce: p 2 cash + 1 turnajová, a 1 cash; turnajové ruce se do cash hand nepočítají
    const hand = (id: string, kind: 'cash' | 'tournament') => db.insert(schema.hands).values({ id, tableId: 't-cat', kind, tournamentId: kind === 'tournament' ? 't-cat' : null, handNumber: 1, playedAt: at, pot: 100, blinds: { sb: 1, bb: 2, ante: 0 } });
    const hp = (handId: string, userId: string, kind: 'cash' | 'tournament') => db.insert(schema.handPlayers).values({ handId, userId, seat: 0, kind, playedAt: at, startStack: 100, invested: 10, won: 0 });
    for (const [id, kind] of [['h1', 'cash'], ['h2', 'cash'], ['h3', 'tournament'], ['h4', 'cash']] as const) await hand(id, kind);
    await hp('h1', p, 'cash');
    await hp('h2', p, 'cash');
    await hp('h3', p, 'tournament');
    await hp('h4', a, 'cash');
    s.server.progress.grant(p, 'x', 90);
    await s.server.progress.idle();
    await s.server.journal.flush();
    const login = await s.server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'Hrac', password: 'heslo-hrace-123' }, headers: { origin: 'http://localhost' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const res2 = await s.server.app.inject({ method: 'GET', url: '/api/stats/categories', headers: { cookie } });
    const cats = new Map((res2.json() as { categories: { id: string; entries: { userId: string; value: number }[] }[] }).categories.map((c) => [c.id, c.entries]));
    const val = (id: string, userId: string) => cats.get(id)?.find((e) => e.userId === userId)?.value;
    expect(val('tournamentNet', p)).toBe(300); // výplata 600 − vstupy 300
    expect(val('cashNet', p)).toBe(60); // 260 − 200
    expect(val('total', p)).toBe(360);
    expect(val('hands', p)).toBe(2); // jen cash, turnajová ruka ne
    expect(val('hands', a)).toBe(1);
    expect(val('games', p)).toBe(3);
    expect(val('wins', p)).toBe(1);
    expect(val('winRate', p)).toBe(33.3);
    expect(val('itmRate', p)).toBe(66.7);
    expect(val('avgPlace', p)).toBe(2);
    expect(val('avgPlace', a)).toBe(4);
    expect(cats.get('avgPlace')![0]!.userId).toBe(p); // nižší průměrné místo je lepší
    expect(val('bounty', p)).toBe(50);
    expect(val('xp', p)).toBe(90);
    expect(cats.get('tournamentNet')![0]!.userId).toBe(p);
  });
});

describe('kategorie a vypnuté části', () => {
  it('bez XP a bez ratingu cash se jejich kategorie nenabízejí; divize má každý s číslem ratingu', async () => {
    const s = await start({ 'xp.enabled': false, 'rating.cashEnabled': false });
    const login = await s.server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'Hrac', password: 'heslo-hrace-123' }, headers: { origin: 'http://localhost' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const ids = ((await s.server.app.inject({ method: 'GET', url: '/api/stats/categories', headers: { cookie } })).json() as { categories: { id: string }[] }).categories.map((c) => c.id);
    expect(ids).not.toContain('xp');
    expect(ids).not.toContain('ratingCash');
    const me = (await s.server.overview.overview()).rows.find((r) => r.userId === s.player)!;
    expect(me.division?.rating).toBe(1500);
    expect(me.divisionTournament).toMatchObject({ name: 'Kapr', rating: 1500 });
    expect(me.divisionCash).toBeNull();
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

    // odchod domu mimo zapsané výdaje (vrácený poplatek) musí být v přehledu vidět: začátek + příjmy − odchody − výdaje = konec = zůstatek
    const some = s.server.perms.mainAdminIds()[0]!;
    s.server.ledger.post({ kind: 'turnaj_refund', idempotencyKey: 'house-refund-1', entries: [{ account: accounts.house(), amount: -40 }, { account: accounts.wallet(some), amount: 40 }] });
    await s.server.journal.flush();
    const full = (await report()) as unknown as { house: number; flow: Record<'month' | 'year', { opening: number; income: { amount: number }[]; outflows: { kind: string; amount: number }[]; expenses: number; closing: number }> };
    for (const f of [full.flow.month, full.flow.year]) {
      expect(f.opening + f.income.reduce((n, x) => n + x.amount, 0) - f.outflows.reduce((n, x) => n + x.amount, 0) - f.expenses).toBe(f.closing);
      expect(f.closing).toBe(full.house);
      expect(f.expenses).toBe(1500);
      expect(f.outflows).toEqual([{ kind: 'turnaj_refund', amount: 40 }]);
    }
    expect(full.house).toBe(before + 5000 - 1500 - 40);
    await s.server.ledger.post({ kind: 'turnaj_refund', idempotencyKey: 'house-refund-back', entries: [{ account: accounts.wallet(some), amount: -40 }, { account: accounts.house(), amount: 40 }] });

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
