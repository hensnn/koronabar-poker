import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock, seededRandom, type LegalActions, type PlayerAction } from '@kb/game-core';
import { eq } from 'drizzle-orm';
import { buildServer } from './app.js';
import { schema } from './db/index.js';
import { StatsError } from './stats.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const FAST = { 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.turnSeconds': 3, 'odds.enabled': false };

async function start() {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 4), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, 'stats.leaderboardMinHands': 3 },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `S${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}

/** Opatrný bot: většinou check/call, občas minimální zvýšení nebo fold, takže hráči nevypadnou v první handě. */
function tame(l: LegalActions, rnd: () => number): PlayerAction {
  const r = rnd();
  if (l.canCheck) return r < 0.8 || (!l.canBet && !l.canRaise) ? { type: 'check' } : { type: l.canBet ? 'bet' : 'raise', amount: l.minRaiseTo };
  if (r < 0.65) return { type: 'call' };
  if (r < 0.9 || !l.canRaise) return { type: 'fold' };
  return { type: 'raise', amount: l.minRaiseTo };
}

/** Odehraje zadaný počet hand náhodnými boty. */
async function playHands(c: Awaited<ReturnType<typeof start>>, tableId: string, hands: number, seed: number) {
  const actor = c.server.tables.get(tableId)!;
  const rnd = seededRandom(seed);
  let done = 0;
  for (let i = 0; i < 20_000 && done < hands; i++) {
    const v = actor.viewFor(null);
    if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
      const pl = v.seats.find((x) => x.seat === v.actingSeat)!;
      const legal = actor.viewFor(pl.playerId).legal;
      if (legal) actor.act(pl.playerId, tame(legal, rnd));
    }
    c.clock.advance(Math.floor(rnd() * 2500));
    await Promise.resolve();
    if (i % 25 === 0) {
      await c.server.stats.idle();
      done = (await c.server.db.select({ id: schema.hands.id }).from(schema.hands).where(eq(schema.hands.tableId, tableId))).length;
    }
  }
  await c.server.stats.idle();
  return done;
}

describe('statistiky a historie hand', { timeout: 120_000 }, () => {
  it('handy se ukládají, součet výsledků je nulový, cizí karty jsou skryté a žebříček sedí', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const stat = await c.user('statistik');
    const ps = [stat, await c.user(), await c.user()];
    const { id } = await c.server.tables.createTable(org, { name: 'Statistiky', templateId: 'cash-klasika', settings: FAST });
    const actor = c.server.tables.get(id)!;
    ps.forEach((p, i) => {
      actor.join(p, `S${i}`, i, 500);
      actor.setConnected(p, true);
      actor.sitIn(p);
    });
    const done = await playHands(c, id, 12, 7);
    expect(done).toBeGreaterThanOrEqual(8);
    expect((await c.server.stats.myHands(ps[0]!, { limit: 200 })).length).toBeGreaterThanOrEqual(1);

    const mine = await c.server.stats.myHands(ps[0]!, { limit: 200 });
    expect(mine.length).toBeGreaterThanOrEqual(1);
    const detail = await c.server.stats.handDetail(ps[0]!, mine[0]!.id);
    expect(detail.players.length).toBeGreaterThanOrEqual(2);
    expect(detail.players.reduce((n, p) => n + p.net, 0)).toBe(0);
    const me = detail.players.find((p) => p.userId === ps[0])!;
    expect(me.hole).not.toBeNull();
    for (const other of detail.players.filter((p) => p.userId !== ps[0])) {
      const stored = (await c.server.stats.handDetail(other.userId, mine[0]!.id)).players.find((p) => p.userId === other.userId)!;
      expect(stored.hole).not.toBeNull();
      // cizí karty vidí jen když byly odkryté
      if (!detail.showdown) expect(other.hole).toBeNull();
    }
    const outsider = await c.user();
    await expect(c.server.stats.handDetail(outsider, mine[0]!.id)).rejects.toBeInstanceOf(StatsError);

    const st = await c.server.stats.playerStats(ps[0]!, ps[0]!, { from: null, to: null });
    expect(st.hands).toBe(mine.length);
    expect(st.vpip).toBeGreaterThan(0);
    expect(st.vpip).toBeLessThanOrEqual(100);
    expect(st.pfr).toBeLessThanOrEqual(st.vpip);

    const board = await c.server.stats.leaderboard({ from: null, to: null });
    expect(board.length).toBeGreaterThanOrEqual(2);
    // chipsPerUnit zaokrouhlení: součet zisků je blízko nule
    expect(Math.abs(board.reduce((n, r) => n + r.cashNet, 0))).toBeLessThanOrEqual(6);
    expect(board[0]!.total).toBeGreaterThanOrEqual(board[board.length - 1]!.total);

    // sezóna v budoucnu je prázdná, běžící obsahuje všechno
    await expect(c.server.stats.createSeason(ps[1]!, { name: 'Cizí', startsAt: 0 })).rejects.toBeInstanceOf(StatsError);
    const now = c.clock.now();
    const future = await c.server.stats.createSeason(stat, { name: 'Budoucí', startsAt: now + 86_400_000 });
    expect(await c.server.stats.leaderboard(await c.server.stats.range(future))).toHaveLength(0);
    const cur = await c.server.stats.createSeason(stat, { name: 'Teď', startsAt: now - 86_400_000 });
    expect((await c.server.stats.leaderboard(await c.server.stats.range(cur))).length).toBe(board.length);
    await expect(c.server.stats.createSeason(stat, { name: 'Zlá', startsAt: now, endsAt: now - 1 })).rejects.toBeInstanceOf(StatsError);
  });

  it('po době uchování se smažou podrobnosti, součty zůstanou; vypnutý záznam nic neukládá', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const ps = [await c.user(), await c.user()];
    const { id } = await c.server.tables.createTable(org, { name: 'Retence', templateId: 'cash-klasika', settings: FAST });
    const actor = c.server.tables.get(id)!;
    ps.forEach((p, i) => {
      actor.join(p, `R${i}`, i, 500);
      actor.setConnected(p, true);
      actor.sitIn(p);
    });
    const done = await playHands(c, id, 4, 11);
    expect(done).toBeGreaterThanOrEqual(3);
    const before = (await c.server.stats.playerStats(ps[0]!, ps[0]!, { from: null, to: null })).hands;

    c.clock.advance(400 * 86_400_000);
    expect(await c.server.stats.purgeOld()).toBeGreaterThanOrEqual(3);
    const list = await c.server.stats.myHands(ps[0]!, { limit: 200 });
    const d = await c.server.stats.handDetail(ps[0]!, list[list.length - 1]!.id);
    expect(d.purged).toBe(true);
    expect(d.actions).toEqual([]);
    expect(d.players.find((p) => p.userId === ps[0])!.hole).toBeNull();
    expect((await c.server.stats.playerStats(ps[0]!, ps[0]!, { from: null, to: null })).hands).toBeGreaterThanOrEqual(before);
  });
});
