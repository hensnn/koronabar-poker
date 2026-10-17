import { afterEach, describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger, MemoryLedgerStore } from '@kb/ledger';
import { createDefaultRegistry, resolveSettings } from '@kb/shared';
import { ApprovalService } from '../auth/approvals.js';
import { AuditService } from '../auth/audit.js';
import { PermissionError, PermissionService } from '../auth/permissions.js';
import { seedRoles } from '../auth/seed.js';
import { openPglite, schema, type Database } from '../db/index.js';
import { Journal, ledgerTxOp } from '../db/journal.js';
import { WalletService } from './service.js';

let database: Database | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});
const reg = createDefaultRegistry();

async function setup() {
  database = await openPglite();
  const { db } = database;
  let clock = new Date('2026-07-01T10:00:00Z');
  const audit = new AuditService(db);
  const perms = new PermissionService(db, audit, () => clock);
  await seedRoles(db, perms);
  const journal = new Journal(db, (e) => {
    throw e;
  });
  const ledger = new Ledger(new MemoryLedgerStore(), { negativeBalanceLimit: 0 }, () => clock.getTime(), (tx) => journal.push('tx', ledgerTxOp(tx)));
  const approvals = new ApprovalService(db, perms, audit, { now: () => clock });
  const wallet = new WalletService({ db, ledger, perms, audit, approvals, settings: () => resolveSettings(reg, []).values });
  let n = 0;
  const user = async (nick: string, role?: string) => {
    const [u] = await db.insert(schema.users).values({ nickname: nick, nicknameLower: `${nick.toLowerCase()}${n++}`, passwordHash: 'x' }).returning({ id: schema.users.id });
    if (role) await perms.grantUnchecked(u!.id, perms.roleByKey(role)!.id);
    else await perms.reload();
    return u!.id;
  };
  return { db, audit, perms, ledger, approvals, wallet, journal, user, cash: new CashService(ledger), advance: (ms: number) => void (clock = new Date(clock.getTime() + ms)) };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof PermissionError) return e.code;
    throw e;
  }
};

describe('dobíjení a strhávání měny', () => {
  it('pokladník dobije v rámci limitů, záznam je v knize a v auditu s důvodem', async () => {
    const s = await setup();
    const pok = await s.user('Pok', 'pokladnik');
    const hrac = await s.user('Hrac', 'hrac');
    const r = await s.wallet.topUp(pok, hrac, 5000, 'výhra v sázce', { ip: '10.0.0.1' });
    expect(r.done).toBe(true);
    expect(s.ledger.balance(accounts.wallet(hrac))).toBe(5000);
    expect(s.ledger.balance(accounts.mint())).toBe(-5000);
    const log = await s.audit.list({ action: 'mena.dobit' });
    expect(log[0]).toMatchObject({ actorId: pok, targetId: hrac, reason: 'výhra v sázce', ip: '10.0.0.1' });
    expect(s.ledger.transactions()[0]!.createdBy).toBe(pok);
  });

  it('limit za operaci a za den, povinný důvod, platná částka a existující uživatel', async () => {
    const s = await setup();
    const pok = await s.user('Pok', 'pokladnik');
    const hrac = await s.user('Hrac', 'hrac');
    expect(await code(s.wallet.topUp(pok, hrac, 10001, 'x'))).toBe('LIMIT_EXCEEDED');
    expect(await code(s.wallet.topUp(pok, hrac, 100, '  '))).toBe('INVALID');
    expect(await code(s.wallet.topUp(pok, hrac, -5, 'x'))).toBe('INVALID');
    expect(await code(s.wallet.topUp(pok, hrac, 1.5, 'x'))).toBe('INVALID');
    expect(await code(s.wallet.topUp(pok, '00000000-0000-4000-8000-000000000000', 100, 'x'))).toBe('NOT_FOUND');
    for (let i = 0; i < 5; i++) expect(await code(s.wallet.topUp(pok, hrac, 10000, 'den'))).toBe('OK');
    expect(await code(s.wallet.topUp(pok, hrac, 1, 'den'))).toBe('LIMIT_EXCEEDED');
    s.advance(25 * 3600_000);
    expect(await code(s.wallet.topUp(pok, hrac, 1, 'další den'))).toBe('OK');
  });

  it('běžný hráč ani moderátor dobíjet nesmí', async () => {
    const s = await setup();
    const hrac = await s.user('Hrac', 'hrac');
    const mod = await s.user('Mod', 'moderator');
    expect(await code(s.wallet.topUp(hrac, hrac, 100, 'x'))).toBe('FORBIDDEN');
    expect(await code(s.wallet.topUp(mod, hrac, 100, 'x'))).toBe('FORBIDDEN');
    expect(await code(s.wallet.debit(hrac, hrac, 100, 'x'))).toBe('FORBIDDEN');
    expect(s.ledger.balance(accounts.wallet(hrac))).toBe(0);
  });

  it('strhnutí jde na účet domu a nejde pod nulu', async () => {
    const s = await setup();
    const pok = await s.user('Pok', 'pokladnik');
    const hrac = await s.user('Hrac', 'hrac');
    await s.wallet.topUp(pok, hrac, 1000, 'start');
    await s.wallet.debit(pok, hrac, 300, 'pokuta');
    expect(s.ledger.balance(accounts.wallet(hrac))).toBe(700);
    expect(s.ledger.balance(accounts.house())).toBe(300);
    await expect(s.wallet.debit(pok, hrac, 5000, 'moc')).rejects.toThrow(/INSUFFICIENT/);
    expect(s.wallet.houseBalances(pok)).toEqual({ house: 300 });
    expect(() => s.wallet.houseBalances(hrac)).toThrow(PermissionError);
  });
});

describe('princip čtyř očí', () => {
  async function withApproval(s: Awaited<ReturnType<typeof setup>>) {
    const main = await s.user('Main', 'main_admin');
    // role, která dobíjí jen se schválením
    const roleId = await s.perms.createRole(main, { key: 'junior_pokladnik', name: 'Junior', power: 30, permissions: [{ key: 'mena.dobit', needsApproval: true, limits: { maxPerOperation: 20000 } }] });
    const junior = await s.user('Junior');
    await s.perms.assignRole(main, junior, roleId);
    const senior = await s.user('Senior', 'pokladnik');
    const hrac = await s.user('Hrac', 'hrac');
    return { main, junior, senior, hrac };
  }

  it('dobití nad hranici schválení čeká; provede se až po schválení jinou osobou, jen jednou', async () => {
    const s = await setup();
    const { junior, senior, hrac } = await withApproval(s);
    const r = await s.wallet.topUp(junior, hrac, 8000, 'mimořádné dobití');
    expect(r.done).toBe(false);
    expect(s.ledger.balance(accounts.wallet(hrac))).toBe(0);
    const id = (r as { approvalId: string }).approvalId;
    expect((await s.approvals.list(junior)).map((x) => x.id)).toContain(id);
    expect((await s.approvals.list(senior)).map((x) => x.id)).toContain(id);
    expect((await s.approvals.list(hrac)).map((x) => x.id)).not.toContain(id);
    expect(await code(s.approvals.decide(junior, id, true))).toBe('FORBIDDEN'); // vlastní požadavek
    const done = await s.approvals.decide(senior, id, true, 'v pořádku');
    expect(done.status).toBe('executed');
    expect(s.ledger.balance(accounts.wallet(hrac))).toBe(8000);
    expect(await code(s.approvals.decide(senior, id, true))).toBe('INVALID');
    expect(s.ledger.balance(accounts.wallet(hrac))).toBe(8000);
    const audit = (await s.audit.list({})).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['schvalovani.zadost', 'schvalovani.schvaleno', 'mena.dobit']));
  });

  it('zamítnutí nic neprovede; schvalovat smí jen ten, kdo má oprávnění k akci i ke schvalování', async () => {
    const s = await setup();
    const { junior, senior, hrac } = await withApproval(s);
    const mod = await s.user('Mod', 'moderator');
    const r = (await s.wallet.topUp(junior, hrac, 100, 'x')) as { approvalId: string };
    expect(await code(s.approvals.decide(mod, r.approvalId, true))).toBe('FORBIDDEN');
    expect(await code(s.approvals.decide(hrac, r.approvalId, true))).toBe('FORBIDDEN');
    expect((await s.approvals.decide(senior, r.approvalId, false, 'ne')).status).toBe('rejected');
    expect(s.ledger.balance(accounts.wallet(hrac))).toBe(0);
  });

  it('souběžné schválení provede akci jen jednou', async () => {
    const s = await setup();
    const { junior, senior, hrac } = await withApproval(s);
    const [a, b] = await Promise.all([
      s.wallet.topUp(junior, hrac, 300, 'x') as Promise<{ approvalId: string }>,
      s.user('Senior2', 'pokladnik'),
    ]);
    const results = await Promise.all([s.approvals.decide(senior, a.approvalId, true).then(() => 'OK', (e) => e.code), s.approvals.decide(b as string, a.approvalId, true).then(() => 'OK', (e) => e.code)]);
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(s.ledger.balance(accounts.wallet(hrac))).toBe(300);
  });

  it('neúspěšné provedení se zapíše jako chyba a nezmění knihu; prošlé žádosti nelze schválit', async () => {
    const s = await setup();
    const main = await s.user('Main', 'main_admin');
    const hrac = await s.user('Hrac', 'hrac');
    const pok = await s.user('Pok', 'pokladnik'); // upravit_knihu vyžaduje schválení
    expect(s.perms.can(pok, 'mena.upravit_knihu').needsApproval).toBe(true);
    const r = (await s.wallet.adjust(pok, [{ account: accounts.wallet(hrac), amount: -500 }, { account: accounts.house(), amount: 500 }], 'oprava')) as { approvalId: string };
    const res = await s.approvals.decide(main, r.approvalId, true);
    expect(res.status).toBe('failed');
    expect(JSON.stringify(res.result)).toMatch(/INSUFFICIENT/);
    const [row] = await s.db.select().from(schema.approvalRequests);
    expect(row!.status).toBe('failed');
    const r2 = (await s.wallet.adjust(pok, [{ account: accounts.house(), amount: -1 }, { account: accounts.wallet(hrac), amount: 1 }], 'jiná')) as { approvalId: string };
    s.advance(80 * 3600_000);
    expect(await code(s.approvals.decide(main, r2.approvalId, true))).toBe('INVALID');
    expect((await s.approvals.list(pok)).find((x) => x.id === r2.approvalId)!.status).toBe('expired');
  });

  it('hlavní administrátor upravuje knihu bez schválení', async () => {
    const s = await setup();
    const main = await s.user('Main', 'main_admin');
    const hrac = await s.user('Hrac', 'hrac');
    const r = await s.wallet.adjust(main, [{ account: accounts.mint(), amount: -250 }, { account: accounts.wallet(hrac), amount: 250 }], 'oprava chyby');
    expect(r.done).toBe(true);
    expect(s.ledger.balance(accounts.wallet(hrac))).toBe(250);
  });
});

describe('žádosti hráčů', () => {
  it('hráč požádá o dobití, pokladník ho vyřídí v rámci limitu a hráč dostane měnu', async () => {
    const s = await setup();
    const pok = await s.user('Pok', 'pokladnik');
    const hrac = await s.user('Hrac', 'hrac');
    const id = await s.wallet.createRequest(hrac, { kind: 'dobiti', amount: 3000, message: 'došly žetony' });
    expect((await s.wallet.listRequests(hrac)).map((r) => r.id)).toEqual([id]);
    expect(await s.wallet.listRequests(hrac, { all: true })).toHaveLength(1); // jen vlastní, hráč nemá oprávnění
    expect((await s.wallet.listRequests(pok, { all: true, status: 'pending' })).map((r) => r.id)).toEqual([id]);
    expect(await code(s.wallet.decideRequest(hrac, id, true))).toBe('FORBIDDEN');
    const res = await s.wallet.decideRequest(pok, id, true, 'ok');
    expect(res.status).toBe('approved');
    expect(s.ledger.balance(accounts.wallet(hrac))).toBe(3000);
    expect(await code(s.wallet.decideRequest(pok, id, true))).toBe('INVALID');
    expect((await s.audit.list({ action: 'zadost.schvalit' }))[0]!.targetId).toBe(id);
  });

  it('žádost nad limit vyřizujícího nelze vyřídit, zamítnutí měnu nepřidá; omezení počtu čekajících a zrušení', async () => {
    const s = await setup();
    const pok = await s.user('Pok', 'pokladnik');
    const hrac = await s.user('Hrac', 'hrac');
    const big = await s.wallet.createRequest(hrac, { kind: 'dobiti', amount: 50_000 });
    expect(await code(s.wallet.decideRequest(pok, big, true))).toBe('FORBIDDEN');
    expect((await s.wallet.decideRequest(pok, big, false, 'moc')).status).toBe('rejected');
    expect(s.ledger.balance(accounts.wallet(hrac))).toBe(0);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await s.wallet.createRequest(hrac, { kind: 'dobiti', amount: 100 }));
    expect(await code(s.wallet.createRequest(hrac, { kind: 'dobiti', amount: 100 }))).toBe('LIMIT_EXCEEDED');
    await s.wallet.cancelRequest(hrac, ids[0]!);
    expect(await code(s.wallet.createRequest(hrac, { kind: 'dobiti', amount: 100 }))).toBe('OK');
    expect(await code(s.wallet.cancelRequest(hrac, ids[0]!))).toBe('NOT_FOUND');
    expect(await code(s.wallet.createRequest(hrac, { kind: 'dobiti' }))).toBe('INVALID');
  });

  it('host žádosti podávat nemůže', async () => {
    const s = await setup();
    const host = await s.user('Host', 'host');
    expect(await code(s.wallet.createRequest(host, { kind: 'dobiti', amount: 10 }))).toBe('FORBIDDEN');
  });
});

describe('přehledy a vyúčtování', () => {
  it('hráč vidí vlastní pohyby; celou knihu jen pokladník', async () => {
    const s = await setup();
    const pok = await s.user('Pok', 'pokladnik');
    const hrac = await s.user('Hrac', 'hrac');
    await s.wallet.topUp(pok, hrac, 1000, 'start');
    s.cash.buyIn(hrac, 'stul', 400, 'b1');
    await s.journal.flush();
    const hist = await s.wallet.walletHistory(hrac);
    expect(hist.map((h) => [h.kind, h.amount])).toEqual([['cash_buyin', -400], ['mint', 1000]]);
    const book = await s.wallet.ledgerOverview(pok);
    expect(book[0]!.entries.map((e) => e.account).sort()).toEqual(['table:stul', `wallet:${hrac}`]);
    await expect(s.wallet.ledgerOverview(hrac)).rejects.toThrow(PermissionError);
  });

  it('vyúčtování stolu: čistý výsledek hráčů a minimální převody, jen ve virtuální měně', async () => {
    const s = await setup();
    const pok = await s.user('Pok', 'pokladnik');
    const [a, b, c, d] = [await s.user('A', 'hrac'), await s.user('B', 'hrac'), await s.user('C', 'hrac'), await s.user('D', 'hrac')];
    for (const u of [a, b, c, d]) s.cash.mint(u, 10_000, `m-${u}`);
    // buy-iny 1000, výběry: A 1700 (+700), B 400 (-600), C 850 (-150), D 1000 (0)... součet výběrů musí odpovídat vkladům
    for (const u of [a, b, c, d]) s.cash.buyIn(u, 't1', 1000, `bi-${u}`);
    s.cash.cashOut(a, 't1', 1750, `co-${a}`);
    s.cash.cashOut(b, 't1', 400, `co-${b}`);
    s.cash.cashOut(c, 't1', 850, `co-${c}`);
    s.cash.cashOut(d, 't1', 1000, `co-${d}`);
    await s.journal.flush();
    const r = await s.wallet.settlementForTable(a, 't1');
    expect(r.balances).toEqual({ [a]: 750, [b]: -600, [c]: -150 });
    const moved = r.transfers.reduce((n, t) => n + t.amount, 0);
    expect(moved).toBe(750);
    expect(r.transfers.length).toBe(2);
    expect(r.transfers.every((t) => t.to === a)).toBe(true);
    // nezúčastněný bez oprávnění nic neuvidí, pokladník ano
    const cizi = await s.user('Cizi', 'hrac');
    await expect(s.wallet.settlementForTable(cizi, 't1')).rejects.toThrow(PermissionError);
    expect((await s.wallet.settlementForTable(pok, 't1')).transfers).toHaveLength(2);
  });

  it('vyúčtování počítá i hráče, kteří ještě sedí u stolu', async () => {
    const s = await setup();
    const a = await s.user('A', 'hrac');
    const b = await s.user('B', 'hrac');
    s.cash.mint(a, 1000, 'ma');
    s.cash.mint(b, 1000, 'mb');
    s.cash.buyIn(a, 't2', 500, 'ba');
    s.cash.buyIn(b, 't2', 500, 'bb');
    await s.journal.flush();
    const r = await s.wallet.settlementForTable(a, 't2', [{ userId: a, chips: 800 }, { userId: b, chips: 200 }]);
    expect(r.balances).toEqual({ [a]: 300, [b]: -300 });
    expect(r.transfers).toEqual([{ from: b, to: a, amount: 300 }]);
  });
});
