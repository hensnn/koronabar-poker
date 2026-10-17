import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accounts } from '@kb/ledger';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { BetError } from './bets.js';
import { schema } from './db/index.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const START = 10_000;

async function start(settings: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 22), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': START, 'system.mailRequestsPerHour': 100, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `B${n++}x`;
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
    if (e instanceof BetError) return e.code;
    throw e;
  }
};

const LIVE = { 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9, 'tournament.payoutPreset': 'wta' };

type Ctx = Awaited<ReturnType<typeof start>>;

/** Živý turnaj se třemi hráči před startem. */
async function setup(s: Ctx) {
  const org = await s.user('organizator');
  const [a, b, c] = [await s.user(), await s.user(), await s.user()];
  const { id } = await s.server.tournaments.create(org, { name: 'Sázkový', templateId: 'tour-turbo', settings: LIVE });
  for (const p of [a, b, c]) await s.server.tournaments.liveRegister(org, id, p);
  return { org, a, b, c, id };
}

const idle = async (s: Ctx) => {
  await s.server.bets.idle();
  await s.server.headBounties.idle();
};

const wallet = (s: Ctx, u: string) => s.server.ledger.balance(accounts.wallet(u));
const escrow = (s: Ctx, betId: string) => s.server.ledger.balance(accounts.escrow(`bet:${betId}`));
const stakeOf = async (s: Ctx, betId: string) => (await s.server.db.select().from(schema.betStakes).where(eq(schema.betStakes.betId, betId))).length;

describe('sázkový bank', { timeout: 90_000 }, () => {
  it('vklady se zamknou v escrow a po konci turnaje se vyplatí poměrně mezi výherce', async () => {
    const s = await start();
    const g = await setup(s);
    const { id: betId } = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'winner', params: { userId: g.b }, side: 'yes', amount: 100 });
    expect(wallet(s, g.a)).toBe(START - 100 - 100);
    await s.server.bets.stake(g.b, betId, 'yes', 50);
    await s.server.bets.stake(g.c, betId, 'no', 50);
    expect(escrow(s, betId)).toBe(200);
    expect(await code(s.server.bets.stake(g.c, betId, 'yes', 10))).toBe('BOTH_SIDES');
    expect(await code(s.server.bets.stake(g.c, betId, 'no', 0))).toBe('INVALID');
    expect(await code(s.server.bets.stake(g.c, betId, 'no', 5000))).toBe('INVALID');

    await s.server.tournaments.start(g.org, g.id);
    await idle(s);
    expect(await code(s.server.bets.stake(g.c, betId, 'no', 10))).toBe('CLOSED');
    await s.server.tournaments.liveEliminate(g.org, g.id, g.c, [g.b]);
    await s.server.tournaments.liveEliminate(g.org, g.id, g.a, [g.b]);
    await idle(s);
    await s.server.journal.flush();

    const [bet] = await s.server.db.select().from(schema.bets).where(eq(schema.bets.id, betId));
    expect(bet).toMatchObject({ status: 'settled', outcome: 'yes' });
    expect(escrow(s, betId)).toBe(0);
    // bank 200 se dělí 100 : 50 mezi a a b
    expect(wallet(s, g.a)).toBe(START - 100 - 100 + 133);
    expect(wallet(s, g.b)).toBe(START - 100 - 50 + 67 + 300); // + výhra turnaje 300
    expect(wallet(s, g.c)).toBe(START - 100 - 50);
    // nic nevzniklo ani nezmizelo
    const total = [g.org, g.a, g.b, g.c].reduce((n, u) => n + wallet(s, u), 0) + s.server.ledger.balance(accounts.house());
    expect(total).toBe(4 * START);
  });

  it('poplatek domu se bere z banku a součet sedí', async () => {
    const s = await start({ 'bets.feePercent': 10 });
    const g = await setup(s);
    const { id: betId } = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'winner', params: { userId: g.b }, side: 'no', amount: 100 });
    await s.server.bets.stake(g.b, betId, 'yes', 100);
    await s.server.tournaments.start(g.org, g.id);
    await s.server.tournaments.liveEliminate(g.org, g.id, g.c, [g.a]);
    await s.server.tournaments.liveEliminate(g.org, g.id, g.b, [g.a]);
    await idle(s);
    expect(s.server.ledger.balance(accounts.house())).toBe(20);
    expect(wallet(s, g.a)).toBe(START - 100 - 100 + 180 + 300);
    expect(escrow(s, betId)).toBe(0);
  });

  it('ochrana proti sázení proti sobě a vypnutí sázení na sebe', async () => {
    const s = await start();
    const g = await setup(s);
    const { id: betId } = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'winner', params: { userId: g.b }, side: 'yes', amount: 10 });
    expect(await code(s.server.bets.stake(g.b, betId, 'no', 10))).toBe('AGAINST_SELF');
    expect(await code(s.server.bets.stake(g.b, betId, 'yes', 10))).toBe('OK');
    const off = await start({ 'bets.allowSelfBet': false });
    const h = await setup(off);
    const { id: b2 } = await off.server.bets.create(h.a, { tournamentId: h.id, subject: 'winner', params: { userId: h.b }, side: 'yes', amount: 10 });
    expect(await code(off.server.bets.stake(h.b, b2, 'yes', 10))).toBe('SELF');
    const fo = await off.server.bets.create(h.a, { tournamentId: h.id, subject: 'firstOut', params: { userId: h.c }, side: 'yes', amount: 10 });
    expect(await code(off.server.bets.stake(h.c, fo.id, 'no', 10))).toBe('SELF');
  });

  it('první vyřazený se vyhodnotí hned po prvním vyřazení', async () => {
    const s = await start();
    const g = await setup(s);
    const { id: betId } = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'firstOut', params: { userId: g.c }, side: 'yes', amount: 100 });
    await s.server.bets.stake(g.b, betId, 'no', 100);
    await s.server.tournaments.start(g.org, g.id);
    await s.server.tournaments.liveEliminate(g.org, g.id, g.c, [g.a]);
    await idle(s);
    const [bet] = await s.server.db.select().from(schema.bets).where(eq(schema.bets.id, betId));
    expect(bet).toMatchObject({ status: 'settled', outcome: 'yes' });
    expect(wallet(s, g.a)).toBe(START - 100 - 100 + 200);
    expect(wallet(s, g.b)).toBe(START - 100 - 100);
  });

  it('souboj a umístění; hráč mimo turnaj nebo rozhodnutá sázka se nevypíše', async () => {
    const s = await start();
    const g = await setup(s);
    const outsider = await s.user();
    expect(await code(s.server.bets.create(g.a, { tournamentId: g.id, subject: 'duel', params: { a: g.b, b: outsider } }))).toBe('INVALID');
    expect(await code(s.server.bets.create(g.a, { tournamentId: g.id, subject: 'duel', params: { a: g.b, b: g.b } }))).toBe('INVALID');
    expect(await code(s.server.bets.create(g.a, { tournamentId: g.id, subject: 'nesmysl', params: {} }))).toBe('INVALID');
    const duel = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'duel', params: { a: g.b, b: g.c }, side: 'yes', amount: 50 });
    await s.server.bets.stake(g.org, duel.id, 'no', 50);
    const place = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'place', params: { userId: g.c, place: 3 }, side: 'yes', amount: 20 });
    await s.server.bets.stake(g.org, place.id, 'no', 20);
    await s.server.tournaments.start(g.org, g.id);
    await s.server.tournaments.liveEliminate(g.org, g.id, g.c, [g.a]);
    await s.server.tournaments.liveEliminate(g.org, g.id, g.b, [g.a]);
    await idle(s);
    const rows = await s.server.db.select().from(schema.bets);
    expect(rows.find((r) => r.id === duel.id)).toMatchObject({ status: 'settled', outcome: 'yes' }); // b skončil výš než c
    expect(rows.find((r) => r.id === place.id)).toMatchObject({ status: 'settled', outcome: 'yes' });
  });
});

describe('přímá sázka', { timeout: 90_000 }, () => {
  it('přijmout jde jen opačnou stranou za stejnou částku a jen jednou; bez protistrany se při startu vrací', async () => {
    const s = await start();
    const g = await setup(s);
    const d = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'winner', params: { userId: g.b }, direct: true, side: 'yes', amount: 100 });
    expect(await code(s.server.bets.create(g.a, { tournamentId: g.id, subject: 'winner', params: { userId: g.b }, direct: true }))).toBe('INVALID');
    expect(await code(s.server.bets.stake(g.c, d.id, 'yes', 100))).toBe('INVALID');
    expect(await code(s.server.bets.stake(g.c, d.id, 'no', 50))).toBe('INVALID');
    expect(await code(s.server.bets.stake(g.a, d.id, 'no', 100))).toBe('BOTH_SIDES');
    await s.server.bets.stake(g.c, d.id, 'no', 100);
    expect(await code(s.server.bets.stake(g.org, d.id, 'no', 100))).toBe('CLOSED');
    const [bet] = await s.server.db.select().from(schema.bets).where(eq(schema.bets.id, d.id));
    expect(bet!.status).toBe('locked');

    const lone = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'winner', params: { userId: g.c }, direct: true, side: 'yes', amount: 40 });
    expect(wallet(s, g.a)).toBe(START - 100 - 100 - 40);
    await s.server.tournaments.start(g.org, g.id);
    await idle(s);
    const [v] = await s.server.db.select().from(schema.bets).where(eq(schema.bets.id, lone.id));
    expect(v).toMatchObject({ status: 'void' });
    expect(wallet(s, g.a)).toBe(START - 100 - 100); // vklad 40 se vrátil
    expect(escrow(s, lone.id)).toBe(0);
  });

  it('zakladatel může sázku zrušit, dokud do ní nevsadil nikdo jiný', async () => {
    const s = await start();
    const g = await setup(s);
    const d = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'winner', params: { userId: g.b }, side: 'yes', amount: 60 });
    expect(await code(s.server.bets.cancel(g.c, d.id))).toBe('FORBIDDEN');
    await s.server.bets.stake(g.c, d.id, 'no', 60);
    expect(await code(s.server.bets.cancel(g.a, d.id))).toBe('STATE');
    const solo = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'winner', params: { userId: g.c }, side: 'yes', amount: 60 });
    await s.server.bets.cancel(g.a, solo.id);
    expect(escrow(s, solo.id)).toBe(0);
    expect(await stakeOf(s, solo.id)).toBe(1);
  });
});

describe('zrušení turnaje a omezení', { timeout: 90_000 }, () => {
  it('při zrušení turnaje se všechny vklady vrátí', async () => {
    const s = await start();
    const g = await setup(s);
    const bet = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'winner', params: { userId: g.b }, side: 'yes', amount: 100 });
    await s.server.bets.stake(g.c, bet.id, 'no', 100);
    await s.server.tournaments.cancel(g.org, g.id);
    await idle(s);
    for (const u of [g.a, g.b, g.c]) expect(wallet(s, u)).toBe(START);
    expect(escrow(s, bet.id)).toBe(0);
    const [row] = await s.server.db.select().from(schema.bets).where(eq(schema.bets.id, bet.id));
    expect(row!.status).toBe('void');
  });

  it('limity: počet otevřených sázek, vypnutí, oprávnění', async () => {
    const s = await start({ 'bets.maxOpenPerUser': 2 });
    const g = await setup(s);
    for (let i = 0; i < 2; i++) await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'winner', params: { userId: g.b } });
    expect(await code(s.server.bets.create(g.a, { tournamentId: g.id, subject: 'winner', params: { userId: g.b } }))).toBe('LIMIT');
    expect(await code(s.server.bets.create(g.a, { tournamentId: 'neexistuje', subject: 'winner', params: { userId: g.b } }))).toBe('NOT_FOUND');
    const off = await start({ 'bets.enabled': false });
    const h = await setup(off);
    expect(await code(off.server.bets.create(h.a, { tournamentId: h.id, subject: 'winner', params: { userId: h.b } }))).toBe('DISABLED');
  });

  it('kdo nemá peníze, nevsadí a nic se nezapíše', async () => {
    const s = await start();
    const g = await setup(s);
    const bet = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'winner', params: { userId: g.b } });
    const poor = await start({ 'bets.maxStake': 100_000 });
    const h = await setup(poor);
    const b2 = await poor.server.bets.create(h.a, { tournamentId: h.id, subject: 'winner', params: { userId: h.b } });
    expect(await code(poor.server.bets.stake(h.c, b2.id, 'no', 50_000))).toBe('INSUFFICIENT_FUNDS');
    expect(await stakeOf(poor, b2.id)).toBe(0);
    expect(escrow(poor, b2.id)).toBe(0);
  });
});

describe('vlastní tvrzení', { timeout: 90_000 }, () => {
  it('navržený výsledek se potvrdí protistranou, sám po době, nebo ho rozhodne rozhodčí', async () => {
    const s = await start({ 'bets.disputeHours': 2 });
    const g = await setup(s);
    const ref = await s.user('reditel');
    const mk = async () => {
      const bet = await s.server.bets.create(g.a, { tournamentId: g.id, subject: 'custom', params: { text: 'Petr dnes vyhraje se 7-2' }, side: 'yes', amount: 100 });
      await s.server.bets.stake(g.b, bet.id, 'no', 100);
      return bet.id;
    };
    const first = await mk();
    const second = await mk();
    const third = await mk();
    await s.server.tournaments.start(g.org, g.id);
    await idle(s);
    expect(await code(s.server.bets.propose(g.c, first, 'yes'))).toBe('FORBIDDEN');
    await s.server.bets.propose(g.a, first, 'yes');
    expect(await code(s.server.bets.respond(g.a, first, true))).toBe('NOT_ELIGIBLE'); // vítěz potvrzovat nemůže
    await s.server.bets.respond(g.b, first, true);
    expect((await s.server.db.select().from(schema.bets).where(eq(schema.bets.id, first)))[0]).toMatchObject({ status: 'settled', outcome: 'yes' });

    await s.server.bets.propose(g.a, second, 'yes');
    expect(await s.server.bets.tick()).toBe(0);
    s.clock.advance(3 * 3600_000);
    expect(await s.server.bets.tick()).toBe(1);
    expect((await s.server.db.select().from(schema.bets).where(eq(schema.bets.id, second)))[0]).toMatchObject({ status: 'settled', outcome: 'yes' });

    await s.server.bets.propose(g.a, third, 'yes');
    await s.server.bets.respond(g.b, third, false);
    expect(await code(s.server.bets.decide(g.a, third, 'yes'))).toBe('FORBIDDEN');
    expect(await code(s.server.bets.decide(g.org, third, 'yes'))).toBe('FORBIDDEN'); // organizátor není rozhodčí
    await s.server.bets.decide(ref, third, 'no');
    expect((await s.server.db.select().from(schema.bets).where(eq(schema.bets.id, third)))[0]).toMatchObject({ status: 'settled', outcome: 'no' });
    for (const id of [first, second, third]) expect(escrow(s, id)).toBe(0);
    expect(wallet(s, g.a) + wallet(s, g.b)).toBe(2 * START - 100 - 100 /* turnaj */ + 0);
  });

  it('vypnuté vlastní tvrzení se nevypíše', async () => {
    const s = await start({ 'bets.customEnabled': false });
    const g = await setup(s);
    expect(await code(s.server.bets.create(g.a, { tournamentId: g.id, subject: 'custom', params: { text: 'Něco se stane' } }))).toBe('DISABLED');
  });
});

describe('odměna na hlavu', { timeout: 90_000 }, () => {
  it('odměna se zablokuje a vyplatí tomu, kdo hráče vyřadí; víc odměn se sčítá', async () => {
    const s = await start();
    const g = await setup(s);
    await s.server.headBounties.post(g.a, g.id, g.c, 50);
    await s.server.headBounties.post(g.b, g.id, g.c, 30);
    expect(wallet(s, g.a)).toBe(START - 100 - 50);
    expect((await s.server.headBounties.wantedOf(g.id))[g.c]).toBe(80);
    expect(s.server.headBounties.wantedSync(g.id, g.c)).toBe(80);
    await s.server.tournaments.start(g.org, g.id);
    await s.server.tournaments.liveEliminate(g.org, g.id, g.c, [g.b]);
    await idle(s);
    expect(wallet(s, g.b)).toBe(START - 100 - 30 + 80);
    expect(wallet(s, g.a)).toBe(START - 100 - 50);
    expect((await s.server.headBounties.wantedOf(g.id))[g.c]).toBeUndefined();
    expect(s.server.headBounties.wantedSync(g.id, g.c)).toBe(0);
    const list = await s.server.headBounties.list(g.id);
    expect(list.bounties.every((x) => x.status === 'paid')).toBe(true);
  });

  it('víc vyřazujících dělí odměnu podle váhy a součet sedí', async () => {
    const s = await start();
    const g = await setup(s);
    await s.server.headBounties.post(g.org, g.id, g.c, 101);
    await s.server.tournaments.start(g.org, g.id);
    await s.server.tournaments.liveEliminate(g.org, g.id, g.c, [g.a, g.b]);
    await idle(s);
    expect(wallet(s, g.a) + wallet(s, g.b)).toBe(2 * START - 200 + 101);
    expect(s.server.ledger.balance(accounts.escrow('hb:x'))).toBe(0);
  });

  it('bez vyřazujícího se odměna podle nastavení vrátí, propadne domu, nebo připadne vítězi', async () => {
    for (const rule of ['return', 'house', 'winner'] as const) {
      const s = await start({ 'headBounty.noKiller': rule });
      const g = await setup(s);
      await s.server.headBounties.post(g.a, g.id, g.c, 50);
      await s.server.tournaments.start(g.org, g.id);
      await s.server.tournaments.liveEliminate(g.org, g.id, g.c, []);
      await s.server.tournaments.liveEliminate(g.org, g.id, g.a, [g.b]);
      await idle(s);
      const bank = rule === 'return' ? 0 : rule === 'house' ? 50 : 0;
      expect(s.server.ledger.balance(accounts.house())).toBe(bank);
      expect(wallet(s, g.a)).toBe(START - 100 - (rule === 'return' ? 0 : 50));
      expect(wallet(s, g.b)).toBe(START - 100 + 300 + (rule === 'winner' ? 50 : 0));
    }
  });

  it('přežil-li hráč, odměna se vrátí; při zrušení turnaje se vrací vždy', async () => {
    const s = await start();
    const g = await setup(s);
    await s.server.headBounties.post(g.a, g.id, g.b, 40);
    await s.server.tournaments.start(g.org, g.id);
    await s.server.tournaments.liveEliminate(g.org, g.id, g.c, [g.b]);
    await s.server.tournaments.liveEliminate(g.org, g.id, g.a, [g.b]);
    await idle(s);
    expect(wallet(s, g.a)).toBe(START - 100);
    const c = await start({ 'headBounty.survived': 'house' });
    const h = await setup(c);
    await c.server.headBounties.post(h.a, h.id, h.b, 40);
    await c.server.tournaments.cancel(h.org, h.id);
    await idle(c);
    expect(wallet(c, h.a)).toBe(START);
  });

  it('pravidla: na sebe ne, limity částky a počtu, vypnutí, zablokovaný hráč mimo turnaj', async () => {
    const s = await start({ 'headBounty.maxPerPoster': 2 });
    const g = await setup(s);
    expect(await code(s.server.headBounties.post(g.a, g.id, g.a, 50))).toBe('SELF');
    expect(await code(s.server.headBounties.post(g.a, g.id, g.b, 1))).toBe('INVALID');
    expect(await code(s.server.headBounties.post(g.a, g.id, g.b, 5000))).toBe('INVALID');
    const outsider = await s.user();
    expect(await code(s.server.headBounties.post(g.a, g.id, outsider, 50))).toBe('NOT_ELIGIBLE');
    await s.server.headBounties.post(g.a, g.id, g.b, 20);
    await s.server.headBounties.post(g.a, g.id, g.c, 20);
    expect(await code(s.server.headBounties.post(g.a, g.id, g.b, 20))).toBe('LIMIT');
    const off = await start({ 'headBounty.enabled': false });
    const h = await setup(off);
    expect(await code(off.server.headBounties.post(h.a, h.id, h.b, 50))).toBe('DISABLED');
  });
});
