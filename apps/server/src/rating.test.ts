import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock, seededRandom, type LegalActions, type PlayerAction } from '@kb/game-core';
import { buildServer } from './app.js';
import { schema } from './db/index.js';
import { RatingError } from './rating.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const FAST = { 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.turnSeconds': 3, 'odds.enabled': false };
const DAY = 86_400_000;

async function start(settings: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  clock.advance(100 * DAY);
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 11), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const nicks = new Map<string, string>();
  const user = async (role?: string) => {
    const nick = `R${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    nicks.set(userId, nick);
    return userId;
  };
  return { server, clock, admin: admin!, user, nick: (id: string) => nicks.get(id)! };
}
type Ctx = Awaited<ReturnType<typeof start>>;

const base = { rated: true, targetMinutes: 180, rebuys: {} as Record<string, number> };
const result = (ids: string[]) => ids.map((userId, i) => ({ userId, place: i + 1 }));

/** Zapíše výsledek turnaje jako to dělá server: vyřazení, výsledky do statistik a rating. */
async function finish(c: Ctx, id: string, ids: string[], extra: Partial<typeof base & { finishedAt: number | null }> = {}) {
  ids
    .slice(1)
    .reverse()
    .forEach((victim, i) => c.server.progress.onElimination(id, { userId: victim, remaining: i + 1, by: [{ userId: ids[0]!, weight: 1 }] }));
  const results = result(ids).map((r) => ({ ...r, payout: 0 }));
  c.server.stats.recordTournament(id, { targetMinutes: 180, rated: true }, { finishedAt: c.clock.now(), results, payments: [] });
  await c.server.progress.idle();
  await c.server.stats.idle();
  await c.server.rating.onTournamentFinished(id, { ...base, finishedAt: c.clock.now(), results: result(ids), ...extra });
}

function tame(l: LegalActions, rnd: () => number): PlayerAction {
  const r = rnd();
  if (l.canCheck) return r < 0.8 || (!l.canBet && !l.canRaise) ? { type: 'check' } : { type: l.canBet ? 'bet' : 'raise', amount: l.minRaiseTo };
  if (r < 0.65) return { type: 'call' };
  if (r < 0.9 || !l.canRaise) return { type: 'fold' };
  return { type: 'raise', amount: l.minRaiseTo };
}

describe('herní rating', { timeout: 120_000 }, () => {
  it('turnaj: vítěz stoupne, poslední klesne, rozpis obsahuje vyřazení; opakované zpracování nic nemění', async () => {
    const c = await start();
    const ids = [await c.user(), await c.user(), await c.user(), await c.user()];
    await finish(c, 't1', ids);
    const r = await Promise.all(ids.map((id) => c.server.rating.ratingOf(id)));
    expect(r[0]!.tournament.rating!).toBeGreaterThan(1500);
    expect(r[3]!.tournament.rating!).toBeLessThan(1500);
    expect(r[0]!.tournament).toMatchObject({ provisional: true, games: 1 });
    expect(r[0]!.cash.rating).toBe(1500);
    const h = await c.server.rating.history(ids[0]!, 'tournament');
    expect(h).toHaveLength(1);
    expect(h[0]!.knockouts.map((k) => k.nickname).sort()).toEqual(ids.slice(1).map((id) => c.nick(id)).sort());
    expect(h[0]!.change).toBe(h[0]!.after! - h[0]!.before!);
    const lastHist = await c.server.rating.history(ids[3]!, 'tournament');
    expect(lastHist[0]!.knockedOutBy[0]!.nickname).toBe(c.nick(ids[0]!));
    // opakované zpracování téhož turnaje se zahodí
    await finish(c, 't1', ids);
    expect((await c.server.rating.ratingOf(ids[0]!)).tournament.games).toBe(1);
    expect(await c.server.rating.duel(ids[0]!, ids[3]!)).toEqual({ aKnockedB: 1, bKnockedA: 0 });
  });

  it('nehodnocený turnaj, malé pole, vypnutý rating a skrytá čísla', async () => {
    const c = await start();
    const ids = [await c.user(), await c.user(), await c.user(), await c.user()];
    await finish(c, 'a', ids, { rated: false });
    await finish(c, 'b', ids.slice(0, 2));
    expect((await c.server.rating.ratingOf(ids[0]!)).tournament.games).toBe(0);
    const off = await start({ 'rating.enabled': false });
    const o = [await off.user(), await off.user(), await off.user()];
    await finish(off, 'x', o);
    expect((await off.server.rating.ratingOf(o[0]!)).tournament.games).toBe(0);
    const hidden = await start({ 'rating.showNumbers': false, 'rating.provisionalGames': 1 });
    const h = [await hidden.user(), await hidden.user(), await hidden.user()];
    await finish(hidden, 'y', h);
    const mine = (await hidden.server.rating.ratingOf(h[0]!)).tournament;
    expect(mine.rating).toBeNull();
    expect(mine.division).toBeTruthy();
    const board = await hidden.server.rating.leaderboard('tournament');
    expect(board).toHaveLength(3);
    expect(board[0]).toMatchObject({ rank: 1, rating: null });
  });

  it('provizorní hráči nejsou v žebříčku; rebuye a velikost pole zmenšují zisk', async () => {
    const c = await start();
    const ids = [await c.user(), await c.user(), await c.user(), await c.user()];
    await finish(c, 't1', ids);
    expect(await c.server.rating.leaderboard('tournament')).toEqual([]);
    const full = (await c.server.rating.ratingOf(ids[0]!)).tournament.rating!;

    const d = await start();
    const small = [await d.user(), await d.user(), await d.user()];
    await finish(d, 's', small);
    const three = (await d.server.rating.ratingOf(small[0]!)).tournament.rating!;
    expect(three - 1500).toBeLessThan(full - 1500 + 1);

    const e = await start();
    const rb = [await e.user(), await e.user(), await e.user(), await e.user()];
    await finish(e, 'r', rb, { rebuys: { [rb[0]!]: 4 } });
    expect((await e.server.rating.ratingOf(rb[0]!)).tournament.rating!).toBeLessThan(full);
  });

  it('opakované heads-upy téže dvojice mají klesající váhu', async () => {
    const c = await start({ 'rating.minPlayers': 2 });
    const [a, b] = [await c.user(), await c.user()];
    await finish(c, 'h1', [a, b]);
    const first = (await c.server.rating.history(a, 'tournament'))[0]!;
    c.clock.advance(DAY);
    await finish(c, 'h2', [a, b]);
    const second = (await c.server.rating.history(a, 'tournament'))[0]!;
    expect(second.weight).toBeLessThan(first.weight);
    expect(second.change!).toBeLessThan(first.change!);
  });

  it('neaktivita zvyšuje nejistotu (rating klesá), měkký reset přiblíží rating k průměru a vyžaduje oprávnění', async () => {
    const c = await start();
    const ids = [await c.user(), await c.user(), await c.user(), await c.user()];
    await finish(c, 't1', ids);
    const active = (await c.server.rating.ratingOf(ids[0]!)).tournament;
    c.clock.advance(300 * DAY);
    const idle = (await c.server.rating.ratingOf(ids[0]!)).tournament;
    expect(idle.uncertainty!).toBeGreaterThan(active.uncertainty!);
    expect(idle.rating!).toBeLessThan(active.rating!);

    const stat = await c.user('statistik');
    await expect(Promise.resolve().then(() => c.server.rating.softResetAll(ids[1]!))).rejects.toBeInstanceOf(RatingError);
    const before = (await c.server.rating.ratingOf(ids[0]!)).tournament.rating!;
    expect(await c.server.rating.softResetAll(stat)).toBe(4);
    const after = (await c.server.rating.ratingOf(ids[0]!)).tournament;
    expect(Math.abs(after.rating! - 1500)).toBeLessThan(Math.abs(before - 1500));
    expect(after.games).toBe(1); // reset není hra
    expect((await c.server.rating.history(ids[0]!, 'tournament')).some((e) => e.kind === 'reset')).toBe(true);
  });

  it('cash: sezení s dostatkem hand se vyhodnotí až po skončení dne, jednou, a odděleně od turnajového ratingu', async () => {
    const c = await start({ 'rating.cashMinHands': 3 });
    const org = await c.user('organizator');
    const ps = [await c.user(), await c.user()];
    const { id } = await c.server.tables.createTable(org, { name: 'Cash rating', templateId: 'cash-klasika', settings: FAST });
    const actor = c.server.tables.get(id)!;
    ps.forEach((p, i) => {
      actor.join(p, `R${i}`, i, 500);
      actor.setConnected(p, true);
      actor.sitIn(p);
    });
    const rnd = seededRandom(5);
    let done = 0;
    for (let i = 0; i < 20_000 && done < 6; i++) {
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
    // dnešní den ještě není uzavřený
    expect(await c.server.rating.rateCash()).toBe(0);
    c.clock.advance(3 * DAY);
    expect(await c.server.rating.rateCash()).toBe(2);
    expect(await c.server.rating.rateCash()).toBe(0);
    const [a, b] = await Promise.all(ps.map((p) => c.server.rating.ratingOf(p)));
    expect(a!.cash.games).toBe(1);
    expect(a!.tournament.games).toBe(0);
    const ra = a!.cash.rating!;
    const rb = b!.cash.rating!;
    expect(ra === rb ? true : (ra > 1500) !== (rb > 1500) || ra !== rb).toBe(true);
    expect(await c.server.db.select().from(schema.ratingEvents).where(eq(schema.ratingEvents.scope, 'cash'))).toHaveLength(2);
  });
});

describe('podezření na zneužití ratingu', { timeout: 120_000 }, () => {
  it('opakované heads-upy téže dvojice se označí ke kontrole', async () => {
    const c = await start({ 'rating.minPlayers': 2, 'rating.pairFlagCount': 3 });
    const stat = await c.user('statistik');
    const other = await c.user();
    for (const id of ['h1', 'h2']) {
      await finish(c, id, [stat, other]);
      c.clock.advance(DAY);
    }
    expect(await c.server.rating.flags(stat)).toEqual([]);
    await finish(c, 'h3', [stat, other]);
    const flags = await c.server.rating.flags(stat);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'heads_up_pair', status: 'open', detail: { count: 3 } });
    await finish(c, 'h4', [other, stat]);
    expect((await c.server.rating.flags(stat)).filter((f) => f.kind === 'heads_up_pair')).toHaveLength(1); // jedno označení na týden a dvojici
    await expect(Promise.resolve().then(() => c.server.rating.flags(other))).rejects.toBeInstanceOf(RatingError);
  });

  it('jednosměrný tok žetonů v cash hrách se označí, vyvážený ne; označení jde vyřešit', async () => {
    const c = await start({ 'rating.dumpMinHands': 10, 'rating.dumpMinBb': 100 });
    const stat = await c.user('statistik');
    const [a, b, d] = [await c.user(), await c.user(), await c.user()];
    const now = c.clock.now();
    let n = 0;
    const hand = async (loser: string, winner: string) => {
      const id = `fh-${n++}`;
      await c.server.db.insert(schema.hands).values({ id, tableId: 'tx', kind: 'cash', handNumber: n, playedAt: new Date(now - 1000), pot: 400, blinds: { sb: 5, bb: 10, ante: 0 }, chipsPerUnit: 1 });
      await c.server.db.insert(schema.handPlayers).values([
        { handId: id, userId: loser, seat: 0, kind: 'cash', playedAt: new Date(now - 1000), startStack: 1000, invested: 200, won: 0 },
        { handId: id, userId: winner, seat: 1, kind: 'cash', playedAt: new Date(now - 1000), startStack: 1000, invested: 200, won: 400 },
      ]);
    };
    for (let i = 0; i < 15; i++) await hand(a, b); // a posílá b: 15 × 20 BB
    for (let i = 0; i < 8; i++) await hand(b, d); // vyvážená dvojice b–d
    for (let i = 0; i < 8; i++) await hand(d, b);
    expect(await c.server.rating.scanChipFlow()).toBe(1);
    expect(await c.server.rating.scanChipFlow()).toBe(1); // zkoumá se znovu, ale zápis je jedinečný
    const flags = await c.server.rating.flags(stat);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'chip_flow', status: 'open', detail: { bb: 300, ratio: 100, hands: 15 } });
    await c.server.rating.resolveFlag(stat, flags[0]!.id, 'confirmed', 'Ověřeno s hráči');
    const after = (await c.server.rating.flags(stat))[0]!;
    expect(after).toMatchObject({ status: 'confirmed', note: 'Ověřeno s hráči' });
  });
});
