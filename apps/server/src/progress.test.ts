import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock, seededRandom, type LegalActions, type PlayerAction } from '@kb/game-core';
import { buildServer } from './app.js';
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
    masterKey: { key: Buffer.alloc(32, 9), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `X${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}
type Ctx = Awaited<ReturnType<typeof start>>;

function tame(l: LegalActions, rnd: () => number): PlayerAction {
  const r = rnd();
  if (l.canCheck) return r < 0.8 || (!l.canBet && !l.canRaise) ? { type: 'check' } : { type: l.canBet ? 'bet' : 'raise', amount: l.minRaiseTo };
  if (r < 0.65) return { type: 'call' };
  if (r < 0.9 || !l.canRaise) return { type: 'fold' };
  return { type: 'raise', amount: l.minRaiseTo };
}

async function playCash(c: Ctx, players: string[], hands: number, seed: number) {
  const org = await c.user('organizator');
  const { id } = await c.server.tables.createTable(org, { name: 'XP stůl', templateId: 'cash-klasika', settings: FAST });
  const actor = c.server.tables.get(id)!;
  players.forEach((p, i) => {
    actor.join(p, `X${i}`, i, 500);
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
  await c.server.stats.idle();
  await c.server.progress.idle();
  return id;
}

const events = async (c: Ctx, userId: string) => c.server.db.select().from(schema.xpEvents).where(eq(schema.xpEvents.userId, userId));
const sum = (rows: { amount: number }[]) => rows.reduce((n, r) => n + r.amount, 0);

describe('zkušenosti a level', { timeout: 120_000 }, () => {
  it('cash: XP za handy, showdown, cash sezení a první hru dne a týdne; součet sedí se zápisy', async () => {
    const c = await start({ 'xp.cashSessionHands': 3, 'xp.cashSession': 10 });
    const ps = [await c.user(), await c.user()];
    await playCash(c, ps, 8, 5);
    const rows = await events(c, ps[0]!);
    const by = (s: string) => rows.filter((r) => r.source === s);
    const hands = (await c.server.stats.myHands(ps[0]!, { limit: 200 })).length;
    expect(hands).toBeGreaterThanOrEqual(3);
    expect(sum(by('hand'))).toBe(hands); // 1 XP za handu
    expect(sum(by('firstDaily'))).toBe(5);
    expect(sum(by('firstWeekly'))).toBe(15);
    expect(sum(by('cashSession'))).toBe(10);
    const p = await c.server.progress.progressOf(ps[0]!);
    expect(p.xp).toBe(sum(rows));
    expect(p.level).toBeGreaterThanOrEqual(1);
    const brief = await c.server.progress.brief([ps[0]!]);
    expect(brief[0]!.rank.name).toBe('Nováček');
  });

  it('ochrana proti farmení: minimum hráčů a denní strop', async () => {
    const few = await start({ 'xp.minHumanPlayers': 3 });
    const ps = [await few.user(), await few.user()];
    await playCash(few, ps, 4, 5);
    expect((await events(few, ps[0]!)).length).toBe(0);

    const capped = await start({ 'xp.dailyCap': 12 });
    const qs = [await capped.user(), await capped.user()];
    await playCash(capped, qs, 12, 5);
    const fromGame = async () => sum((await events(capped, qs[0]!)).filter((r) => r.source !== 'achievement'));
    expect(await fromGame()).toBeLessThanOrEqual(12);
    expect(await fromGame()).toBeGreaterThan(0);
    // odměna za úspěch strop obchází
    capped.server.progress.grant(qs[0]!, 'test', 100);
    await capped.server.progress.idle();
    expect((await capped.server.progress.progressOf(qs[0]!)).xp).toBeGreaterThanOrEqual(100);
  });

  it('turnaj: účast, umístění, peníze, výhra, vyřazení soupeře a série jen jednou; zápis se neopakuje', async () => {
    const c = await start();
    const [a, b, d] = [await c.user(), await c.user(), await c.user()];
    const results = [
      { userId: a, place: 1, payout: 100 },
      { userId: b, place: 2, payout: 50 },
      { userId: d, place: 3, payout: 0 },
    ];
    c.server.progress.onElimination('t1', { userId: d, remaining: 2, by: [{ userId: b, weight: 1 }] });
    c.server.progress.onElimination('t1', { userId: b, remaining: 1, by: [{ userId: a, weight: 1 }] });
    c.server.progress.onTournamentFinished('t1', results, 'serie-1', c.clock.now());
    c.server.progress.onTournamentFinished('t1', results, 'serie-1', c.clock.now()); // duplicita
    await c.server.progress.idle();
    const ea = await events(c, a);
    // 20 účast + 2×2 umístění + 15 v penězích + 50 výhra + 10 vyřazení + 10 série + 5 + 15 bonusy
    expect(sum(ea)).toBe(20 + 4 + 15 + 50 + 10 + 10 + 5 + 15);
    expect(sum(await events(c, d))).toBe(20 + 0 + 0 + 0 + 0 + 10 + 5 + 15);
    // další turnaj téže série: série XP znovu ne
    c.server.progress.onTournamentFinished('t2', results, 'serie-1', c.clock.now());
    await c.server.progress.idle();
    expect((await events(c, a)).filter((r) => r.source === 'series')).toHaveLength(1);
    // kdo koho vyřadil je zapsané
    const rows = await c.server.db.select().from(schema.tournamentEliminations);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.victimId === d)!.killers).toEqual([{ userId: b, weight: 1 }]);
    expect(rows.find((r) => r.victimId === d)!.place).toBe(3);
  });

  it('vypnuté XP: ve zvonečku nepřibývají upozornění o postupu ani úspěších a stará se skryjí', async () => {
    const c = await start({ 'xp.enabled': false, 'xp.levelBase': 1 });
    const [a, b] = [await c.user(), await c.user()];
    // stará upozornění z doby, kdy byly XP zapnuté
    await c.server.db.insert(schema.notifications).values([
      { userId: a, kind: 'levelUp', params: { level: 3, rank: 'X' }, link: '/postup' },
      { userId: a, kind: 'achievement', params: { name: 'Y', xp: 5 }, link: '/postup' },
      { userId: a, kind: 'tournamentOpen', params: { name: 'T', time: '', minutes: 0 }, link: null },
    ]);
    const login = await c.server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'X0x', password: 'heslo-hrace-123' }, headers: { origin: 'http://localhost' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const list = async () => (await c.server.app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie } })).json() as { items: { kind: string }[]; unread: number };
    const before = await list();
    expect(before.items.map((i) => i.kind)).toEqual(['tournamentOpen']);
    expect(before.unread).toBe(1);
    // hra a výhra turnaje nic nepřipíše ani neohlásí
    c.server.progress.onTournamentFinished('tx', [{ userId: a, place: 1, payout: 10 }, { userId: b, place: 2, payout: 0 }], null, c.clock.now());
    await c.server.progress.idle();
    await new Promise((r) => setTimeout(r, 80));
    c.server.achievements.trigger([a, b], ['tournament', 'hand', 'level']);
    await c.server.achievements.idle();
    const rows = await c.server.db.select().from(schema.notifications).where(eq(schema.notifications.userId, a));
    expect(rows.filter((r) => r.kind === 'levelUp' || r.kind === 'achievement')).toHaveLength(2); // jen ta ručně vložená stará
    expect((await list()).items.map((i) => i.kind)).toEqual(['tournamentOpen']);
  });

  it('postup na vyšší hodnost pošle upozornění a zprávu do hlavního kanálu', async () => {
    const c = await start({ 'xp.levelBase': 20, 'xp.ranks': 'Začátečník|🌱|muted|1;Pokročilý|🍺|info|2' });
    const [a, b] = [await c.user(), await c.user()];
    c.server.progress.onTournamentFinished('t9', [{ userId: a, place: 1, payout: 10 }, { userId: b, place: 2, payout: 0 }], null, c.clock.now());
    await c.server.progress.idle();
    await new Promise((r) => setTimeout(r, 80));
    expect((await c.server.progress.progressOf(a)).rank.name).toBe('Pokročilý');
    const notes = await c.server.db.select().from(schema.notifications).where(eq(schema.notifications.userId, a));
    expect(notes.some((n) => n.kind === 'levelUp')).toBe(true);
    const main = await c.server.chat.ensureMainChannel();
    const hist = await c.server.chat.history(b, main, {});
    expect(hist.some((m) => m.system && m.body.includes('Pokročilý'))).toBe(true);
    // vypnuté XP nic nepřipisuje
    const off = await start({ 'xp.enabled': false });
    const x = await off.user();
    off.server.progress.onTournamentFinished('t', [{ userId: x, place: 1, payout: 1 }, { userId: await off.user(), place: 2, payout: 0 }], null, off.clock.now());
    await off.server.progress.idle();
    expect((await events(off, x)).length).toBe(0);
  });
});
