import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock, seededRandom, type LegalActions, type PlayerAction } from '@kb/game-core';
import { buildServer } from './app.js';
import { AchievementError } from './achievements.js';
import { schema } from './db/index.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const FAST = { 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.turnSeconds': 3, 'odds.enabled': false };

async function start(settings: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 10), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `U${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}
type Ctx = Awaited<ReturnType<typeof start>>;

const settle = async (c: Ctx) => {
  for (let i = 0; i < 4; i++) {
    await c.server.stats.idle();
    await c.server.progress.idle();
    await c.server.achievements.idle();
  }
  await new Promise((r) => setTimeout(r, 30));
};

function tame(l: LegalActions, rnd: () => number): PlayerAction {
  const r = rnd();
  if (l.canCheck) return r < 0.8 || (!l.canBet && !l.canRaise) ? { type: 'check' } : { type: l.canBet ? 'bet' : 'raise', amount: l.minRaiseTo };
  if (r < 0.65) return { type: 'call' };
  if (r < 0.9 || !l.canRaise) return { type: 'fold' };
  return { type: 'raise', amount: l.minRaiseTo };
}

async function playCash(c: Ctx, players: string[], hands: number, seed: number) {
  const org = await c.user('organizator');
  const { id } = await c.server.tables.createTable(org, { name: 'Úspěchy', templateId: 'cash-klasika', settings: FAST });
  const actor = c.server.tables.get(id)!;
  players.forEach((p, i) => {
    actor.join(p, `U${i}`, i, 500);
    actor.setConnected(p, true);
    actor.sitIn(p);
  });
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
      done = (await c.server.db.select({ id: schema.hands.id }).from(schema.hands).where(eq(schema.hands.tableId, id))).length;
    }
  }
  await settle(c);
}

const earned = async (c: Ctx, userId: string) => (await c.server.achievements.list(userId)).filter((a) => a.earned).map((a) => a.key);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AchievementError) return e.code;
    throw e;
  }
};

describe('úspěchy', { timeout: 120_000 }, () => {
  it('vestavěný katalog se doplní; první handa přinese úspěch, odměnu v XP i upozornění, jen jednou', async () => {
    const c = await start();
    const ps = [await c.user(), await c.user()];
    const cat = await c.server.achievements.list(ps[0]!);
    expect(cat.map((a) => a.key)).toEqual(expect.arrayContaining(['first_hand', 'royal_flush', 'first_tournament_win']));
    expect(await earned(c, ps[0]!)).toEqual([]);

    await playCash(c, ps, 3, 5);
    const got = await earned(c, ps[0]!);
    expect(got).toContain('first_hand');
    expect(got).not.toContain('hands_100');
    const xp = await c.server.db.select().from(schema.xpEvents).where(eq(schema.xpEvents.userId, ps[0]!));
    expect(xp.filter((r) => r.source === 'achievement' && r.ref === 'first_hand')).toHaveLength(1);
    expect(xp.find((r) => r.ref === 'first_hand')!.amount).toBe(5);
    const notes = await c.server.db.select().from(schema.notifications).where(eq(schema.notifications.userId, ps[0]!));
    expect(notes.filter((n) => n.kind === 'achievement')).toHaveLength(got.length);
    // opakované vyhodnocení nic nezdvojí
    await c.server.achievements.evaluate([ps[0]!], ['hand', 'tournament', 'level']);
    await settle(c);
    expect(await earned(c, ps[0]!)).toEqual(got);
    expect((await c.server.db.select().from(schema.playerAchievements).where(eq(schema.playerAchievements.userId, ps[0]!))).length).toBe(got.length);
  });

  it('turnaj: výhra a vlastní úspěch za vyřazení soupeřů; správa úspěchů a oprávnění', async () => {
    const c = await start();
    const curator = await c.user('statistik');
    const [a, b, d, e] = [await c.user(), await c.user(), await c.user(), await c.user()];
    expect(await code(c.server.achievements.create(a, { key: 'moje', name: 'Moje', icon: '⭐', condition: { type: 'knockouts', value: 3 } }))).toBe('FORBIDDEN');
    expect(await code(c.server.achievements.create(curator, { key: 'Spatny Klic', name: 'X', icon: '⭐', condition: { type: 'knockouts', value: 3 } }))).toBe('INVALID');
    expect(await code(c.server.achievements.create(curator, { key: 'zly', name: 'X', icon: '⭐', condition: { type: 'nesmysl', value: 3 } }))).toBe('INVALID');
    await c.server.achievements.create(curator, { key: 'lovec3', name: 'Lovec tří', icon: '🎯', description: '3 vyřazení', xp: 25, condition: { type: 'knockouts', value: 3 } });
    expect(await code(c.server.achievements.create(curator, { key: 'lovec3', name: 'Znovu', icon: '⭐', condition: { type: 'knockouts', value: 3 } }))).toBe('KEY_TAKEN');

    for (const [i, victim] of [b, d, e].entries()) c.server.progress.onElimination('tx', { userId: victim, remaining: 3 - i, by: [{ userId: a, weight: 1 }] });
    const results = [{ userId: a, place: 1, payout: 100 }, { userId: e, place: 2, payout: 0 }, { userId: d, place: 3, payout: 0 }, { userId: b, place: 4, payout: 0 }];
    c.server.stats.recordTournament('tx', { targetMinutes: 180, rated: true }, { finishedAt: c.clock.now(), results, payments: [] });
    c.server.progress.onTournamentFinished('tx', results, null, c.clock.now());
    await settle(c);
    const got = await earned(c, a);
    expect(got).toEqual(expect.arrayContaining(['lovec3', 'first_tournament_win']));
    expect(await earned(c, b)).not.toContain('lovec3');
    const xp = await c.server.db.select().from(schema.xpEvents).where(eq(schema.xpEvents.userId, a));
    expect(xp.find((r) => r.ref === 'lovec3')!.amount).toBe(25);

    // vestavěný úspěch jde upravit a vypnout, ne smazat; podmínka se nemění
    expect(await code(c.server.achievements.remove(curator, 'first_hand'))).toBe('BUILTIN');
    await c.server.achievements.update(curator, 'first_hand', { xp: 7, condition: { type: 'handsPlayed', value: 999 } });
    const fh = (await c.server.achievements.list(curator, { all: true })).find((x) => x.key === 'first_hand')!;
    expect(fh).toMatchObject({ xp: 7, condition: { type: 'handsPlayed', value: 1 } });
    // vlastní jde smazat
    await c.server.achievements.remove(curator, 'lovec3');
    expect((await c.server.achievements.list(a)).some((x) => x.key === 'lovec3')).toBe(false);
  });

  it('vypnutý úspěch se neuděluje; nově přidaný se doplní i zpětně; level spouští úspěch', async () => {
    const c = await start();
    const curator = await c.user('statistik');
    const ps = [await c.user(), await c.user()];
    await c.server.achievements.update(curator, 'first_hand', { enabled: false });
    await playCash(c, ps, 3, 7);
    expect(await earned(c, ps[0]!)).not.toContain('first_hand');
    // správce přidá úspěch zpětně dosažitelný z historie: hráč ho dostane i bez další hry
    await c.server.achievements.create(curator, { key: 'zpetne', name: 'Zpětně', icon: '⏪', xp: 3, condition: { type: 'handsPlayed', value: 1 } });
    await settle(c);
    expect(await earned(c, ps[0]!)).toContain('zpetne');
    expect(await earned(c, ps[0]!)).not.toContain('first_hand');
    // level: velká odměna za XP přeskočí levely a odemkne level_10
    const lv = await start({ 'xp.levelBase': 1, 'xp.levelExponentPercent': 100 });
    const x = await lv.user();
    lv.server.progress.grant(x, 'bonus', 5000);
    await settle(lv);
    expect((await lv.server.progress.progressOf(x)).level).toBeGreaterThanOrEqual(10);
    expect(await earned(lv, x)).toContain('level_10');
  });
});

describe('úspěch za all-in s malou šancí', { timeout: 120_000 }, () => {
  it('vyhraný all-in pod 10 % šancí udělí úspěch Zázrak, vyšší šance ne', async () => {
    const c = await start();
    const ps = [await c.user(), await c.user()];
    await playCash(c, ps, 3, 5);
    expect(await earned(c, ps[0]!)).not.toContain('longshot');
    // vyhraná handa s šancí 30 % ještě není zázrak
    const rows = await c.server.db.select().from(schema.handPlayers).where(eq(schema.handPlayers.userId, ps[0]!));
    await c.server.db.update(schema.handPlayers).set({ won: 100, allInEquity: 0.3 }).where(eq(schema.handPlayers.handId, rows[0]!.handId));
    await c.server.achievements.evaluate([ps[0]!], ['hand']);
    await settle(c);
    expect(await earned(c, ps[0]!)).not.toContain('longshot');
    await c.server.db.update(schema.handPlayers).set({ won: 100, allInEquity: 0.05 }).where(eq(schema.handPlayers.handId, rows[0]!.handId));
    await c.server.achievements.evaluate([ps[0]!], ['hand']);
    await settle(c);
    expect(await earned(c, ps[0]!)).toContain('longshot');
  });
});
