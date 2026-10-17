import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '@kb/game-core';
import { buildServer } from '../app.js';
import { schema } from '../db/index.js';
import { ChatError } from './service.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 2)]);
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof ChatError) return e.code;
    throw e;
  }
};

async function start(settings: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const pushed: { endpoint: string; body: { title: string; body: string; url: string } }[] = [];
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 8), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
    pushSender: async (s, body) => void pushed.push({ endpoint: s.endpoint, body: JSON.parse(body) }),
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const nicks = new Map<string, string>();
  const user = async (role?: string) => {
    const nick = `C${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    nicks.set(userId, nick);
    await server.db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, userId));
    return userId;
  };
  const sub = (id: string) => ({ endpoint: `https://push.example.test/${id}`, keys: { p256dh: `p-${id}`, auth: `a-${id}` } });
  return { server, clock, admin: admin!, user, pushed, sub, nick: (id: string) => nicks.get(id)! };
}

describe('chat navíc', { timeout: 60_000 }, () => {
  it('push na soukromé zprávy a zmínky respektuje předvolby a ztlumení kanálu', async () => {
    const c = await start();
    const a = await c.user();
    const b = await c.user();
    await c.server.push.subscribe(b, c.sub('b'));
    const dm = await c.server.chat.openDm(a, b);
    await c.server.chat.send(a, dm, 'ahoj, jdeš hrát?');
    await wait();
    expect(c.pushed).toHaveLength(1);
    expect(c.pushed[0]!.body).toMatchObject({ body: 'ahoj, jdeš hrát?', url: '/chat' });

    // ztlumený kanál: soukromá zpráva nechodí
    await c.server.chat.setNotifyMuted(b, dm, true);
    await c.server.chat.send(a, dm, 'a co teď?');
    await wait();
    expect(c.pushed).toHaveLength(1);
    await c.server.chat.setNotifyMuted(b, dm, false);

    // osobní předvolba vypnuta
    await c.server.settings.set(b, 'user', b, 'push.chatDm', false);
    await c.server.chat.send(a, dm, 'ještě jednou');
    await wait();
    expect(c.pushed).toHaveLength(1);

    // zmínka v hlavním kanálu
    const main = await c.server.chat.ensureMainChannel();
    await c.server.chat.send(a, main, `@${c.nick(b)} pojď k stolu`);
    await wait();
    expect(c.pushed).toHaveLength(2);
    expect(c.pushed[1]!.body.body).toContain('pojď k stolu');
    await c.server.settings.set(b, 'user', b, 'push.chatMentions', false);
    await c.server.chat.send(a, main, `@${c.nick(b)} už jsi tam?`);
    await wait();
    expect(c.pushed).toHaveLength(2);
    // autor sám sebe neupozorňuje
    await c.server.push.subscribe(a, c.sub('a'));
    await c.server.chat.send(a, main, `@${c.nick(a)} poznámka sám sobě`);
    await wait();
    expect(c.pushed).toHaveLength(2);
  });

  it('obrázky: kontrola obsahu, velikosti a formátu, přístup jen ke čtenářům kanálu', async () => {
    const c = await start({ 'chat.imageMaxKb': 16, 'chat.imageFormats': 'png' });
    const a = await c.user();
    const b = await c.user();
    const outsider = await c.user();
    expect(await code(c.server.chatImages.upload(a, Buffer.from('<svg onload=alert(1)></svg>'.padEnd(40, ' '))))).toBe('IMAGE_INVALID');
    expect(await code(c.server.chatImages.upload(a, Buffer.concat([PNG, Buffer.alloc(20 * 1024)])))).toBe('IMAGE_TOO_LARGE');
    expect(await code(c.server.chatImages.upload(a, GIF))).toBe('IMAGE_FORMAT');
    const { id } = await c.server.chatImages.upload(a, PNG);
    // nepřipojený obrázek vidí jen autor
    expect((await c.server.chatImages.read(a, id)).mime).toBe('image/png');
    expect(await code(c.server.chatImages.read(b, id))).toBe('NOT_FOUND');

    const dm = await c.server.chat.openDm(a, b);
    const msg = await c.server.chat.send(a, dm, '', { image: id });
    expect(msg.image).toBe(id);
    expect((await c.server.chatImages.read(b, id)).data.equals(PNG)).toBe(true);
    expect(await code(c.server.chatImages.read(outsider, id))).toBe('NOT_FOUND');
    // obrázek jde připojit jen jednou a jen vlastní
    expect(await code(c.server.chat.send(a, dm, 'znovu', { image: id }))).toBe('IMAGE_INVALID');
    const other = await c.server.chatImages.upload(b, PNG);
    expect(await code(c.server.chat.send(a, dm, 'cizí', { image: other.id }))).toBe('IMAGE_INVALID');
    // bez textu a bez obrázku se nic neodešle
    expect(await code(c.server.chat.send(a, dm, '  '))).toBe('EMPTY');
    // vypnuto správcem
    const off = await start({ 'chat.imagesEnabled': false });
    expect(await code(off.server.chatImages.upload(await off.user(), PNG))).toBe('IMAGE_DISABLED');
  });

  it('automatické zprávy o turnaji v hlavním kanálu a jejich vypnutí', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const player = await c.user();
    const main = await c.server.chat.ensureMainChannel();
    const { id } = await c.server.tournaments.scheduleTournament(org, { name: 'Páteční turnaj', templateId: 'tour-turbo', startAt: c.clock.now() + 3_600_000 });
    await wait();
    const hist = await c.server.chat.history(player, main, {});
    const msg = hist.find((m) => m.system && m.body.includes('Páteční turnaj'));
    expect(msg?.body).toContain(`{{turnaj:${id}}}`);

    const quiet = await start({ 'chat.autoTournamentMessages': false });
    const org2 = await quiet.user('organizator');
    await quiet.server.tournaments.scheduleTournament(org2, { name: 'Tichý turnaj', templateId: 'tour-turbo', startAt: quiet.clock.now() + 3_600_000 });
    await wait();
    const main2 = await quiet.server.chat.ensureMainChannel();
    expect((await quiet.server.chat.history(org2, main2, {})).some((m) => m.body.includes('Tichý turnaj'))).toBe(false);
  });

  it('e-mailový souhrn: jen komu je zapnutý, jen s novými nepřečtenými, ne častěji než je nastaveno', async () => {
    const c = await start();
    const a = await c.user();
    const b = await c.user();
    const nobody = await c.user();
    await c.server.settings.set(b, 'user', b, 'chat.digest', 'daily');
    const dm = await c.server.chat.openDm(a, b);
    const mails = async () => (await c.server.db.select().from(schema.emailQueue)).filter((m) => m.kind === 'chat_souhrn');

    expect(await c.server.digest.run()).toBe(0); // nic nepřečteného
    await c.server.chat.send(a, dm, 'ozvi se');
    await c.server.chat.send(a, dm, 'prosím');
    expect(await c.server.digest.run()).toBe(1);
    const sent = await mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.toAddress).toContain('@example.cz');
    expect(sent[0]!.bodyText).toContain(': 2');
    // do příštího dne se znovu neposílá, ani s novou zprávou
    await c.server.chat.send(a, dm, 'ještě');
    expect(await c.server.digest.run()).toBe(0);
    c.clock.advance(25 * 3_600_000);
    expect(await c.server.digest.run()).toBe(1);
    expect(await mails()).toHaveLength(2);
    // přečtené zprávy souhrn nevyvolají
    await c.server.chat.markRead(b, dm, 999_999);
    c.clock.advance(25 * 3_600_000);
    expect(await c.server.digest.run()).toBe(0);
    // správce může souhrn vypnout pro všechny
    expect(nobody).toBeTruthy();
    const off = await start({ 'chat.digestEnabled': false });
    expect(await off.server.digest.run()).toBe(0);
  });
});
