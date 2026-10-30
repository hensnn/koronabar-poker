import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { schema } from './db/index.js';
import { MessageError } from './messages.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start() {
  const server = await buildServer({
    clock: new FakeClock(),
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 9), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'system.mailRequestsPerHour': 10_000 },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `M${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick.toLowerCase()}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, admin: admin!, user };
}

const base = { title: 'Pozvánka', body: 'Ahoj {prezdivka}, vstup: {odkaz}', channels: ['app' as const] };

describe('zprávy členům', () => {
  it('okruh příjemců: všichni, role, jmenovitě, vyloučení rolí a sebe; zablokovaní nikdy', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const a = await s.user('hrac');
    const b = await s.user('hrac');
    const blocked = await s.user('hrac');
    await s.server.db.update(schema.users).set({ status: 'blocked' }).where(eq(schema.users.id, blocked));
    const m = s.server.messages;
    const ids = async (f: Parameters<typeof m.resolve>[1]) => (await m.resolve(s.admin, f)).map((r) => r.id).sort();

    expect(await ids({ everyone: true })).toEqual([s.admin, org, a, b].sort());
    // každý nově založený účet má základní roli hráče, organizátor k ní má navíc svou
    expect(await ids({ roleKeys: ['hrac'] })).toEqual([org, a, b].sort());
    expect(await ids({ roleKeys: ['organizator'] })).toEqual([org]);
    expect(await ids({ everyone: true, excludeRoleKeys: ['organizator'] })).toEqual([s.admin, a, b].sort());
    expect(await ids({ everyone: true, excludeSelf: true })).not.toContain(s.admin);
    expect(await ids({ userIds: [a, blocked] })).toEqual([a]);
    expect(await ids({ roleKeys: ['organizator'], userIds: [a] })).toEqual([org, a].sort());
    expect(await ids({ roleKeys: ['hrac'], excludeRoleKeys: ['organizator'] })).toEqual([a, b].sort());
    expect(await ids({})).toEqual([]);
  });

  it('okruh podle turnaje: jen přihlášení hráči', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const p1 = await s.user();
    const p2 = await s.user();
    await s.user();
    const { id } = await s.server.tournaments.create(org, { name: 'Debug turnaj', templateId: 'tour-turbo' });
    await s.server.tournaments.register(p1, id);
    await s.server.tournaments.register(p2, id);
    const to = await s.server.messages.resolve(s.admin, { tournamentId: id });
    expect(to.map((r) => r.id).sort()).toEqual([p1, p2].sort());
  });

  it('odeslání: zvonek, e-mail jen s ověřenou adresou a zapnutou volbou, historie a audit; hráč bez oprávnění nesmí', async () => {
    const s = await start();
    const a = await s.user('hrac');
    const b = await s.user('hrac');
    const c = await s.user('hrac');
    // c nemá ověřený e-mail, b si e-maily od správy vypnul
    await s.server.db.update(schema.users).set({ emailVerifiedAt: null }).where(eq(schema.users.id, c));
    await s.server.db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, a));
    await s.server.db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, b));
    await s.server.settings.set(b, 'user', b, 'email.notifyMessages', false);

    await expect(s.server.messages.send(a, { ...base, audience: { userIds: [a] } })).rejects.toBeInstanceOf(MessageError);
    await expect(s.server.messages.send(s.admin, { ...base, audience: {} })).rejects.toMatchObject({ code: 'EMPTY' });
    await expect(s.server.messages.send(s.admin, { ...base, title: '', audience: { userIds: [a] } })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(s.server.messages.send(s.admin, { ...base, link: 'javascript:alert(1)', audience: { userIds: [a] } })).rejects.toMatchObject({ code: 'INVALID' });

    const preview = await s.server.messages.preview(s.admin, { ...base, link: '/turnaj/x', channels: ['app', 'email'], audience: { userIds: [a, b, c] } });
    expect(preview).toMatchObject({ count: 3, emailable: 2, noEmail: 1 });
    expect(preview.sample?.body).toContain('http://localhost/turnaj/x');

    const r = await s.server.messages.send(s.admin, { ...base, link: '/turnaj/x', channels: ['app', 'email'], audience: { userIds: [a, b, c] } });
    expect(r.recipients).toBe(3);
    expect(r.result).toMatchObject({ app: 3, emailQueued: 1, emailSkipped: 1, emailNoAddress: 1 });

    const bell = await s.server.notifications.list(a);
    const item = bell.items.find((x) => x.kind === 'adminMessage');
    expect(item?.text).toContain('Pozvánka');
    expect(item?.text).toContain('Ahoj M0x'.slice(0, 5));
    expect(item?.link).toBe('/turnaj/x');
    const mails = await s.server.db.select().from(schema.emailQueue).where(eq(schema.emailQueue.kind, 'zprava_clenum'));
    expect(mails).toHaveLength(2);
    expect(mails.filter((x) => x.status === 'skipped')).toHaveLength(1);

    const hist = await s.server.messages.history(s.admin);
    expect(hist[0]).toMatchObject({ title: 'Pozvánka', recipients: 3 });
    expect((await s.server.audit.list({ action: 'zpravy.odeslano' }))).toHaveLength(1);
    await expect(s.server.messages.history(a)).rejects.toBeInstanceOf(MessageError);
  });
});
