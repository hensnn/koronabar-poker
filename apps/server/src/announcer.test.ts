import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { AnnouncerError } from './announcer.js';
import { encodeEvent, piperSynthesize, piperVoices, WyomingParser } from './voice/wyoming.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
const fakes: net.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  for (const f of fakes.splice(0)) f.close();
});

/** Falešný Piper: odpovídá na „describe“ a „synthesize“ po protokolu Wyoming a počítá namluvené hlášky. */
async function fakePiper(opts: { broken?: boolean } = {}) {
  const state = { synth: 0, texts: [] as string[], broken: !!opts.broken };
  const server = net.createServer((socket) => {
    const parser = new WyomingParser();
    socket.on('data', (chunk: Buffer) => {
      for (const ev of parser.push(chunk)) {
        if (state.broken) return void socket.destroy();
        if (ev.type === 'describe') {
          const info = Buffer.from(JSON.stringify({ tts: [{ name: 'piper', voices: [{ name: 'cs_CZ-jirka-medium' }, { name: 'cs_CZ-test' }] }] }));
          socket.write(`${JSON.stringify({ type: 'info', data_length: info.length })}\n`);
          socket.write(info);
        } else if (ev.type === 'synthesize') {
          state.synth++;
          state.texts.push(String(ev.data.text));
          const pcm = Buffer.alloc(200, 7);
          socket.write(encodeEvent('audio-start', { rate: 22050, width: 2, channels: 1 }));
          for (const part of [pcm.subarray(0, 120), pcm.subarray(120)]) {
            socket.write(`${JSON.stringify({ type: 'audio-chunk', data: { rate: 22050, width: 2, channels: 1 }, payload_length: part.length })}\n`);
            socket.write(part);
          }
          socket.write(encodeEvent('audio-stop'));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fakes.push(server);
  return { state, port: (server.address() as net.AddressInfo).port };
}

async function start(settings: Record<string, unknown> = {}, extra: { fetch?: typeof fetch } = {}) {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 18), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
    announcerFetch: extra.fetch,
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
    if (e instanceof AnnouncerError) return e.code;
    throw e;
  }
};

describe('protokol Wyoming', () => {
  it('parser složí události i z kusů po jednom bajtu', () => {
    const wire = Buffer.concat([
      Buffer.from(`${JSON.stringify({ type: 'audio-chunk', data: { rate: 1 }, payload_length: 3 })}\n`),
      Buffer.from([1, 2, 3]),
      Buffer.from(`${JSON.stringify({ type: 'info', data_length: 13 })}\n{"tts":[1,2]}`),
    ]);
    const p = new WyomingParser();
    const got = [];
    for (const b of wire) got.push(...p.push(Buffer.from([b])));
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ type: 'audio-chunk', data: { rate: 1 } });
    expect([...got[0]!.payload]).toEqual([1, 2, 3]);
    expect(got[1]!.data).toEqual({ tts: [1, 2] });
  });

  it('Piper namluví text do WAV a nabídne seznam hlasů', async () => {
    const f = await fakePiper();
    const wav = await piperSynthesize('Ahoj', { host: '127.0.0.1', port: f.port, voice: 'cs_CZ-jirka-medium', timeoutMs: 3000 });
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF');
    expect(wav.toString('latin1', 8, 12)).toBe('WAVE');
    expect(wav.length).toBe(44 + 200);
    expect(await piperVoices({ host: '127.0.0.1', port: f.port, timeoutMs: 3000 })).toEqual(['cs_CZ-jirka-medium', 'cs_CZ-test']);
  });
});

describe('hlasatel', { timeout: 60_000 }, () => {
  it('Piper: stejná hláška se generuje jen jednou a selhání se zaznamená i zase vyléčí', async () => {
    const f = await fakePiper();
    const s = await start({ 'announcer.source': 'piper', 'announcer.piperHost': '127.0.0.1', 'announcer.piperPort': f.port });
    const org = await s.user('organizator');
    const { id } = await s.server.tournaments.create(org, { name: 'Hospoda', templateId: 'tour-turbo', settings: { 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100 } });
    const [a, b] = [await s.user(), await s.user()];
    await s.server.tournaments.liveRegister(org, id, a);
    await s.server.tournaments.liveRegister(org, id, b);
    await s.server.tournaments.start(org, id);

    const nowTv = s.clock.now();
    const list = s.server.announcer.forTv(nowTv);
    expect(list.map((x) => x.event)).toContain('tournamentStart');
    const start1 = list.find((x) => x.event === 'tournamentStart')!;
    expect(start1.text).toContain('Hospoda');

    const a1 = await s.server.announcer.audioFor(start1.id, 'user');
    const a2 = await s.server.announcer.audioFor(start1.id, 'user');
    expect(a1.mime).toBe('audio/wav');
    expect(a2.data.equals(a1.data)).toBe(true);
    expect(f.state.texts.filter((t) => t === start1.text)).toHaveLength(1);

    f.state.broken = true;
    await s.server.tournaments.liveEliminate(org, id, a, [b]);
    const winner = s.server.announcer.forTv(s.clock.now()).find((x) => x.event === 'winner')!;
    expect(await code(s.server.announcer.audioFor(winner.id, 'user'))).toBe('SOURCE_FAILED');
    expect(s.server.announcer.status().failing?.source).toBe('piper');
    f.state.broken = false;
    await s.server.announcer.audioFor(winner.id, 'user');
    expect(s.server.announcer.status().failing).toBeNull();
  });

  it('hlas prohlížeče nic na serveru nenamluví a vypnutá událost mlčí', async () => {
    const s = await start();
    const org = await s.user('organizator');
    expect(await code(s.server.announcer.sample(org, 'piper', 'ahoj'))).toBe('FORBIDDEN');
    await s.server.announcer.saveTemplates(s.admin, { bubble: { enabled: false, variants: [] }, paused: { enabled: true, variants: ['Pauza, {nope}'] } }).catch((e) => e);
    await expect(s.server.announcer.saveTemplates(s.admin, { paused: { enabled: true, variants: ['Pauza, {nope}'] } })).rejects.toMatchObject({ code: 'INVALID' });
    await s.server.announcer.saveTemplates(s.admin, { bubble: { enabled: false, variants: [] }, levelUp: { enabled: true, variants: ['Blindy {sb} a {bb}.'] } });
    expect(s.server.announcer.announce('bubble', {}, { rooms: [] })).toBeNull();
    expect(s.server.announcer.announce('levelUp', { level: 3, sb: 100, bb: 200, ante: 0 }, { rooms: [] })).toBe('Blindy 100 a 200.');
    const item = s.server.announcer.forTv(s.clock.now())[0]!;
    expect(await code(s.server.announcer.audioFor(item.id, 'user'))).toBe('NO_AUDIO');
  });

  it('šablony přežijí restart a varianty se neopakují za sebou', async () => {
    const s = await start();
    await s.server.announcer.saveTemplates(s.admin, { allIn: { enabled: true, variants: ['A {nick}', 'B {nick}'] } });
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) seen.push(s.server.announcer.announce('allIn', { nick: 'Petr' }, { rooms: [] })!);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  it('hlášky stolu jdou na televizi se zpožděním přenosu, ostatní hned', async () => {
    const s = await start({ 'tv.tableDelaySeconds': 30 });
    s.server.announcer.announce('allIn', { nick: 'Petr' }, { rooms: [], table: true });
    s.server.announcer.announce('bubble', {}, { rooms: [] });
    const t0 = s.clock.now();
    expect(s.server.announcer.forTv(t0).map((x) => x.event)).toEqual(['bubble']);
    s.clock.advance(31_000);
    expect(s.server.announcer.forTv(s.clock.now()).map((x) => x.event).sort()).toEqual(['allIn', 'bubble']);
  });

  it('odpočet do konce levelu zazní jednou za hodnotu', async () => {
    const s = await start({ 'announcer.countdownSeconds': '30, 10' });
    const org = await s.user('organizator');
    const { id } = await s.server.tournaments.create(org, { name: 'Odpočet', templateId: 'tour-turbo', settings: { 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.levelMinutes': 1, 'tournament.buyIn': 100 } });
    const [a, b] = [await s.user(), await s.user()];
    await s.server.tournaments.liveRegister(org, id, a);
    await s.server.tournaments.liveRegister(org, id, b);
    await s.server.tournaments.start(org, id);
    s.clock.advance(30_000);
    s.server.announcer.tick();
    s.server.announcer.tick();
    s.clock.advance(20_000);
    s.server.announcer.tick();
    const ending = s.server.announcer.forTv(s.clock.now()).filter((x) => x.event === 'levelEnding');
    expect(ending.map((x) => x.text.match(/\d+/)![0])).toEqual(['30', '10']);
  });

  it('Google TTS: klíč jde jen na Google, nikdy do odpovědí a mezipaměť funguje', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes('/voices')) return new Response(JSON.stringify({ voices: [{ name: 'cs-CZ-Standard-A' }] }), { status: 200 });
      expect(JSON.parse(String(init?.body)).voice.name).toBe('cs-CZ-Standard-A');
      return new Response(JSON.stringify({ audioContent: Buffer.from('MP3DATA').toString('base64') }), { status: 200 });
    }) as typeof fetch;
    const s = await start({ 'announcer.source': 'google' }, { fetch: fakeFetch });
    expect(await code(s.server.announcer.sample(s.admin, 'google', 'ahoj'))).toBe('NO_KEY');
    await s.server.secrets.set(s.admin, 'tts.google.apiKey', 'tajny-klic-123456');
    const out = await s.server.announcer.sample(s.admin, 'google', 'ahoj');
    expect(out).toEqual({ data: Buffer.from('MP3DATA'), mime: 'audio/mpeg' });
    await s.server.announcer.sample(s.admin, 'google', 'ahoj');
    expect(calls.filter((c) => c.includes('text:synthesize'))).toHaveLength(1);
    expect((await s.server.announcer.testConnection(s.admin, 'google')).voices).toEqual(['cs-CZ-Standard-A']);
    const dump = JSON.stringify([await s.server.announcer.config(s.admin), s.server.announcer.status()]);
    expect(dump).not.toContain('tajny-klic');
  });

  it('předgenerování a vyprázdnění mezipaměti', async () => {
    const f = await fakePiper();
    const s = await start({ 'announcer.source': 'piper', 'announcer.piperHost': '127.0.0.1', 'announcer.piperPort': f.port });
    const r = await s.server.announcer.pregenerate(s.admin);
    expect(r.count).toBeGreaterThan(0);
    expect(f.state.synth).toBe(r.count);
    expect((await s.server.announcer.config(s.admin)).cache.files).toBe(r.count);
    await s.server.announcer.pregenerate(s.admin);
    expect(f.state.synth).toBe(r.count);
    await s.server.announcer.clearCache(s.admin);
    expect((await s.server.announcer.config(s.admin)).cache.files).toBe(0);
  });
});
