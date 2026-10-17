import { afterEach, describe, expect, it } from 'vitest';
import { accounts } from '@kb/ledger';
import { FakeClock, TournamentError } from '@kb/game-core';
import { buildServer } from './app.js';
import { schema } from './db/index.js';
import { LiveError } from './live-cash.js';

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
    masterKey: { key: Buffer.alloc(32, 16), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `L${n++}x`;
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
    if (e instanceof TournamentError || e instanceof LiveError) return e.code;
    throw e;
  }
};

const SETTINGS = { 'tournament.live': true, 'tournament.levelMinutes': 15, 'tournament.targetMinutes': 20, 'tournament.startingStack': 1500, 'tournament.buyIn': 100, 'tournament.fee': 10, 'tournament.minPlayers': 2, 'table.seats': 9 };

describe('živý turnaj', { timeout: 60_000 }, () => {
  it('ředitel přihlásí hráče, zapíše vyřazení a turnaj se vyplatí z poolu bez stolu s kartami', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [a, b, c] = [await s.user(), await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, { name: 'Hospoda', templateId: 'tour-turbo', settings: SETTINGS });
    expect(s.server.tables.actors.has(id)).toBe(false);
    expect(s.server.tournaments.isLive(id)).toBe(true);

    expect(await code(s.server.tournaments.liveRegister(a, id, a))).toBe('FORBIDDEN');
    for (const p of [a, b, c]) await s.server.tournaments.liveRegister(org, id, p);
    expect(await code(s.server.tournaments.liveRegister(org, id, a))).toBe('ALREADY_REGISTERED');
    expect(s.server.ledger.balance(accounts.wallet(a))).toBe(10_000 - 110);
    await s.server.tournaments.start(org, id);

    const v0 = await s.server.tournaments.view(id, org);
    expect(v0.live).toMatchObject({ chipsInPlay: 4500, avgStack: 1500, director: true });
    expect(v0.standings.every((p) => p.chips === null && p.seat !== null)).toBe(true);
    expect((await s.server.tournaments.view(id, a)).live?.director).toBe(false);

    expect(await code(s.server.tournaments.liveEliminate(a, id, b, [a]))).toBe('FORBIDDEN');
    await s.server.tournaments.liveEliminate(org, id, c, [a]);
    expect((await s.server.tournaments.view(id, org)).live?.avgStack).toBe(2250);
    expect(await code(s.server.tournaments.liveEliminate(org, id, c, []))).toBe('NOT_REGISTERED');
    await s.server.tournaments.liveEliminate(org, id, b, [a]);

    const v = await s.server.tournaments.view(id, org);
    expect(v.status).toBe('finished');
    expect(v.results!.map((r) => r.userId)).toEqual([a, b, c]);
    expect(s.server.ledger.balance(accounts.tournament(id))).toBe(0);
    const paid = v.results!.reduce((n, r) => n + r.payout, 0);
    expect(paid + s.server.ledger.balance(accounts.house())).toBe(330);
    const rows = await s.server.db.select().from(schema.gameResults);
    expect(rows.filter((r) => r.ref === id).every((r) => r.live && r.kind === 'tournament')).toBe(true);
    expect(rows.filter((r) => r.ref === id)).toHaveLength(3);
  });

  it('rebuy a add-on zapisuje ředitel za hráče a platí se z jeho peněženky', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [a, b] = [await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, {
      name: 'Rebuy',
      templateId: 'tour-turbo',
      settings: { ...SETTINGS, 'tournament.rebuyEnabled': true, 'tournament.rebuyCost': 100, 'tournament.rebuyChips': 1000, 'tournament.rebuyMax': 1, 'tournament.rebuyUntilLevel': 5 },
    });
    await s.server.tournaments.liveRegister(org, id, a);
    await s.server.tournaments.liveRegister(org, id, b);
    await s.server.tournaments.start(org, id);
    await s.server.tournaments.liveBuy(org, id, a, 'rebuy');
    expect(s.server.ledger.balance(accounts.wallet(a))).toBe(10_000 - 110 - 100);
    expect((await s.server.tournaments.view(id, org)).live?.chipsInPlay).toBe(4000);
    expect(await code(s.server.tournaments.liveBuy(org, id, a, 'rebuy'))).toBe('REBUY_NOT_ALLOWED');
  });

  it('živý turnaj nejde založit bez oprávnění nebo při vypnutém režimu', async () => {
    const s = await start();
    const player = await s.user();
    expect(await code(s.server.tournaments.create(player, { name: 'Pokus', templateId: 'tour-turbo', settings: SETTINGS }))).toBe('FORBIDDEN');
    const off = await start({ 'live.enabled': false });
    const org = await off.user('organizator');
    expect(await code(off.server.tournaments.create(org, { name: 'Pokus', templateId: 'tour-turbo', settings: SETTINGS }))).toBe('INVALID');
  });
});

describe('živý turnaj na více stolech', { timeout: 90_000 }, () => {
  it('rozsadí hráče na stoly, navrhne přesazení a po potvrzení ředitele hráče přesadí a upozorní', async () => {
    const s = await start({ 'system.mailRequestsPerHour': 100 });
    const org = await s.user('organizator');
    const ps: string[] = [];
    for (let i = 0; i < 7; i++) ps.push(await s.user());
    const { id } = await s.server.tournaments.create(org, { name: 'Víc stolů živě', templateId: 'tour-turbo', settings: { ...SETTINGS, 'table.seats': 3, 'tournament.maxTables': 3 } });
    for (const p of ps) await s.server.tournaments.liveRegister(org, id, p);
    await s.server.tournaments.start(org, id);
    let v = await s.server.tournaments.view(id, org);
    expect(v.tables.map((t) => t.players.length).sort()).toEqual([2, 2, 3]);
    expect(v.live!.suggestions).toEqual([]);
    expect(v.standings.every((p) => p.tableNo !== null && p.seat !== null)).toBe(true);

    // vyřadíme dva hráče od plného stolu: zůstane jeden a stůl se dá zrušit
    const full = v.tables.find((t) => t.players.length === 3)!;
    for (const p of full.players.slice(0, 2)) await s.server.tournaments.liveEliminate(org, id, p.userId, []);
    v = await s.server.tournaments.view(id, org);
    expect(v.live!.suggestions).toHaveLength(1);
    const move = v.live!.suggestions[0]!;
    expect(move.reason).toBe('break');
    expect(move.fromNo).toBe(full.no);

    expect(await code(s.server.tournaments.liveMove(ps[0]!, id, move.userId, move.toTable))).toBe('FORBIDDEN');
    expect(await code(s.server.tournaments.liveMove(org, id, move.userId, 'neexistuje'))).toBe('INVALID');
    await s.server.tournaments.liveMove(org, id, move.userId, move.toTable);
    const notes = await s.server.db.select().from(schema.notifications);
    expect(notes.filter((n) => n.kind === 'liveMove').map((n) => n.userId)).toEqual([move.userId]);

    v = await s.server.tournaments.view(id, org);
    expect(v.tables).toHaveLength(2);
    expect(v.tables.flatMap((t) => t.players).length).toBe(5);
    expect(v.live!.suggestions).toEqual([]);
    expect(v.standings.find((p) => p.userId === move.userId)!.tableNo).toBe(move.toNo);
    const audit = await s.server.audit.list({ action: 'zivahra.presadit' });
    expect(audit).toHaveLength(1);
  });
});

describe('živý cash', { timeout: 60_000 }, () => {
  it('buy-iny, poplatek a cash-outy; uzavřít jde jen při přesném vyúčtování', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [a, b] = [await s.user(), await s.user()];
    const { id } = await s.server.liveCash.create(org, 'Pátek');
    expect(await code(s.server.liveCash.buyIn(a, id, a, 100))).toBe('FORBIDDEN');
    await s.server.liveCash.buyIn(org, id, a, 500);
    await s.server.liveCash.buyIn(org, id, b, 500);
    await s.server.liveCash.buyIn(org, id, a, 100);
    await s.server.liveCash.timeFee(org, id, a, 10);
    expect(s.server.ledger.balance(accounts.table(id))).toBe(1100);
    expect(s.server.ledger.balance(accounts.house())).toBe(10);

    expect(await code(s.server.liveCash.cashOut(org, id, a, 5000))).toBe('INVALID');
    await s.server.liveCash.cashOut(org, id, a, 800);
    expect(await code(s.server.liveCash.close(org, id))).toBe('PLAYER_PLAYING');
    await s.server.liveCash.cashOut(org, id, b, 200);
    expect(await code(s.server.liveCash.close(org, id))).toBe('UNSETTLED');
    // nesedí o 100: ředitel opraví (hráč b ještě dostane zbytek přes nový buy-in a cash-out)
    await s.server.liveCash.buyIn(org, id, b, 1);
    await s.server.liveCash.cashOut(org, id, b, 101);
    await s.server.liveCash.close(org, id);

    expect(s.server.ledger.balance(accounts.table(id))).toBe(0);
    const v = await s.server.liveCash.view(id, org);
    expect(v.status).toBe('closed');
    expect(v.players.find((p) => p.userId === a)).toMatchObject({ buyIns: 600, fee: 10, cashOut: 800, net: 190 });
    expect(await code(s.server.liveCash.buyIn(org, id, a, 10))).toBe('CLOSED');
    // nic nevzniklo ani nezmizelo
    const total = [a, b, org].reduce((n, u) => n + s.server.ledger.balance(accounts.wallet(u)), 0);
    expect(total + s.server.ledger.balance(accounts.house())).toBe(3 * 10_000);
    const rows = (await s.server.db.select().from(schema.gameResults)).filter((r) => r.ref === id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'live_cash' && r.live)).toBe(true);
  });
});
