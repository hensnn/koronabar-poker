import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const sub = (id: string) => ({ endpoint: `https://push.example.test/${id}`, keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` } });

async function start() {
  const sent: { endpoint: string; body: { title: string; body: string; url: string | null } }[] = [];
  const dead = new Set<string>();
  const server = await buildServer({
    clock: new FakeClock(),
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 5), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost' },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
    pushSender: async (s, body) => {
      if (dead.has(s.endpoint)) throw Object.assign(new Error('gone'), { statusCode: 410 });
      sent.push({ endpoint: s.endpoint, body: JSON.parse(body) });
    },
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async () => {
    const nick = `P${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    return (await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true })).userId;
  };
  return { server, sent, dead, user };
}

describe('web push', { timeout: 60_000 }, () => {
  it('klíče vznikají sám, soukromý je šifrovaný a veřejný je stálý', async () => {
    const c = await start();
    const a = await c.server.push.publicKey();
    expect(a.length).toBeGreaterThan(50);
    expect(await c.server.push.publicKey()).toBe(a);
    const st = (await c.server.secrets.status()).find((s) => s.key === 'push.vapidPrivateKey')!;
    expect(st.set).toBe(true);
    const priv = (await c.server.secrets.reveal('push.vapidPrivateKey'))!;
    expect(priv).not.toBe(a);
    expect(JSON.stringify(st)).not.toContain(priv);
  });

  it('upozornění na turnaj dostanou jen přihlášená zařízení adresátů a mrtvý odběr se smaže', async () => {
    const c = await start();
    const u1 = await c.user();
    const u2 = await c.user();
    const u3 = await c.user();
    await c.server.push.subscribe(u1, sub('a'));
    await c.server.push.subscribe(u1, sub('b'));
    await c.server.push.subscribe(u2, sub('c'));
    await expect(c.server.push.subscribe(u3, { endpoint: 'http://nezabezpecene', keys: { p256dh: 'x', auth: 'y' } })).rejects.toThrow(/INVALID_SUBSCRIPTION/);

    await c.server.notifications.tournament([u1], { kind: 'reminder', tournamentId: 't1', name: 'Pátek', startAt: Date.now() + 3_600_000, minutes: 60 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.sent.map((s) => s.endpoint).sort()).toEqual([sub('a').endpoint, sub('b').endpoint]);
    expect(c.sent[0]!.body.url).toBe('/turnaj/t1');
    expect(c.sent[0]!.body.body).toContain('Pátek');

    c.dead.add(sub('a').endpoint);
    expect(await c.server.push.send([u1], { title: 'x', body: 'y', url: null })).toBe(1);
    expect(await c.server.push.count(u1)).toBe(1);

    // cizí uživatel cizí odběr neodhlásí
    await c.server.push.unsubscribe(u2, sub('b').endpoint);
    expect(await c.server.push.count(u1)).toBe(1);
    await c.server.push.unsubscribe(u1, sub('b').endpoint);
    expect(await c.server.push.count(u1)).toBe(0);
  });
});
