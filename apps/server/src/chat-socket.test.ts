import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { buildServer } from './app.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
type TestSocket = Socket & { got: { ev: string; data: any }[] };
const open: { servers: Server[]; sockets: Socket[] } = { servers: [], sockets: [] };

async function start() {
  const server = await buildServer({
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 5), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost' },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    tableSettings: { 'time.betweenHandsMs': 50 },
  });
  const port = await server.listen(0);
  open.servers.push(server);
  return { server, url: `http://localhost:${port}` };
}

async function player(server: Server, nick: string, role?: string) {
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick.toLowerCase()}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
  if (role) {
    for (const a of server.perms.assignmentsOf(userId)) await server.perms.revokeAssignment(admin!, a.id);
    await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
  }
  const { token } = await server.accounts.login(nick, 'heslo-hrace-123');
  return { userId, cookie: `kb_session=${token}` };
}

function client(url: string, cookie: string): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const s = connect(url, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie } }) as TestSocket;
    s.got = [];
    s.onAny((ev, data) => s.got.push({ ev, data }));
    open.sockets.push(s);
    s.on('hello', () => setTimeout(() => resolve(s), 150));
    s.on('connect_error', reject);
  });
}
const call = (s: Socket, ev: string, data?: unknown) => new Promise<{ ok: boolean; code?: string; data?: any }>((r) => s.emit(ev, data, r));
const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const events = (s: TestSocket, ev: string) => s.got.filter((g) => g.ev === ev).map((g) => g.data);

afterEach(async () => {
  for (const s of open.sockets) s.close();
  open.sockets = [];
  for (const s of open.servers.splice(0)) await s.close().catch(() => undefined);
});

describe('chat přes Socket.IO', () => {
  it('zpráva v hlavním kanálu dorazí všem ostatním hned, i s odpovědí a reakcí', async () => {
    const { server, url } = await start();
    const [a, b] = [await player(server, 'Alice'), await player(server, 'Bob')];
    const [sa, sb] = [await client(url, a.cookie), await client(url, b.cookie)];
    const channels = (await call(sa, 'chat:channels')).data as { id: string; name: string }[];
    expect(channels.map((c) => c.name)).toContain('Hospoda');
    const main = channels.find((c) => c.name === 'Hospoda')!.id;
    const sent = await call(sa, 'chat:send', { channelId: main, body: 'Ahoj všem @Bob' });
    expect(sent.ok).toBe(true);
    await until(() => events(sb, 'chat:message').length === 1);
    expect(events(sb, 'chat:message')[0]).toMatchObject({ body: 'Ahoj všem @Bob', nickname: 'Alice' });
    await until(() => events(sb, 'chat:mention').length === 1);
    expect(events(sb, 'chat:mention')[0]).toMatchObject({ from: 'Alice' });
    const reply = await call(sb, 'chat:send', { channelId: main, body: 'ahoj', replyTo: sent.data.id });
    expect(reply.data.replyTo).toBe(sent.data.id);
    await call(sb, 'chat:react', { messageId: sent.data.id, emoji: '👍' });
    await until(() => events(sa, 'chat:reaction').length === 1);
    expect(events(sa, 'chat:reaction')[0].reactions).toEqual({ '👍': [b.userId] });
    const hist = await call(sa, 'chat:history', { channelId: main });
    expect(hist.data.map((m: { body: string }) => m.body)).toEqual(['Ahoj všem @Bob', 'ahoj']);
  });

  it('soukromá zpráva: druhý účastník ji dostane bez znovupřipojení, třetí nic nevidí', async () => {
    const { server, url } = await start();
    const [a, b, c] = [await player(server, 'Alice'), await player(server, 'Bob'), await player(server, 'Carol')];
    const [sa, sb, sc] = [await client(url, a.cookie), await client(url, b.cookie), await client(url, c.cookie)];
    const dm = (await call(sa, 'chat:dm', { userId: b.userId })).data.channelId as string;
    await call(sa, 'chat:send', { channelId: dm, body: 'jen mezi námi' });
    await until(() => events(sb, 'chat:message').some((m) => m.body === 'jen mezi námi'));
    expect(events(sc, 'chat:message')).toHaveLength(0);
    expect((await call(sc, 'chat:history', { channelId: dm })).code).toBe('CHAT_FORBIDDEN');
    const list = (await call(sb, 'chat:channels')).data as { kind: string; name: string; unread: number }[];
    expect(list.find((x) => x.kind === 'dm')).toMatchObject({ name: 'Alice', unread: 1 });
  });

  it('ignorovaný hráč se ignorujícímu nedoručuje; ostatním ano', async () => {
    const { server, url } = await start();
    const [a, b, c] = [await player(server, 'Alice'), await player(server, 'Bob'), await player(server, 'Carol')];
    const [sa, sb, sc] = [await client(url, a.cookie), await client(url, b.cookie), await client(url, c.cookie)];
    const main = ((await call(sa, 'chat:channels')).data as { id: string; kind: string }[]).find((x) => x.kind === 'public')!.id;
    await call(sb, 'chat:ignore', { userId: a.userId, on: true });
    await call(sa, 'chat:send', { channelId: main, body: 'spam' });
    await until(() => events(sc, 'chat:message').length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(events(sb, 'chat:message')).toHaveLength(0);
  });

  it('host může číst, ale ne psát; špatná zpráva a limit zahlcení', async () => {
    const { server, url } = await start();
    const host = await player(server, 'Divak', 'host');
    const sh = await client(url, host.cookie);
    const main = ((await call(sh, 'chat:channels')).data as { id: string; kind: string }[]).find((x) => x.kind === 'public')!.id;
    expect((await call(sh, 'chat:history', { channelId: main })).ok).toBe(true);
    expect((await call(sh, 'chat:send', { channelId: main, body: 'ahoj' })).code).toBe('CHAT_FORBIDDEN');
    expect((await call(sh, 'chat:send', { channelId: 'neni-uuid', body: 'x' })).code).toBe('INVALID_MESSAGE');
    expect((await call(sh, 'chat:send', { body: 'x' })).code).toBe('INVALID_MESSAGE');
  });

  it('„píše…“ se předá ostatním v kanálu, nejvýš jednou za chvíli', async () => {
    const { server, url } = await start();
    const [a, b] = [await player(server, 'Alice'), await player(server, 'Bob')];
    const [sa, sb] = [await client(url, a.cookie), await client(url, b.cookie)];
    const main = ((await call(sa, 'chat:channels')).data as { id: string; kind: string }[]).find((x) => x.kind === 'public')!.id;
    await call(sa, 'chat:typing', { channelId: main });
    await call(sa, 'chat:typing', { channelId: main });
    await until(() => events(sb, 'chat:typing').length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(events(sb, 'chat:typing')).toHaveLength(1);
    expect(events(sb, 'chat:typing')[0]).toMatchObject({ nickname: 'Alice' });
    expect(events(sa, 'chat:typing')).toHaveLength(0);
  });

  it('kdo je online a kdo sedí u stolu; u stolu vznikne kanál se systémovou zprávou', async () => {
    const { server, url } = await start();
    const [a, b] = [await player(server, 'Alice'), await player(server, 'Bob')];
    const sa = await client(url, a.cookie);
    await client(url, b.cookie);
    await until(() => events(sa, 'presence').some((p: unknown[]) => p.length === 2));
    await call(sa, 'table:join', { tableId: 'stul-1', seat: 0, amount: 500 });
    await until(() => events(sa, 'presence').some((p: { userId: string; status: string }[]) => p.find((x) => x.userId === a.userId)?.status === 'table'));
    expect((await call(sa, 'presence:list')).data).toHaveLength(2);
    const channels = (await call(sa, 'chat:channels')).data as { id: string; kind: string; key: string }[];
    const table = channels.find((c) => c.kind === 'table')!;
    expect(table.key).toBe('table:stul-1');
    await new Promise((r) => setTimeout(r, 200));
    const hist = (await call(sa, 'chat:history', { channelId: table.id })).data as { system: boolean; body: string }[];
    expect(hist.some((m) => m.system && m.body.includes('Alice usedl ke stolu'))).toBe(true);
    // hráč, který nesedí, kanál stolu vidí (smí stůl sledovat) a smí psát podle nastavení pro přihlížející
    const sb = await client(url, b.cookie);
    const perB = (await call(sb, 'chat:channels')).data as { kind: string }[];
    expect(perB.some((c) => c.kind === 'table')).toBe(true);
    expect((await call(sb, 'chat:send', { channelId: table.id, body: 'hodně štěstí' })).ok).toBe(true);
  });
});
