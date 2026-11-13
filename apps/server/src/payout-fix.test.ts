import { afterEach, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { FakeClock, type TournamentState } from '@kb/game-core';
import { accounts } from '@kb/ledger';
import { buildServer } from './app.js';
import { ConsistencyError } from './consistency.js';
import { schema } from './db/index.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start() {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 31), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000 },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `V${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}
type Ctx = Awaited<ReturnType<typeof start>>;

const LIVE = { 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9, 'tournament.payoutPreset': 'custom', 'tournament.payoutCustom': '50,30,20' };

/** Plays a 4-player live tournament to the end: `ps[0]` wins, `ps[3]` finishes last. Payouts 200 / 120 / 80 / 0. */
async function finished(s: Ctx, org: string, ps: string[]): Promise<string> {
  const { id } = await s.server.tournaments.create(org, { name: 'Přepočet', templateId: 'tour-turbo', settings: LIVE });
  for (const p of ps) await s.server.tournaments.liveRegister(org, id, p);
  await s.server.tournaments.start(org, id);
  for (const p of [ps[3]!, ps[2]!, ps[1]!]) await s.server.tournaments.liveEliminate(org, id, p, [ps[0]!]);
  await s.server.journal.flush();
  await new Promise((r) => setTimeout(r, 300));
  await s.server.journal.flush();
  return id;
}

/**
 * Rewrites a correctly finished tournament into what the old bug produced: the winner and the 4th place once busted
 * together, both bought back in, and at the end they shared the 1st and the 4th payout (200 + 0 -> 100 + 100).
 * The tournament is dropped from memory first, as every older tournament on a real server is.
 */
async function breakLikeTheOldBug(s: Ctx, id: string, winner: string, fourth: string): Promise<void> {
  (s.server.tournaments as unknown as { archive(id: string): void }).archive(id);
  const [row] = await s.server.db.select().from(schema.tournaments).where(eq(schema.tournaments.id, id));
  const st = row!.state as TournamentState;
  st.results!.find((r) => r.userId === winner)!.payout = 100;
  st.results!.find((r) => r.userId === fourth)!.payout = 100;
  st.tiedGroups = [[winner, fourth]];
  await s.server.db.update(schema.tournaments).set({ state: st }).where(eq(schema.tournaments.id, id));
  s.server.ledger.post({ kind: 'turnaj_vyplata', idempotencyKey: `test:${id}:bug`, gameId: id, entries: [{ account: accounts.wallet(winner), amount: -100 }, { account: accounts.wallet(fourth), amount: 100 }] });
  const gr = schema.gameResults;
  for (const u of [winner, fourth]) await s.server.db.update(gr).set({ payout: 100 }).where(and(eq(gr.ref, id), eq(gr.userId, u)));
  await s.server.journal.flush();
}

describe('přepočet výplat starších turnajů', { timeout: 120_000 }, () => {
  it('správně vyplacený turnaj kontrola nehlásí', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const ps = [await s.user(), await s.user(), await s.user(), await s.user()];
    const id = await finished(s, org, ps);
    const view = await s.server.tournaments.view(id, ps[0]!);
    expect(view.results!.map((r) => r.payout)).toEqual([200, 120, 80, 0]);
    expect(await s.server.consistency.payoutReport(s.admin)).toEqual([]);
    expect((await s.server.consistency.run(s.admin)).checks.find((c) => c.id === 'tournamentPayouts')).toMatchObject({ ok: true, problems: 0 });
  });

  it('najde chybně rozdělenou výhru, ukáže rozdíly a po potvrzení je převede mezi hráči', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const ps = [await s.user(), await s.user(), await s.user(), await s.user()];
    const [winner, , , fourth] = ps as [string, string, string, string];
    const id = await finished(s, org, ps);
    await breakLikeTheOldBug(s, id, winner, fourth);
    const bal = (u: string) => s.server.ledger.balance(accounts.wallet(u));
    const before = ps.map(bal);
    expect(before).toEqual([10_000, 10_020, 9_980, 10_000]);

    // the report lists every place with what was paid and what should have been paid
    const report = await s.server.consistency.payoutReport(s.admin);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ id, kind: 'fixable', pool: 400, paidPlaces: 3 });
    expect(report[0]!.rows.map((r) => [r.place, r.paid, r.correct, r.flagged])).toEqual([
      [1, 100, 200, true],
      [2, 120, 120, false],
      [3, 80, 80, false],
      [4, 100, 0, true],
    ]);
    const check = (await s.server.consistency.run(s.admin)).checks.find((c) => c.id === 'tournamentPayouts')!;
    expect(check).toMatchObject({ ok: false, problems: 1 });

    // reading and repairing need the ledger permissions; a player gets neither
    await expect(s.server.consistency.payoutReport(ps[1]!)).rejects.toThrow(ConsistencyError);
    await expect(s.server.consistency.repairPayouts(ps[1]!, id)).rejects.toThrow(ConsistencyError);

    // the overpaid player has spent the money: nothing moves, the wallet must not go below zero
    s.server.ledger.post({ kind: 'cash_buyin', idempotencyKey: 'test:spend', gameId: 'stul-x', entries: [{ account: accounts.wallet(fourth), amount: -9_950 }, { account: accounts.table('stul-x'), amount: 9_950 }] });
    await expect(s.server.consistency.repairPayouts(s.admin, id)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS', params: { owes: 100, has: 50 } });
    expect(bal(winner)).toBe(10_000);
    s.server.ledger.post({ kind: 'cash_cashout', idempotencyKey: 'test:back', gameId: 'stul-x', entries: [{ account: accounts.table('stul-x'), amount: -9_950 }, { account: accounts.wallet(fourth), amount: 9_950 }] });

    // the repair: one balanced move between the two wallets, nothing created and nothing lost
    const total = ps.reduce((n, u) => n + bal(u), 0);
    expect(await s.server.consistency.repairPayouts(s.admin, id)).toEqual({ moved: 100 });
    expect(ps.map(bal)).toEqual([10_100, 10_020, 9_980, 9_900]);
    expect(ps.reduce((n, u) => n + bal(u), 0)).toBe(total);

    // the tournament record, the statistics and the checks agree again
    const view = await s.server.tournaments.view(id, winner);
    expect(view.results!.map((r) => r.payout)).toEqual([200, 120, 80, 0]);
    const [row] = await s.server.db.select().from(schema.tournaments).where(eq(schema.tournaments.id, id));
    const st = row!.state as TournamentState;
    expect(st.payoutFix?.before).toEqual({ [winner]: 100, [fourth]: 100 });
    expect(st.tiedGroups).toEqual([]);
    const stats = await s.server.db.select().from(schema.gameResults).where(eq(schema.gameResults.ref, id));
    expect(stats.find((r) => r.userId === winner)!.payout).toBe(200);
    expect(stats.find((r) => r.userId === fourth)!.payout).toBe(0);
    expect(await s.server.consistency.payoutReport(s.admin)).toEqual([]);
    const after = await s.server.consistency.run(s.admin);
    expect(after.checks.filter((c) => !c.ok), JSON.stringify(after.checks.filter((c) => !c.ok))).toEqual([]);

    // a second repair has nothing to do and moves nothing
    await expect(s.server.consistency.repairPayouts(s.admin, id)).rejects.toMatchObject({ code: 'NOTHING_TO_FIX' });
    expect(ps.map(bal)).toEqual([10_100, 10_020, 9_980, 9_900]);
  });
});
