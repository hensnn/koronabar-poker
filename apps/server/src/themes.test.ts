import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { ThemeError } from './themes.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(settings: Record<string, unknown> = {}) {
  const server = await buildServer({
    clock: new FakeClock(),
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 14), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `M${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, admin: admin!, user, themes: server.themes };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof ThemeError) return e.code;
    throw e;
  }
};
const theme = { light: { 'color.felt': '#224488', 'cards.style': 'bigIndex' }, dark: { 'color.felt': '#112244' } };

describe('vlastní motivy', { timeout: 60_000 }, () => {
  it('vytvoření ověří hodnoty podle schématu, nebezpečné a neznámé vyřadí, vidí ho jen autor', async () => {
    const c = await start();
    const [a, b] = [await c.user(), await c.user()];
    const r = await c.themes.create(a, { name: 'Můj modrý', theme: { light: { ...theme.light, 'color.bg': '#fff; background:url(x)', 'neznamy.token': '1', 'cards.fourColor': 'možná' }, dark: theme.dark } });
    expect(r.dropped.sort()).toEqual(['cards.fourColor', 'color.bg', 'neznamy.token']);
    const mine = await c.themes.list(a);
    expect(mine.themes).toHaveLength(1);
    expect(mine.themes[0]).toMatchObject({ name: 'Můj modrý', status: 'private', mine: true });
    expect(mine.themes[0]!.theme.light).toEqual(theme.light);
    expect(mine.defaultId).toBe('classic-green');
    expect((await c.themes.list(b)).themes).toHaveLength(0);
    expect(await code(c.themes.create(a, { name: '   ' }))).toBe('INVALID');
    const lone = await c.user('novacek');
    for (const x of c.server.perms.assignmentsOf(lone)) if (x.role?.key !== 'novacek') await c.server.perms.revokeAssignment(c.admin, x.id);
    expect(await code(c.themes.create(lone, { name: 'Nesmím' }))).toBe('FORBIDDEN');
  });

  it('limit motivů na hráče; úpravy a mazání jen autor (mazat smí i kurátor)', async () => {
    const c = await start({ 'theme.maxPerUser': 2 });
    const [a, b] = [await c.user(), await c.user()];
    const curator = await c.user('kurator');
    const one = (await c.themes.create(a, { name: 'Jedna', theme }) ).id;
    await c.themes.create(a, { name: 'Dva', theme });
    expect(await code(c.themes.create(a, { name: 'Tři', theme }))).toBe('LIMIT');
    expect(await code(c.themes.update(b, one, { name: 'Cizí' }))).toBe('FORBIDDEN');
    await c.themes.update(a, one, { name: 'Přejmenovaný', theme: { light: { 'color.felt': '#333333' }, dark: {} } });
    expect((await c.themes.list(a)).themes.find((t) => t.id === one)).toMatchObject({ name: 'Přejmenovaný', theme: { light: { 'color.felt': '#333333' } } });
    expect(await code(c.themes.remove(b, one))).toBe('FORBIDDEN');
    await c.themes.remove(curator, one);
    expect((await c.themes.list(a)).themes).toHaveLength(1);
  });

  it('sdílení projde schválením kurátora; po úpravě se sdílený motiv vrací ke schválení; skrytý zmizí', async () => {
    const c = await start();
    const [a, b] = [await c.user(), await c.user()];
    const curator = await c.user('kurator');
    const id = (await c.themes.create(a, { name: 'Sdílený', theme })).id;
    expect(await c.themes.share(a, id, true)).toBe('pending');
    expect((await c.themes.list(b)).themes).toHaveLength(0);
    expect(await code(c.themes.pending(b))).toBe('FORBIDDEN');
    expect((await c.themes.pending(curator)).map((t) => t.id)).toEqual([id]);
    await c.themes.review(curator, id, true);
    const seen = (await c.themes.list(b)).themes;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 'shared', mine: false, ownerNickname: expect.any(String) });
    await c.themes.update(a, id, { theme: { light: { 'color.felt': '#555555' }, dark: {} } });
    expect((await c.themes.list(a)).themes[0]!.status).toBe('pending');
    expect((await c.themes.list(b)).themes).toHaveLength(0);
    await c.themes.review(curator, id, true);
    await c.themes.hide(curator, id, true);
    expect((await c.themes.list(b)).themes).toHaveLength(0);
    expect(await code(c.themes.share(a, id, true))).toBe('BAD_STATE');
    const notes = await c.server.db.select().from((await import('./db/index.js')).schema.notifications);
    expect(notes.some((n) => n.kind === 'themeApproved')).toBe(true);

    // bez schvalování se sdílí hned
    const free = await start({ 'theme.requireApproval': false });
    const x = await free.user();
    const y = await free.user();
    const t = (await free.themes.create(x, { name: 'Hned', theme })).id;
    expect(await free.themes.share(x, t, true)).toBe('shared');
    expect((await free.themes.list(y)).themes).toHaveLength(1);
  });

  it('zamčené prvky: smí je zamknout jen oprávněný a v motivech se nedají přepsat', async () => {
    const c = await start();
    const a = await c.user();
    const curator = await c.user('kurator');
    expect(await code(c.themes.setLocked(a, ['color.suitRed']))).toBe('FORBIDDEN');
    expect(await c.themes.setLocked(curator, ['color.suitRed', 'color.cardFace', 'neexistuje'])).toEqual(['color.suitRed', 'color.cardFace']);
    const r = await c.themes.create(a, { name: 'Zamčený', theme: { light: { 'color.suitRed': '#ffffff', 'color.cardFace': '#000000', 'color.felt': '#224488' }, dark: {} } });
    const stored = (await c.themes.list(a)).themes.find((t) => t.id === r.id)!;
    expect(stored.theme.light).toEqual({ 'color.felt': '#224488' });
    expect((await c.themes.list(a)).locked).toEqual(['color.suitRed', 'color.cardFace']);
  });
});
