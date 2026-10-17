import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { RatingError } from './rating.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});
const DAY = 86_400_000;

async function start() {
  const clock = new FakeClock();
  clock.advance(100 * DAY);
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 12), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost' },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `Q${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}
type Ctx = Awaited<ReturnType<typeof start>>;

async function finish(c: Ctx, id: string, ids: string[]) {
  ids
    .slice(1)
    .reverse()
    .forEach((victim, i) => c.server.progress.onElimination(id, { userId: victim, remaining: i + 1, by: [{ userId: ids[0]!, weight: 1, equity: i === 0 ? 0.3 : null }] }));
  const results = ids.map((userId, i) => ({ userId, place: i + 1, payout: i === 0 ? 100 : 0 }));
  c.server.stats.recordTournament(id, { targetMinutes: 180, rated: true }, { finishedAt: c.clock.now(), results, payments: [] });
  c.server.progress.onTournamentFinished(id, results, null, c.clock.now());
  await c.server.progress.idle();
  await c.server.stats.idle();
  await c.server.rating.onTournamentFinished(id, { rated: true, targetMinutes: 180, finishedAt: c.clock.now(), results: results.map(({ userId, place }) => ({ userId, place })), rebuys: {} });
}

const setGlobal = (c: Ctx, key: string, value: number | boolean) => c.server.settings.set(c.admin, 'global', '', key, value);
const ratings = async (c: Ctx, ids: string[]) => Promise.all(ids.map(async (id) => (await c.server.rating.ratingOf(id)).tournament.rating));

describe('zpětný přepočet z historie', { timeout: 120_000 }, () => {
  it('rating: bez změny nastavení dá přepočet totéž; náhled nic nezmění, potvrzení ano', async () => {
    const c = await start();
    const stat = await c.user('statistik');
    const ids = [stat, await c.user(), await c.user(), await c.user()];
    const other = ids[1]!;
    await finish(c, 't1', ids);
    c.clock.advance(2 * DAY);
    await finish(c, 't2', [ids[2]!, ids[0]!, ids[3]!, ids[1]!]);
    const live = await ratings(c, ids);

    expect(() => c.server.rating.recompute(other, true)).toThrow(RatingError);
    const same = await c.server.rating.recompute(stat, true);
    expect(same).toMatchObject({ tournaments: 2, changed: 0 });
    expect(await ratings(c, ids)).toEqual(live);

    await setGlobal(c, 'rating.knockoutWeightPercent', 0);
    const preview = await c.server.rating.recompute(stat, true);
    expect(preview.changed).toBeGreaterThan(0);
    expect(preview.rows[0]).toHaveProperty('before');
    expect(await ratings(c, ids)).toEqual(live); // náhled nic nezměnil
    expect((await c.server.rating.history(ids[0]!, 'tournament')).length).toBe(2);

    const applied = await c.server.rating.recompute(stat, false);
    expect(applied.changed).toBe(preview.changed);
    const now = await ratings(c, ids);
    expect(now).not.toEqual(live);
    expect((await c.server.rating.history(ids[0]!, 'tournament')).length).toBe(2);
    // znovu: už nic nemění
    expect((await c.server.rating.recompute(stat, true)).changed).toBe(0);
  });

  it('XP: přepočet podle nového nastavení, odměny za úspěchy zůstávají', async () => {
    const c = await start();
    const ids = [await c.user(), await c.user(), await c.user()];
    await finish(c, 't1', ids);
    c.server.progress.grant(ids[0]!, 'bonus-test', 40);
    await c.server.progress.idle();
    const winnerBefore = (await c.server.progress.progressOf(ids[0]!)).xp;

    const same = await c.server.progress.recompute(true);
    expect(same.changed).toBe(0);

    await setGlobal(c, 'xp.tournamentWin', 500);
    const preview = await c.server.progress.recompute(true);
    expect(preview.changed).toBe(1);
    expect(preview.rows[0]).toMatchObject({ before: winnerBefore, after: winnerBefore + 450 });
    expect((await c.server.progress.progressOf(ids[0]!)).xp).toBe(winnerBefore);

    await c.server.progress.recompute(false);
    expect((await c.server.progress.progressOf(ids[0]!)).xp).toBe(winnerBefore + 450);
    expect((await c.server.progress.recent(ids[0]!, 50)).some((r) => r.source === 'achievement' && r.amount === 40)).toBe(true);

    // denní strop se projeví i zpětně
    await setGlobal(c, 'xp.dailyCap', 30);
    await c.server.progress.recompute(false);
    const capped = await c.server.progress.recent(ids[0]!, 50);
    const game = capped.filter((r) => r.source !== 'achievement').reduce((n, r) => n + r.amount, 0);
    expect(game).toBeLessThanOrEqual(30);
  });
});
