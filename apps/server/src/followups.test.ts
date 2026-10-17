import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { PollError } from './polls.js';
import { schema } from './db/index.js';

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
    masterKey: { key: Buffer.alloc(32, 20), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `F${n++}x`;
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
    if (e instanceof PollError) return e.code;
    throw e;
  }
};

const LIVE = { 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9 };

describe('sezónní žebříček ratingu', { timeout: 60_000 }, () => {
  it('řadí podle ratingu po poslední hře sezóny a ukazuje posun a počet her', async () => {
    const s = await start();
    const [a, b, old] = [await s.user(), await s.user(), await s.user()];
    const db = s.server.db;
    const t0 = new Date('2026-03-01T12:00:00Z');
    const ev = (userId: string, ref: string, at: Date, before: number, after: number) => ({ userId, scope: 'tournament', ref, kind: 'game', at, muBefore: 25, sigmaBefore: 8, muAfter: 25, sigmaAfter: 8, displayBefore: before, displayAfter: after });
    for (const u of [a, b, old]) await db.insert(schema.ratingState).values({ userId: u, scope: 'tournament', mu: 25, sigma: 6, games: 20, peak: 1500 });
    await db.insert(schema.ratingEvents).values([
      ev(a, 't1', t0, 1500, 1540),
      ev(a, 't2', new Date(t0.getTime() + 86_400_000), 1540, 1580),
      ev(b, 't1', t0, 1500, 1620),
      ev(old, 'prev', new Date('2025-12-01T12:00:00Z'), 1500, 1900), // mimo sezónu
    ]);
    const rows = await s.server.rating.seasonLeaderboard('tournament', new Date('2026-01-01T00:00:00Z'), null);
    expect(rows.map((r) => r.userId)).toEqual([b, a]);
    expect(rows[0]).toMatchObject({ rank: 1, games: 1, delta: 120 });
    expect(rows[1]).toMatchObject({ rank: 2, games: 2, delta: 80, rating: 1580 });
  });
});

describe('potvrzené podezření v ratingu', { timeout: 60_000 }, () => {
  it('ostatní správci a (volitelně) dotčení hráči dostanou upozornění, o ratingu rozhoduje člověk', async () => {
    const s = await start({ 'rating.flagNotifyPlayers': true });
    const stat = await s.user('statistik');
    const [a, b] = [await s.user(), await s.user()];
    await s.server.db.insert(schema.ratingFlags).values({ kind: 'heads_up_pair', userA: a, userB: b, windowKey: 'w1', detail: { count: 3 } });
    const [flag] = await s.server.db.select().from(schema.ratingFlags);
    await s.server.rating.resolveFlag(s.admin, flag!.id, 'dismissed');
    expect(await s.server.db.select().from(schema.notifications)).toHaveLength(0);
    await s.server.db.insert(schema.ratingFlags).values({ kind: 'chip_flow', userA: a, userB: b, windowKey: 'w2', detail: {} });
    const flags = await s.server.db.select().from(schema.ratingFlags);
    await s.server.rating.resolveFlag(s.admin, flags.find((f) => f.windowKey === 'w2')!.id, 'confirmed', 'ověřeno');
    const notes = await s.server.db.select().from(schema.notifications);
    expect(notes.filter((n) => n.kind === 'ratingFlag').map((n) => n.userId)).toEqual([stat]);
    expect(notes.filter((n) => n.kind === 'ratingFlagPlayer').map((n) => n.userId).sort()).toEqual([a, b].sort());
  });
});

describe('hlasování o pauze turnaje', { timeout: 90_000 }, () => {
  async function running(s: Awaited<ReturnType<typeof start>>) {
    const org = await s.user('organizator');
    const [a, b, c] = [await s.user(), await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, { name: 'Pauza', templateId: 'tour-turbo', settings: LIVE });
    for (const p of [a, b, c]) await s.server.tournaments.liveRegister(org, id, p);
    await s.server.tournaments.start(org, id);
    return { org, a, b, c, id };
  }

  it('hráč navrhne pauzu, hlasující ji odsouhlasí a turnaj se pozastaví', async () => {
    const s = await start();
    const g = await running(s);
    const outsider = await s.user();
    expect(await code(s.server.polls.startPauseVote(outsider, g.id))).toBe('NOT_ELIGIBLE');
    expect(await code(s.server.polls.startPauseVote(g.a, 'neexistuje'))).toBe('NOT_FOUND');
    const pollId = await s.server.polls.startPauseVote(g.a, g.id);
    expect(await code(s.server.polls.startPauseVote(g.b, g.id))).toBe('LIMIT');
    for (const u of [g.a, g.b]) await s.server.polls.vote(u, pollId, { type: 'yesno', value: 'yes' }); // většina rozhodne hned
    await new Promise((r) => setTimeout(r, 300));
    expect(s.server.tournaments.get(g.id)!.state().paused).toBe(true);
    const [poll] = await s.server.db.select().from(schema.polls).where(eq(schema.polls.id, pollId));
    expect(poll!.status).toBe('closed');
  });

  it('zamítnutá pauza se neprovede a další návrh musí počkat', async () => {
    const s = await start();
    const g = await running(s);
    const pollId = await s.server.polls.startPauseVote(g.a, g.id);
    await s.server.polls.vote(g.a, pollId, { type: 'yesno', value: 'yes' });
    await s.server.polls.vote(g.b, pollId, { type: 'yesno', value: 'no' });
    await s.server.polls.vote(g.c, pollId, { type: 'yesno', value: 'no' });
    await new Promise((r) => setTimeout(r, 300));
    expect(s.server.tournaments.get(g.id)!.state().paused).toBe(false);
    expect(await code(s.server.polls.startPauseVote(g.a, g.id))).toBe('LIMIT');
  });

  it('vypnutí a zneužití: parametr byVote z veřejného rozhraní neprojde', async () => {
    const s = await start({ 'poll.pauseVoteEnabled': false });
    const g = await running(s);
    expect(await code(s.server.polls.startPauseVote(g.a, g.id))).toBe('DISABLED');
    const on = await start();
    const org = await on.user('organizator');
    const { id } = await on.server.tournaments.create(org, { name: 'XX', templateId: 'tour-turbo', settings: LIVE });
    expect(await code(on.server.polls.create(on.admin, { title: 'Podvod', config: { type: 'yesno' }, action: { kind: 'pauseGame', params: { tournamentId: id, byVote: true } } }))).toBe('INVALID');
  });
});

describe('živý cash: XP, statistiky a hlášky', { timeout: 60_000 }, () => {
  it('po uzavření dostanou hráči XP a výsledek je ve statistikách i hlášce', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [a, b] = [await s.user(), await s.user()];
    const { id } = await s.server.liveCash.create(org, 'Cash');
    await s.server.liveCash.buyIn(org, id, a, 500);
    await s.server.liveCash.buyIn(org, id, b, 500);
    expect(s.server.announcer.forTv(s.clock.now()).some((x) => x.event === 'liveCashBuyIn')).toBe(true);
    await s.server.liveCash.cashOut(org, id, a, 700);
    await s.server.liveCash.cashOut(org, id, b, 300);
    await s.server.liveCash.close(org, id);
    await s.server.progress.idle();
    const xp = await s.server.db.select().from(schema.xpEvents).where(eq(schema.xpEvents.source, 'cashSession'));
    expect(xp.map((x) => x.userId).sort()).toEqual([a, b].sort());
    const board = await s.server.stats.leaderboard({ from: null, to: null });
    expect(board.find((r) => r.userId === a)?.cashNet).toBe(200);
    expect(board.find((r) => r.userId === b)?.cashNet).toBe(-200);
    // zpětný přepočet XP živý cash nesmaže
    await s.server.progress.recompute(false);
    const after = await s.server.db.select().from(schema.xpEvents).where(eq(schema.xpEvents.source, 'cashSession'));
    expect(after).toHaveLength(2);
  });
});
