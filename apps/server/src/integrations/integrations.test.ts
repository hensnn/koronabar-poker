import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from '../app.js';
import { schema } from '../db/index.js';
import { IntegrationError, signWebhook } from './service.js';
import { connectPacket, publishPacket } from './mqtt.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) c();
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Podvržený fetch: zapisuje volání a odpovídá podle fronty stavů (jinak 200). */
function fakeFetch(statuses: number[] = []) {
  const calls: Call[] = [];
  const f = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const status = statuses.shift() ?? 200;
    return { status } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function start(settings: Record<string, unknown> = {}, extra: { fetch?: typeof fetch; mqtt?: Parameters<typeof buildServer>[0] extends infer O ? (O extends { mqttConnector?: infer M } ? M : never) : never } = {}) {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 31), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, 'integrations.enabled': true, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
    integrationFetch: extra.fetch,
    mqttConnector: extra.mqtt,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `I${n++}x`;
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
    if (e instanceof IntegrationError) return e.code;
    throw e;
  }
};

describe('webhooky', { timeout: 60_000 }, () => {
  it('událost se doručí podepsaná, tělo má verzi a čas, log ukazuje doručeno', async () => {
    const { f, calls } = fakeFetch();
    const c = await start({}, { fetch: f });
    const id = await c.server.integrations.createEndpoint(c.admin, { name: 'Home Assistant', url: 'https://example.cz/hook' });
    c.server.integrations.emit('hand.bigPot', { nick: 'Karel', pot: 900, bb: 90 });
    await c.server.integrations.idle();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({ version: 1, event: 'hand.bigPot', data: { nick: 'Karel', pot: 900, bb: 90 } });
    expect(call.headers['x-kb-event']).toBe('hand.bigPot');
    const secret = (await c.server.secrets.reveal('webhook.signingSecret'))!;
    expect(call.headers['x-kb-signature']).toBe(signWebhook(secret, Number(call.headers['x-kb-timestamp']), call.body));
    expect(signWebhook('jiny', 1, call.body)).not.toBe(call.headers['x-kb-signature']);
    const log = await c.server.integrations.deliveries(c.admin);
    expect(log[0]).toMatchObject({ status: 'ok', attempts: 1, responseCode: 200, event: 'hand.bigPot' });
    expect((await c.server.integrations.endpoints(c.admin))[0]).toMatchObject({ name: 'Home Assistant', host: 'example.cz' });
    void id;
  });

  it('při chybě se opakuje se zdvojnásobujícím se odstupem, po vyčerpání pokusů zůstane chybné a jde zopakovat', async () => {
    const { f, calls } = fakeFetch([500, 500, 200]);
    const c = await start({ 'integrations.webhookRetrySeconds': 10, 'integrations.webhookMaxAttempts': 3 }, { fetch: f });
    await c.server.integrations.createEndpoint(c.admin, { name: 'Chybny', url: 'https://example.cz/h' });
    c.server.integrations.emit('poll.created', { title: 'Hrajeme?' });
    await c.server.integrations.idle();
    expect(calls).toHaveLength(1);
    expect((await c.server.integrations.deliveries(c.admin))[0]).toMatchObject({ status: 'pending', attempts: 1, responseCode: 500 });
    await c.server.integrations.processDue();
    expect(calls).toHaveLength(1); // ještě není čas
    c.clock.advance(11_000);
    await c.server.integrations.processDue();
    expect(calls).toHaveLength(2);
    c.clock.advance(15_000); // druhý odstup je 20 s
    await c.server.integrations.processDue();
    expect(calls).toHaveLength(2);
    c.clock.advance(6_000);
    await c.server.integrations.processDue();
    expect(calls).toHaveLength(3);
    expect((await c.server.integrations.deliveries(c.admin))[0]).toMatchObject({ status: 'ok', attempts: 3 });

    const failing = fakeFetch([500, 500, 500, 200]);
    const d = await start({ 'integrations.webhookRetrySeconds': 1, 'integrations.webhookMaxAttempts': 2 }, { fetch: failing.f });
    await d.server.integrations.createEndpoint(d.admin, { name: 'Spatny', url: 'https://example.cz/x' });
    d.server.integrations.emit('poll.created', { title: 'A' });
    await d.server.integrations.idle();
    d.clock.advance(2000);
    await d.server.integrations.processDue();
    const failed = (await d.server.integrations.deliveries(d.admin, { status: 'failed' }))[0]!;
    expect(failed).toMatchObject({ status: 'failed', attempts: 2 });
    await d.server.integrations.retry(d.admin, failed.id);
    expect((await d.server.integrations.deliveries(d.admin))[0]).toMatchObject({ status: 'pending', attempts: 1 }); // další 500
    expect(await code(d.server.integrations.retry(d.admin, failed.id))).toBe('NOT_FOUND'); // už nečeká jako chybné
  });

  it('endpoint dostane jen vybrané události; výchozí výběr vynechá chat a all-in; vypnutí napojení nic neposílá', async () => {
    const { f, calls } = fakeFetch();
    const c = await start({}, { fetch: f });
    await c.server.integrations.createEndpoint(c.admin, { name: 'Jen vitez', url: 'https://example.cz/a', events: ['tournament.finished'] });
    await c.server.integrations.createEndpoint(c.admin, { name: 'Vychozi', url: 'https://example.cz/b' });
    c.server.integrations.emit('tournament.finished', { name: 'T', winner: 'A', players: 3 });
    c.server.integrations.emit('chat.message', { nick: 'A', text: 'ahoj' });
    c.server.integrations.emit('player.allIn', { nick: 'A' });
    await c.server.integrations.idle();
    expect(calls.map((x) => `${x.url.split('/').pop()}:${x.headers['x-kb-event']}`).sort()).toEqual(['a:tournament.finished', 'b:tournament.finished']);
    await c.server.settings.set(c.admin, 'global', '', 'integrations.enabled', false);
    c.server.integrations.emit('tournament.finished', { name: 'T' });
    await c.server.integrations.idle();
    expect(calls).toHaveLength(2);
  });

  it('správa jen s oprávněním, adresa musí být http(s), neplatné události se odmítnou', async () => {
    const c = await start();
    const u = await c.user();
    expect(await code(c.server.integrations.createEndpoint(u, { name: 'Ahoj', url: 'https://example.cz' }))).toBe('FORBIDDEN');
    expect(await code(c.server.integrations.deliveries(u))).toBe('FORBIDDEN');
    expect(await code(c.server.integrations.createEndpoint(c.admin, { name: 'Ahoj', url: 'ftp://example.cz' }))).toBe('INVALID');
    expect(await code(c.server.integrations.createEndpoint(c.admin, { name: 'Ahoj', url: 'neplatne' }))).toBe('INVALID');
    expect(await code(c.server.integrations.createEndpoint(c.admin, { name: 'x', url: 'https://example.cz' }))).toBe('INVALID');
    expect(await code(c.server.integrations.createEndpoint(c.admin, { name: 'Ahoj', url: 'https://example.cz', events: ['nic.takoveho'] }))).toBe('INVALID');
    const id = await c.server.integrations.createEndpoint(c.admin, { name: 'Ahoj', url: 'https://example.cz/tajny/token' });
    // v seznamu je jen hostitel, ne celá adresa s tokenem
    expect(JSON.stringify(await c.server.integrations.endpoints(c.admin))).not.toContain('tajny');
    await c.server.integrations.removeEndpoint(c.admin, id);
    expect(await code(c.server.integrations.removeEndpoint(c.admin, id))).toBe('NOT_FOUND');
  });

  it('Discord: zpráva je přeložený text bez pingů, posílá se jen vybraným událostem a jen s adresou', async () => {
    const { f, calls } = fakeFetch();
    const c = await start({ 'integrations.discordEnabled': true }, { fetch: f });
    expect(await code(c.server.integrations.testDiscord(c.admin))).toBe('NOT_CONFIGURED');
    await c.server.secrets.set(c.admin, 'discord.webhookUrl', 'https://discord.example/api/webhooks/1/abc');
    c.server.integrations.emit('tournament.finished', { name: 'Páteční', winner: 'Karel', players: 5 });
    c.server.integrations.emit('hand.bigPot', { nick: 'Karel', pot: 1, bb: 1 }); // není ve výchozím výběru Discordu
    await c.server.integrations.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://discord.example/api/webhooks/1/abc');
    const msg = JSON.parse(calls[0]!.body);
    expect(msg.content).toContain('Páteční');
    expect(msg.content).toContain('Karel');
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    expect(calls[0]!.headers['x-kb-signature']).toBeUndefined();
    expect(await c.server.integrations.testDiscord(c.admin)).toEqual({ ok: true });
  });

  it('čtyři Discord kanály: každý má vlastní adresu a vlastní události; nenastavený ani vypnutý nic nedostane', async () => {
    const { f, calls } = fakeFetch();
    const c = await start(
      {
        'integrations.discordEnabled': true, // kanál 1: výchozí události (konec turnaje…)
        'integrations.discord2Enabled': true,
        'integrations.discord2Events': 'chat.message',
        'integrations.discord3Enabled': true,
        'integrations.discord3Events': 'tournament.finished,poll.created',
        'integrations.discord4Enabled': false, // vypnutý, i když má adresu
        'integrations.discord4Events': 'tournament.finished',
      },
      { fetch: f },
    );
    const hook = (n: number) => `https://discord.example/api/webhooks/${n}/tok${n}`;
    await c.server.secrets.set(c.admin, 'discord.webhookUrl', hook(1));
    await c.server.secrets.set(c.admin, 'discord.webhookUrl2', hook(2));
    await c.server.secrets.set(c.admin, 'discord.webhookUrl3', hook(3));
    await c.server.secrets.set(c.admin, 'discord.webhookUrl4', hook(4));
    expect(await code(c.server.integrations.testDiscord(c.admin, 2))).toBe('OK');

    calls.length = 0;
    c.server.integrations.emit('chat.message', { nick: 'Karel', text: 'ahoj' });
    c.server.integrations.emit('tournament.finished', { name: 'Páteční', winner: 'Karel', players: 5 });
    await c.server.integrations.idle();
    const to = (n: number) => calls.filter((x) => x.url === hook(n)).map((x) => JSON.parse(x.body).content as string);
    expect(to(2)).toHaveLength(1);
    expect(to(2)[0]).toContain('ahoj');
    expect(to(3)).toHaveLength(1);
    expect(to(3)[0]).toContain('Páteční');
    expect(to(1)).toHaveLength(1); // výchozí události kanálu 1: konec turnaje
    expect(to(1)[0]).toContain('Páteční');
    expect(to(4)).toHaveLength(0);

    // přehled ukáže všechny čtyři sloty (adresy ne) a zkouška posílá jen do vybraného kanálu
    const ov = await c.server.integrations.overview(c.admin);
    expect(ov.discord.map((x) => [x.slot, x.enabled, x.configured])).toEqual([[1, true, true], [2, true, true], [3, true, true], [4, false, true]]);
    expect(JSON.stringify(ov)).not.toContain('tok2');
    calls.length = 0;
    expect(await c.server.integrations.testDiscord(c.admin, 3)).toEqual({ ok: true });
    expect(calls.map((x) => x.url)).toEqual([hook(3)]);
    const targets = (await c.server.db.select().from(schema.webhookDeliveries)).map((d) => d.target);
    expect(targets).toEqual(expect.arrayContaining(['discord', 'discord2', 'discord3']));
    expect(targets).not.toContain('discord4');
  });

  it('skutečné události hry: start turnaje, nová anketa a uzavření večera se odešlou', async () => {
    const { f, calls } = fakeFetch();
    const c = await start({ 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9, 'tournament.payoutPreset': 'wta' }, { fetch: f });
    await c.server.integrations.createEndpoint(c.admin, { name: 'Vse', url: 'https://example.cz/all' });
    const org = await c.user('organizator');
    const [a, b] = [await c.user(), await c.user()];
    const { id } = await c.server.tournaments.create(org, { name: 'Čtvrteční', templateId: 'tour-turbo', settings: { 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9, 'tournament.payoutPreset': 'wta' } });
    for (const p of [a, b]) await c.server.tournaments.liveRegister(org, id, p);
    await c.server.tournaments.start(org, id);
    await c.server.tournaments.liveEliminate(org, id, b, [a]);
    await c.server.integrations.idle();
    const events = calls.map((x) => x.headers['x-kb-event']);
    expect(events).toContain('tournament.started');
    expect(events).toContain('player.eliminated');
    expect(events).toContain('tournament.finished');
    const fin = JSON.parse(calls.find((x) => x.headers['x-kb-event'] === 'tournament.finished')!.body);
    expect(fin.data).toMatchObject({ name: 'Čtvrteční', players: 2 });
    // v žádné události nejsou karty ani balíček
    for (const call of calls) expect(call.body).not.toMatch(/"(hole|deck|cards)"/);
    void schema;
  });
});

// ---------- MQTT ----------

interface Fake {
  port: number;
  connects: { user?: string; pass?: string }[];
  published: { topic: string; payload: string; retain: boolean }[];
}

/** Falešný broker: přečte CONNECT, odpoví CONNACK s daným kódem a zapisuje PUBLISH. */
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
};

async function fakeBroker(returnCode = 0): Promise<Fake> {
  const state: Fake = { port: 0, connects: [], published: [] };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d as Buffer]);
      for (;;) {
        if (buf.length < 2) return;
        let len = 0;
        let mult = 1;
        let i = 1;
        for (;;) {
          const b = buf[i++]!;
          len += (b & 127) * mult;
          mult *= 128;
          if (!(b & 128)) break;
        }
        if (buf.length < i + len) return;
        const type = buf[0]! >> 4;
        const flags = buf[0]! & 15;
        const body = buf.subarray(i, i + len);
        buf = buf.subarray(i + len);
        if (type === 1) {
          const cf = body[7]!;
          let p = 10;
          const read = () => {
            const n = body.readUInt16BE(p);
            const s = body.subarray(p + 2, p + 2 + n).toString();
            p += 2 + n;
            return s;
          };
          read(); // clientId
          const user = cf & 0x80 ? read() : undefined;
          const pass = cf & 0x40 ? read() : undefined;
          state.connects.push({ user, pass });
          sock.write(Buffer.from([0x20, 0x02, 0x00, returnCode]));
        } else if (type === 3) {
          const n = body.readUInt16BE(0);
          state.published.push({ topic: body.subarray(2, 2 + n).toString(), payload: body.subarray(2 + n).toString(), retain: !!(flags & 1) });
        }
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.port = (server.address() as net.AddressInfo).port;
  closers.push(() => server.close());
  return state;
}

describe('MQTT a Home Assistant', { timeout: 60_000 }, () => {
  it('pakety odpovídají MQTT 3.1.1', () => {
    const p = publishPacket('a/b', 'hi', true);
    expect([...p]).toEqual([0x31, 7, 0, 3, 97, 47, 98, 104, 105]);
    const c = connectPacket({ host: 'x', port: 1, tls: false, username: 'u', password: 'p', clientId: 'cid' });
    expect(c[0]).toBe(0x10);
    expect(c.subarray(2, 9).toString('latin1')).toBe('\u0000\u0004MQTT\u0004');
    expect(c[9]).toBe(0xc2); // uživatel + heslo + čistá relace
  });

  it('test spojení pošle stav a Discovery, události jdou do témat s předponou, heslo se čte z tajných údajů', async () => {
    const broker = await fakeBroker();
    const c = await start({ 'integrations.mqttEnabled': true, 'integrations.mqttHost': '127.0.0.1', 'integrations.mqttPort': broker.port, 'integrations.mqttUser': 'ha', 'integrations.mqttPrefix': 'kb' });
    await c.server.secrets.set(c.admin, 'mqtt.password', 'tajne-heslo');
    expect(await c.server.integrations.testMqtt(c.admin)).toEqual({ ok: true });
    expect(broker.connects[0]).toEqual({ user: 'ha', pass: 'tajne-heslo' });
    await until(() => broker.published.length >= 8);
    const topics = broker.published.map((m) => m.topic);
    expect(topics).toContain('kb/status');
    expect(topics).toContain('kb/state');
    expect(topics).toContain('homeassistant/sensor/kb/tournament_level/config');
    expect(topics.filter((x) => x.startsWith('homeassistant/')).length).toBe(6);
    const disc = JSON.parse(broker.published.find((m) => m.topic.endsWith('tournament_players/config'))!.payload);
    expect(disc).toMatchObject({ unique_id: 'kb_tournament_players', state_topic: 'kb/state', availability_topic: 'kb/status' });
    expect(broker.published.find((m) => m.topic === 'kb/state')!.retain).toBe(true);

    c.server.integrations.emit('hand.bigPot', { nick: 'Karel', pot: 500, bb: 50 });
    c.server.integrations.emit('chat.message', { nick: 'A', text: 'x' }); // není ve výchozím výběru MQTT
    await c.server.integrations.idle();
    await until(() => broker.published.some((m) => m.topic === 'kb/event/hand.bigPot'));
    await new Promise((r) => setTimeout(r, 100));
    const ev = broker.published.filter((m) => m.topic.startsWith('kb/event/'));
    expect(ev.map((m) => m.topic)).toEqual(['kb/event/hand.bigPot']);
    expect(ev[0]!.retain).toBe(false);
    const state = JSON.parse(broker.published.filter((m) => m.topic === 'kb/state').at(-1)!.payload);
    expect(state.lastEvent).toMatchObject({ event: 'hand.bigPot' });
    expect(broker.connects).toHaveLength(1); // spojení se znovu používá
  });

  it('špatné přihlášení vrátí srozumitelnou chybu a bez adresy brokeru je napojení nenastavené', async () => {
    const broker = await fakeBroker(4);
    const c = await start({ 'integrations.mqttEnabled': true, 'integrations.mqttHost': '127.0.0.1', 'integrations.mqttPort': broker.port });
    expect(await c.server.integrations.testMqtt(c.admin)).toEqual({ ok: false, error: 'BAD_CREDENTIALS' });
    const d = await start({ 'integrations.mqttEnabled': true });
    expect(await code(d.server.integrations.testMqtt(d.admin))).toBe('NOT_CONFIGURED');
    const u = await d.user();
    expect(await code(d.server.integrations.testMqtt(u))).toBe('FORBIDDEN');
  });
});
