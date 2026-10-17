import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { eq } from 'drizzle-orm';
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

describe('handa večera', { timeout: 90_000 }, () => {
  it('kandidáty vybere server, hráči večera hlasují v anketě a vítězná handa se sdílí do chatu', async () => {
    const c = await start({ 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9, 'tournament.payoutPreset': 'wta', 'evening.handVoteAuto': false });
    const org = await c.user('organizator');
    const [a, b, d] = [await c.user(), await c.user(), await c.user()];
    const { id: tId } = await c.server.tournaments.create(org, { name: 'Páteční', templateId: 'tour-turbo', settings: { 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9, 'tournament.payoutPreset': 'wta' } });
    for (const p of [a, b, d]) await c.server.tournaments.liveRegister(org, tId, p);
    await c.server.tournaments.start(org, tId);
    await c.server.tournaments.liveEliminate(org, tId, d, [a]);
    await c.server.tournaments.liveEliminate(org, tId, b, [a]);

    const list = await c.server.evenings.list(org);
    const eveningId = list.evenings[0]!.id;
    // jen jedna handa = jediný kandidát, hlasovat nemá smysl
    await insertHand(c, 'ev-1', a, b, { pot: 6000, tournamentId: tId });
    expect(await c.server.evenings.startHandVote(org, eveningId)).toBe(false);

    // druhá handa s bad beatem (d prohrál se šancí 90 %)
    const now = new Date(c.clock.now());
    await c.server.db.insert(schema.hands).values({ id: 'ev-2', tableId: 'tx', kind: 'tournament', tournamentId: tId, handNumber: 2, playedAt: now, pot: 300, blinds: { sb: 5, bb: 10, ante: 0 }, chipsPerUnit: 1, showdown: true });
    await c.server.db.insert(schema.handPlayers).values([
      { handId: 'ev-2', userId: a, seat: 0, kind: 'tournament', playedAt: now, startStack: 1000, invested: 150, won: 300 },
      { handId: 'ev-2', userId: d, seat: 1, kind: 'tournament', playedAt: now, startStack: 1000, invested: 150, won: 0, allInEquity: 0.9 },
    ]);
    expect(await c.server.evenings.startHandVote(org, eveningId)).toBe(true);
    expect(await c.server.evenings.startHandVote(org, eveningId)).toBe(false); // jen jednou
    const view = await c.server.evenings.view(eveningId, org);
    expect(view.handVote?.candidates.map((x) => x.kind)).toEqual(['bigPot', 'badBeat']);
    expect(view.handVote?.decided).toBe(false);

    // dokud anketa běží, nic se nevyhodnotí
    expect(await c.server.evenings.finalizeHandVotes()).toBe(0);
    await c.server.polls.vote(a, view.handVote!.pollId, { type: 'single', option: 'o2' });
    await c.server.polls.vote(b, view.handVote!.pollId, { type: 'single', option: 'o2' });
    const [poll] = await c.server.db.select().from(schema.polls).where(eq(schema.polls.id, view.handVote!.pollId));
    if (poll!.status === 'open') await c.server.polls.close(c.admin, view.handVote!.pollId);
    expect(await c.server.evenings.finalizeHandVotes()).toBe(1);

    const after = await c.server.evenings.view(eveningId, org);
    expect(after.handVote?.decided).toBe(true);
    expect(after.summary.handOfEvening).toMatchObject({ kind: 'badBeat', handId: 'ev-2' });
    expect(after.summary.handOfEvening?.sharedId).toBeTruthy();
    const msgs = await c.server.db.select().from(schema.chatMessages);
    expect(msgs.some((m) => m.body.includes(`{{ruka:${after.summary.handOfEvening!.sharedId}}}`))).toBe(true);
    expect(await c.server.evenings.finalizeHandVotes()).toBe(0); // už vyhodnoceno
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
