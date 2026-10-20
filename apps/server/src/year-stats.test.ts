import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { schema } from './db/index.js';
import { YearStatsError } from './year-stats.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

// 15. června 2026 (poledne UTC)
const NOW = Date.UTC(2026, 5, 15, 12);

async function start(over: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  clock.advance(NOW - clock.now());
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 7), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', ...over },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  const { userId } = await server.accounts.register({ inviteCode: inv, nickname: 'Hrac', email: 'hrac@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
  const result = (ref: string, kind: 'tournament' | 'live_cash', at: number, spent: number, payout: number, bounty = 0) =>
    server.db.insert(schema.gameResults).values({ kind, ref, userId, finishedAt: new Date(at), place: 1, field: 4, spent, payout, bounty, rebuys: 0 });
  return { server, admin: admin!, userId, result };
}

describe('roční statistika (výdělek v roce)', () => {
  it('počítá výdělek, výhry a ztráty, nabité a strhnuté žetony i zůstatky jen za vybraný rok', async () => {
    const c = await start();
    await c.result('t-old', 'tournament', Date.UTC(2025, 5, 1), 100, 900); // loni: nepatří do roku 2026
    await c.result('t1', 'tournament', Date.UTC(2026, 0, 20), 100, 400, 50); // +350 (leden)
    await c.result('t2', 'tournament', Date.UTC(2026, 2, 5), 100, 0); // -100 (březen)
    await c.result('lc1', 'live_cash', Date.UTC(2026, 3, 10), 200, 120); // -80 (duben)
    await c.server.wallet.topUp(c.admin, c.userId, 700, 'nabití');
    await c.server.wallet.debit(c.admin, c.userId, 200, 'srážka');
    // dobití žetonů u stolu (stejná předpona klíče, ale jiný druh pohybu) se za nabití správcem nepočítá
    c.server.ledger.post({ kind: 'cash_topup', idempotencyKey: 'topup:stul-1:x', entries: [{ account: `wallet:${c.userId}`, amount: -300 }, { account: 'table:stul-1', amount: 300 }] });

    const y = await c.server.yearStats.compute(c.userId, 2026);
    expect(y).toMatchObject({ year: 2026, tournamentNet: 250, liveNet: -80, cashNet: 0, net: 170, won: 350, lost: -180, topUps: 700, withdrawals: 200, tournaments: 2, hands: 0 });
    expect(y.monthly).toEqual([350, 0, -100, -80, 0, 0, 0, 0, 0, 0, 0, 0]);
    // změna zůstatku zahrnuje i počáteční vklad při registraci (10000), který se do nabití správcem nepočítá
    expect(y.balanceEnd - y.balanceStart).toBe(10000 + 700 - 200 - 300);

    // minulý rok je oddělený
    const old = await c.server.yearStats.compute(c.userId, 2025);
    expect(old).toMatchObject({ net: 800, topUps: 0, withdrawals: 0 });
  });

  it('údaje podle kanálu určuje správce; vypnuté statistiky nic nevrátí', async () => {
    const c = await start({ 'stats.yearFieldsWeb': 'net,topUps', 'stats.yearFieldsEmail': 'net', 'stats.yearFieldsApi': 'tournamentNet,lost' });
    await c.result('t1', 'tournament', Date.UTC(2026, 0, 20), 100, 400);
    const web = await c.server.yearStats.forChannel(c.userId, 2026, 'web');
    expect(Object.keys(web).sort()).toEqual(['net', 'topUps', 'year']);
    expect(Object.keys(await c.server.yearStats.forChannel(c.userId, 2026, 'email')).sort()).toEqual(['net', 'year']);
    const api = await c.server.yearStats.forChannel(c.userId, 2026, 'api');
    expect(api).toEqual({ year: 2026, tournamentNet: 300, lost: 0 });
    expect(c.server.yearStats.summaryText(await c.server.yearStats.compute(c.userId, 2026), ['net'], c.server.yearStats.forms())).toMatch(/Výdělek v roce: \+300 Koron/);

    const off = await start({ 'stats.yearEnabled': false });
    await expect(off.server.yearStats.compute(off.userId, 2026)).rejects.toBeInstanceOf(YearStatsError);
  });

  it('HTTP: web vrací jen povolené údaje, e-mail se zařadí do fronty a API token dostane své údaje', async () => {
    const c = await start({ 'stats.yearFieldsWeb': 'net', 'stats.yearFieldsEmail': 'net,topUps' });
    await c.result('t1', 'tournament', Date.UTC(2026, 0, 20), 100, 400);
    const login = await c.server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'Hrac', password: 'heslo-hrace-123' }, headers: { origin: 'http://localhost' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect((await c.server.app.inject({ method: 'GET', url: '/api/stats/year' })).statusCode).toBe(401);
    const web = await c.server.app.inject({ method: 'GET', url: '/api/stats/year?year=2026', headers: { cookie } });
    expect(web.statusCode).toBe(200);
    expect(web.json()).toMatchObject({ stats: { year: 2026, net: 300 }, fields: ['net'] });
    expect(Object.keys(web.json().stats)).toEqual(['year', 'net']);

    const mail = await c.server.app.inject({ method: 'POST', url: '/api/stats/year/email', headers: { cookie, origin: 'http://localhost' }, payload: { year: 2026 } });
    expect(mail.statusCode).toBe(200);
    const [queued] = await c.server.db.select().from(schema.emailQueue);
    expect(queued!.kind).toBe('rocni_souhrn');
    expect(queued!.subject).toContain('2026');
    expect(queued!.bodyText).toContain('Výdělek v roce: +300');
    expect(queued!.bodyText).toContain('Nabito správcem: 0');
    expect(queued!.bodyText).not.toContain('Zůstatek');

    const bad = await c.server.app.inject({ method: 'GET', url: '/api/stats/year?year=1900', headers: { cookie } });
    expect(bad.statusCode).toBe(400);
  });
});

