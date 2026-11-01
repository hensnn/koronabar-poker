import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { eq } from 'drizzle-orm';
import { bestFive } from '@kb/game-core';
import { buildServer } from './app.js';
import { PassthroughProcessor } from './audio.js';
import { schema } from './db/index.js';
import { HandError } from './shared-hands.js';

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
    masterKey: { key: Buffer.alloc(32, 23), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
    audioProcessor: new PassthroughProcessor(1500),
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `H${n++}x`;
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
    if (e instanceof HandError) return e.code;
    throw e;
  }
};

type Ctx = Awaited<ReturnType<typeof start>>;

/** Uloží handu, ve které a vyhrál nad b; a má karty skryté, b je ukázal při showdownu. */
async function insertHand(c: Ctx, id: string, a: string, b: string, extra: { pot?: number; equityB?: number | null; tournamentId?: string | null } = {}) {
  const now = new Date(c.clock.now());
  await c.server.db.insert(schema.hands).values({ id, tableId: 'tx', kind: 'cash', tournamentId: extra.tournamentId ?? null, handNumber: 1, playedAt: now, pot: extra.pot ?? 400, blinds: { sb: 5, bb: 10, ante: 0 }, chipsPerUnit: 1, board: ['As', 'Kd', '7c', '2h', '9s'], showdown: true });
  await c.server.db.insert(schema.handPlayers).values([
    { handId: id, userId: a, seat: 0, kind: 'cash', playedAt: now, startStack: 1000, invested: 200, won: 400, hole: ['Ah', 'Ad'], revealed: false },
    { handId: id, userId: b, seat: 1, kind: 'cash', playedAt: now, startStack: 1000, invested: 200, won: 0, hole: ['Qh', 'Qd'], revealed: true, allInEquity: extra.equityB ?? null },
  ]);
}

describe('sdílené handy', { timeout: 90_000 }, () => {
  it('sdílení pošle kartu do chatu, cizí karty zůstanou skryté dokud je autor sám neodkryje', async () => {
    const c = await start();
    const [a, b, outsider] = [await c.user(), await c.user(), await c.user()];
    await insertHand(c, 'sh-1', a, b);
    expect(await code(c.server.sharedHands.share(outsider, 'sh-1'))).toBe('FORBIDDEN');
    expect(await code(c.server.sharedHands.share(a, 'nope'))).toBe('NOT_FOUND');
    const { id } = await c.server.sharedHands.share(a, 'sh-1');
    // sdílení tou samou handou podruhé nevytvoří novou kartu
    expect((await c.server.sharedHands.share(a, 'sh-1')).id).toBe(id);

    const seenBy = async (u: string) => (await c.server.sharedHands.view(u, id)).hand.players.map((p) => [p.userId === a ? 'a' : 'b', p.hole]);
    // b ukázal karty při showdownu, a ne
    expect(await seenBy(outsider)).toEqual([['a', null], ['b', ['Qh', 'Qd']]]);
    expect(await seenBy(a)).toEqual([['a', ['Ah', 'Ad']], ['b', ['Qh', 'Qd']]]);

    // dobrovolné odkrytí smí jen autor sdílení a jen vlastní karty
    expect(await code(c.server.sharedHands.setReveal(b, id, true))).toBe('FORBIDDEN');
    await c.server.sharedHands.setReveal(a, id, true);
    expect(await seenBy(outsider)).toEqual([['a', ['Ah', 'Ad']], ['b', ['Qh', 'Qd']]]);
    await c.server.sharedHands.setReveal(a, id, false);
    expect((await seenBy(outsider))[0]).toEqual(['a', null]);

    // zpráva v chatu obsahuje token karty
    const msgs = await c.server.db.select().from(schema.chatMessages);
    expect(msgs.some((m) => m.body === `{{ruka:${id}}}`)).toBe(true);
  });

  it('komentáře (limit, mazání), reakce a vypnutí sdílení', async () => {
    const c = await start({ 'hands.commentMax': 2 });
    const [a, b] = [await c.user(), await c.user()];
    await insertHand(c, 'sh-2', a, b);
    const { id } = await c.server.sharedHands.share(a, 'sh-2');
    const first = await c.server.sharedHands.comment(b, id, '  Hezky zahráno  ');
    await c.server.sharedHands.comment(a, id, 'Díky');
    expect(await code(c.server.sharedHands.comment(b, id, 'další'))).toBe('LIMIT');
    expect(await code(c.server.sharedHands.comment(b, id, '   '))).toBe('INVALID');
    expect(await code(c.server.sharedHands.deleteComment(a, first.id))).toBe('FORBIDDEN');
    await c.server.sharedHands.deleteComment(b, first.id);
    expect((await c.server.sharedHands.view(a, id)).comments.map((x) => x.body)).toEqual(['Díky']);

    await c.server.sharedHands.react(b, id, '🔥');
    await c.server.sharedHands.react(a, id, '🔥');
    expect(await code(c.server.sharedHands.react(a, id, '💩'))).toBe('INVALID');
    let v = await c.server.sharedHands.view(b, id);
    expect(v.reactions.counts['🔥']).toBe(2);
    expect(v.reactions.mine).toEqual(['🔥']);
    await c.server.sharedHands.react(b, id, '🔥'); // druhé kliknutí reakci odebere
    v = await c.server.sharedHands.view(b, id);
    expect(v.reactions.counts['🔥']).toBe(1);

    await c.server.settings.set(c.admin, 'global', '', 'hands.shareEnabled', false);
    expect(await code(c.server.sharedHands.view(a, id))).toBe('DISABLED');
  });
});

describe('handa večera a smolař graficky', { timeout: 90_000 }, () => {
  it('smolař má handu, které čelil a která ho porazila; handa večera je nejlepší kombinace z ukázaných karet; hlasování už neexistuje', async () => {
    const c = await start({ 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9, 'tournament.payoutPreset': 'wta' });
    const org = await c.user('organizator');
    const [a, b, d] = [await c.user(), await c.user(), await c.user()];
    const { id: tId } = await c.server.tournaments.create(org, { name: 'Páteční', templateId: 'tour-turbo', settings: { 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9, 'tournament.payoutPreset': 'wta' } });
    for (const p of [a, b, d]) await c.server.tournaments.liveRegister(org, tId, p);
    await c.server.tournaments.start(org, tId);
    await c.server.tournaments.liveEliminate(org, tId, d, [a]);
    await c.server.tournaments.liveEliminate(org, tId, b, [a]);
    const eveningId = (await c.server.evenings.list(org)).evenings[0]!.id;
    const now = new Date(c.clock.now());
    const score = (hole: [string, string], board: string[]) => bestFive(hole as never, board as never).score;
    // ev-1: a má barvu (nejlepší kombinace večera), b dvě dámy
    const board1 = ['2h', '7h', '9h', 'Jd', '3s'];
    await c.server.db.insert(schema.hands).values({ id: 'ev-1', tableId: 'tx', kind: 'tournament', tournamentId: tId, handNumber: 1, playedAt: now, pot: 600, board: board1, blinds: { sb: 5, bb: 10, ante: 0 }, chipsPerUnit: 1, showdown: true });
    await c.server.db.insert(schema.handPlayers).values([
      { handId: 'ev-1', userId: a, seat: 0, kind: 'tournament', playedAt: now, startStack: 1000, invested: 300, won: 600, hole: ['Ah', 'Kh'], revealed: true, showdown: true, handScore: score(['Ah', 'Kh'], board1) },
      { handId: 'ev-1', userId: b, seat: 1, kind: 'tournament', playedAt: now, startStack: 1000, invested: 300, won: 0, hole: ['Qs', 'Qd'], revealed: true, showdown: true, handScore: score(['Qs', 'Qd'], board1) },
    ]);
    // ev-2: d prohrál s esy (90 %) proti sedmičkám, které dorovnaly trojici
    const board2 = ['2h', '7d', '9c', 'Kd', '7s'];
    await c.server.db.insert(schema.hands).values({ id: 'ev-2', tableId: 'tx', kind: 'tournament', tournamentId: tId, handNumber: 2, playedAt: now, pot: 300, board: board2, blinds: { sb: 5, bb: 10, ante: 0 }, chipsPerUnit: 1, showdown: true });
    await c.server.db.insert(schema.handPlayers).values([
      { handId: 'ev-2', userId: a, seat: 0, kind: 'tournament', playedAt: now, startStack: 1000, invested: 150, won: 300, hole: ['7c', '5s'], revealed: true, showdown: true, handScore: score(['7c', '5s'], board2) },
      { handId: 'ev-2', userId: d, seat: 1, kind: 'tournament', playedAt: now, startStack: 1000, invested: 150, won: 0, hole: ['Ah', 'Ad'], revealed: true, showdown: true, allInEquity: 0.9, handScore: score(['Ah', 'Ad'], board2) },
    ]);
    const sum = (await c.server.evenings.view(eveningId, org)).summary;

    // smolař: on a vítěz s kartami a společnými kartami
    const bad = sum.awards.badBeat!;
    expect(bad).toMatchObject({ userId: d, equity: 90 });
    expect(bad.hand!.board).toEqual(board2);
    const loser = bad.hand!.players.find((p) => p.role === 'loser')!;
    const winner = bad.hand!.players.find((p) => p.role === 'winner')!;
    expect(loser).toMatchObject({ userId: d, hole: ['Ah', 'Ad'] });
    expect(winner).toMatchObject({ userId: a, hole: ['7c', '5s'] });
    expect(winner.five).toHaveLength(5);
    expect(winner.desc?.key).toBeTruthy();

    // handa večera: nejlepší kombinace (barva hráče a), s pěticí a názvem
    const best = sum.bestHand!;
    expect(best).toMatchObject({ handId: 'ev-1', userId: a });
    const mine = best.players.find((p) => p.role === 'best')!;
    expect(mine.hole).toEqual(['Ah', 'Kh']);
    expect(mine.five).toHaveLength(5);
    expect(mine.five!.every((card) => card[1] === 'h')).toBe(true); // barva
    // hlasování o handě večera už neexistuje
    expect((c.server.evenings as unknown as Record<string, unknown>).startHandVote).toBeUndefined();
  });
});

describe('znělky', { timeout: 60_000 }, () => {
  it('zazní jen zvolená a viditelná znělka, s odstupem mezi spuštěními; vypnutí je zcela umlčí', async () => {
    const c = await start({ 'sounds.jingleCooldownSeconds': 30 });
    const u = await c.user();
    const sounds = await c.server.sounds.list(u);
    const ding = sounds.find((s) => s.shortcut === 'ding')!;
    const target = { kind: 'table' as const, id: 'T' };
    expect(await c.server.sounds.jingle(u, 'join', target)).toBe(false); // nic nezvoleno
    await c.server.settings.set(u, 'user', u, 'sounds.joinJingle', ding.id);
    expect(await c.server.sounds.jingle(u, 'join', target)).toBe(true);
    expect(await c.server.sounds.jingle(u, 'join', target)).toBe(false); // odstup
    expect(await c.server.sounds.jingle(u, 'win', target)).toBe(false); // vítězná není zvolená
    c.clock.advance(31_000);
    expect(await c.server.sounds.jingle(u, 'join', target)).toBe(true);
    await c.server.settings.set(u, 'user', u, 'sounds.joinJingle', 'neexistuje');
    c.clock.advance(31_000);
    expect(await c.server.sounds.jingle(u, 'join', target)).toBe(false); // chybějící zvuk se tiše vynechá
    await c.server.settings.set(u, 'user', u, 'sounds.joinJingle', ding.id);
    await c.server.settings.set(c.admin, 'global', '', 'sounds.jingleEnabled', false);
    c.clock.advance(31_000);
    expect(await c.server.sounds.jingle(u, 'join', target)).toBe(false);
  });
});
