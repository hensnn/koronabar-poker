import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { builtinSounds, detectFormat, PassthroughProcessor } from './audio.js';
import { SoundError } from './sounds.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const WAV = builtinSounds()[0]!.data;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof SoundError) return e.code;
    throw e;
  }
};

async function start(settings: Record<string, unknown> = {}, ms = 1500) {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 6), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
    audioProcessor: new PassthroughProcessor(ms),
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `Z${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}

const up = (shortcut: string, extra: Record<string, unknown> = {}) => ({ name: `Zvuk ${shortcut}`, shortcut, data: WAV, ext: 'wav', ...extra });

describe('zvukové emotikony', { timeout: 60_000 }, () => {
  it('vestavěná sada existuje a formát se pozná podle obsahu', async () => {
    const c = await start();
    const u = await c.user();
    const list = await c.server.sounds.list(u);
    expect(list.filter((s) => s.builtin).map((s) => s.shortcut)).toEqual(expect.arrayContaining(['ding', 'fanfara', 'smutna', 'buben']));
    expect(detectFormat(WAV)).toBe('wav');
    expect(detectFormat(Buffer.from('OggS'.padEnd(20, 'x')))).toBe('ogg');
    expect(detectFormat(Buffer.from('<html>tohle neni zvuk</html>'))).toBeNull();
    const a = await c.server.sounds.audio(u, list[0]!.id);
    expect(a.mime).toBe('audio/wav');
  });

  it('nahrávání: kontrola formátu, velikosti, délky, zkratky, počtu a kvóty', async () => {
    const c = await start({ 'sounds.maxPerUser': 3, 'sounds.maxSeconds': 1, 'sounds.maxFileKb': 64 });
    const u = await c.user();
    const other = await c.user();
    const noRight = await c.user();
    for (const a of c.server.perms.assignmentsOf(noRight)) await c.server.perms.revokeAssignment(c.admin, a.id);
    await c.server.perms.assignRole(c.admin, noRight, c.server.perms.roleByKey('statistik')!.id);
    expect(await code(c.server.sounds.upload(noRight, up('nic')))).toBe('FORBIDDEN');
    expect(await code(c.server.sounds.upload(u, up('podvrh', { data: Buffer.from('není to zvuk, jen text, který se tváří jako wav') })))).toBe('INVALID_AUDIO');
    expect(await code(c.server.sounds.upload(u, up('velky', { data: Buffer.concat([WAV, Buffer.alloc(70 * 1024)]) })))).toBe('FILE_TOO_LARGE');
    // zdroj je 1,5 s a limit 1 s: bez ořezu to nejde, s ořezem ano
    expect(await code(c.server.sounds.upload(u, up('dlouhy')))).toBe('TOO_LONG');
    const ok = await c.server.sounds.upload(u, up('kratky', { startMs: 200, endMs: 900, emoji: '😀' }));
    expect(ok).toMatchObject({ shortcut: 'kratky', durationMs: 700, status: 'private', mine: true });
    expect(await code(c.server.sounds.upload(other, up('kratky', { startMs: 0, endMs: 500 })))).toBe('SHORTCUT_TAKEN');
    expect(await code(c.server.sounds.upload(u, up('Spatna Zkratka', { startMs: 0, endMs: 500 })))).toBe('INVALID_SHORTCUT');
    await c.server.sounds.upload(u, up('dva', { startMs: 0, endMs: 500 }));
    await c.server.sounds.upload(u, up('tri', { startMs: 0, endMs: 500 }));
    expect(await code(c.server.sounds.upload(u, up('ctyri', { startMs: 0, endMs: 500 })))).toBe('LIMIT_REACHED');
    // zakázaný formát
    const c2 = await start({ 'sounds.formats': 'mp3' });
    expect(await code(c2.server.sounds.upload(await c2.user(), up('wavnot', { startMs: 0, endMs: 500 })))).toBe('FORMAT_NOT_ALLOWED');
    // kvóta úložiště
    const c3 = await start({ 'sounds.storageQuotaMb': 1, 'sounds.maxFileKb': 4096 });
    expect(await code(c3.server.sounds.upload(await c3.user(), up('velka', { data: Buffer.concat([WAV, Buffer.alloc(1_200_000)]), startMs: 0, endMs: 500 })))).toBe('QUOTA_EXCEEDED');
    // vypnuto správcem
    const c4 = await start({ 'sounds.enabled': false });
    expect(await code(c4.server.sounds.upload(await c4.user(), up('vypnuto', { startMs: 0, endMs: 500 })))).toBe('DISABLED');
  });

  it('soukromé zvuky nevidí ostatní; sdílení projde schválením kurátora', async () => {
    const c = await start({ 'sounds.maxSeconds': 3 });
    const a = await c.user();
    const b = await c.user();
    const curator = await c.user('kurator');
    const s = await c.server.sounds.upload(a, up('moje'));
    expect((await c.server.sounds.list(b)).some((x) => x.id === s.id)).toBe(false);
    expect(await code(c.server.sounds.audio(b, s.id))).toBe('NOT_FOUND');
    expect(await c.server.sounds.share(a, s.id, true)).toBe('pending');
    expect((await c.server.sounds.list(b)).some((x) => x.id === s.id)).toBe(false);
    expect(await code(c.server.sounds.pending(b))).toBe('FORBIDDEN');
    expect((await c.server.sounds.pending(curator)).map((x) => x.id)).toEqual([s.id]);
    await c.server.sounds.review(curator, s.id, true);
    expect((await c.server.sounds.list(b)).find((x) => x.id === s.id)).toMatchObject({ status: 'shared', ownerNickname: expect.any(String) });
    // správce zvuk skryje a smaže, vestavěný smazat nejde
    await c.server.sounds.hide(curator, s.id, true);
    expect((await c.server.sounds.list(b)).some((x) => x.id === s.id)).toBe(false);
    expect(await code(c.server.sounds.remove(b, s.id))).toBe('FORBIDDEN');
    await c.server.sounds.remove(a, s.id);
    const builtin = (await c.server.sounds.list(a)).find((x) => x.builtin)!;
    expect(await code(c.server.sounds.remove(c.admin, builtin.id))).toBe('BUILTIN');
    // bez schvalování se sdílí hned
    const c2 = await start({ 'sounds.requireApproval': false, 'sounds.maxSeconds': 3 });
    const x = await c2.user();
    const t = await c2.server.sounds.upload(x, up('hned', { share: true }));
    expect(t.status).toBe('shared');
  });

  it('odeslání do chatu: zpráva se zapíše, cooldowny a limit za minutu vedou na zvuk bez přehrání', async () => {
    const c = await start({ 'sounds.userCooldownSeconds': 5, 'sounds.soundCooldownSeconds': 30, 'sounds.perMinuteLimit': 3 });
    const a = await c.user();
    const b = await c.user();
    const channel = await c.server.chat.ensureMainChannel();
    const sounds = (await c.server.sounds.list(a)).filter((s) => s.builtin);
    const [s1, s2, s3, s4] = sounds;
    expect(await c.server.sounds.play(a, s1!.id, { kind: 'channel', id: channel })).toEqual({ silent: false });
    const hist = await c.server.chat.history(a, channel, {});
    expect(hist.some((m) => m.body === `:${s1!.shortcut}:`)).toBe(true);
    // hned znovu: pauza hráče
    expect((await c.server.sounds.play(a, s2!.id, { kind: 'channel', id: channel })).silent).toBe(true);
    c.clock.advance(6000);
    // stejný zvuk dřív než za 30 s
    expect((await c.server.sounds.play(a, s1!.id, { kind: 'channel', id: channel })).silent).toBe(true);
    expect((await c.server.sounds.play(a, s2!.id, { kind: 'channel', id: channel })).silent).toBe(false);
    c.clock.advance(6000);
    expect((await c.server.sounds.play(b, s3!.id, { kind: 'channel', id: channel })).silent).toBe(false);
    // limit tří zvuků za minutu na místo
    c.clock.advance(6000);
    expect((await c.server.sounds.play(a, s4!.id, { kind: 'channel', id: channel })).silent).toBe(true);
    c.clock.advance(61_000);
    expect((await c.server.sounds.play(a, s4!.id, { kind: 'channel', id: channel })).silent).toBe(false);
    // oblíbené a naposledy použité
    await c.server.sounds.favorite(a, s1!.id, true);
    const list = await c.server.sounds.list(a);
    expect(list.find((x) => x.id === s1!.id)).toMatchObject({ favorite: true });
    expect(list.find((x) => x.id === s4!.id)!.lastUsedAt).not.toBeNull();
    // do kanálu, kam hráč nesmí, a do neexistujícího stolu se neposílá
    expect(await code(c.server.sounds.play(a, s1!.id, { kind: 'table', id: 'neexistuje' }))).toBe('FORBIDDEN');
  });

  it('ztlumení konkrétního zvuku nebo hráče se ukládá a jde zrušit', async () => {
    const c = await start();
    const a = await c.user();
    const b = await c.user();
    await c.server.sounds.setMute(a, 'player', b, true);
    await c.server.sounds.setMute(a, 'sound', 'ding', true);
    expect(await c.server.sounds.mutes(a)).toHaveLength(2);
    await c.server.sounds.setMute(a, 'player', b, false);
    expect(await c.server.sounds.mutes(a)).toEqual([{ kind: 'sound', target: 'ding' }]);
    expect(await code(c.server.sounds.setMute(a, 'nesmysl', 'x', true))).toBe('BAD_STATE');
  });
});
