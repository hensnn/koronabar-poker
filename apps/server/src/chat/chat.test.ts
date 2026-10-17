import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry, resolveSettings } from '@kb/shared';
import { AuditService } from '../auth/audit.js';
import { PermissionService } from '../auth/permissions.js';
import { seedRoles } from '../auth/seed.js';
import { openPglite, schema, type Database } from '../db/index.js';
import { ChatError, ChatService, type MessageDto } from './service.js';

let database: Database | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});
const reg = createDefaultRegistry();

async function setup(over: Record<string, number | boolean | string> = {}) {
  database = await openPglite();
  const { db } = database;
  let clock = new Date('2026-08-01T10:00:00Z');
  const audit = new AuditService(db);
  const perms = new PermissionService(db, audit, () => clock);
  await seedRoles(db, perms);
  const tableMembers = new Map<string, { read: string[]; write: string[] }>();
  const chat = new ChatService({
    db,
    perms,
    audit,
    now: () => clock,
    settings: () => resolveSettings(reg, [{ scope: 'global', values: over }]).values,
    tableAccess: (userId, tableId) => ({ read: !!tableMembers.get(tableId)?.read.includes(userId), write: !!tableMembers.get(tableId)?.write.includes(userId) }),
  });
  const log: { kind: string; payload: any }[] = [];
  chat.on({
    message: (_c, m) => void log.push({ kind: 'message', payload: m }),
    edited: (_c, m) => void log.push({ kind: 'edited', payload: m }),
    deleted: (_c, id) => void log.push({ kind: 'deleted', payload: id }),
    reaction: (_c, id, r) => void log.push({ kind: 'reaction', payload: { id, r } }),
    pinned: (_c, m) => void log.push({ kind: 'pinned', payload: m }),
    mention: (u, m) => void log.push({ kind: 'mention', payload: { u, id: m.id } }),
    joined: (u, c) => void log.push({ kind: 'joined', payload: { u, c } }),
  });
  let n = 0;
  const user = async (nick: string, role = 'hrac') => {
    const [u] = await db.insert(schema.users).values({ nickname: nick, nicknameLower: nick.toLowerCase(), passwordHash: 'x' }).returning({ id: schema.users.id });
    await perms.grantUnchecked(u!.id, perms.roleByKey(role)!.id);
    n++;
    return u!.id;
  };
  const main = await chat.ensureMainChannel();
  return { db, perms, chat, main, user, log, tableMembers, advance: (ms: number) => void (clock = new Date(clock.getTime() + ms)) };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof ChatError) return e.code;
    throw e;
  }
};

describe('kanály a oprávnění', () => {
  it('hlavní kanál vznikne jednou a čtou ho i hosté, píšou jen ti s oprávněním', async () => {
    const s = await setup();
    expect(await s.chat.ensureMainChannel()).toBe(s.main);
    const hrac = await s.user('Hrac');
    const host = await s.user('Host', 'host');
    const zablok = await s.user('Zablok', 'zablokovany');
    expect((await s.chat.listChannels(hrac)).map((c) => c.name)).toEqual(['Hospoda']);
    expect((await s.chat.listChannels(host)).map((c) => c.name)).toEqual(['Hospoda']);
    expect(await s.chat.listChannels(zablok)).toEqual([]);
    expect(await code(s.chat.send(hrac, s.main, 'Ahoj'))).toBe('OK');
    expect(await code(s.chat.send(host, s.main, 'Ahoj'))).toBe('FORBIDDEN');
    expect(await code(s.chat.send(zablok, s.main, 'Ahoj'))).toBe('FORBIDDEN');
    expect(await code(s.chat.history(host, s.main))).toBe('OK');
    expect(await code(s.chat.history(zablok, s.main))).toBe('FORBIDDEN');
  });

  it('vypnutý chat nic nedovolí', async () => {
    const s = await setup({ 'chat.enabled': false });
    const u = await s.user('U');
    expect(await s.chat.listChannels(u)).toEqual([]);
    expect(await code(s.chat.send(u, s.main, 'x'))).toBe('FORBIDDEN');
  });

  it('soukromé zprávy 1:1: dva účastníci, nikdo jiný je nevidí, kanál se znovu použije', async () => {
    const s = await setup();
    const [a, b, c] = [await s.user('A'), await s.user('B'), await s.user('C')];
    const dm = await s.chat.openDm(a, b);
    expect(await s.chat.openDm(b, a)).toBe(dm);
    expect(s.log.filter((l) => l.kind === 'joined').map((l) => l.payload.u).sort()).toEqual([a, b].sort());
    await s.chat.send(a, dm, 'tajemství');
    expect((await s.chat.history(b, dm))[0]!.body).toBe('tajemství');
    expect(await code(s.chat.history(c, dm))).toBe('FORBIDDEN');
    expect(await code(s.chat.send(c, dm, 'vetřelec'))).toBe('FORBIDDEN');
    const list = await s.chat.listChannels(b);
    expect(list.find((x) => x.kind === 'dm')).toMatchObject({ name: 'A', unread: 1, peer: { id: a, nickname: 'A' } });
    expect((await s.chat.listChannels(c)).some((x) => x.kind === 'dm')).toBe(false);
    expect(await code(s.chat.openDm(a, a))).toBe('INVALID');
    expect(await code(s.chat.openDm(a, '00000000-0000-4000-8000-000000000000'))).toBe('NOT_FOUND');
  });

  it('skupinové konverzace a veřejné kanály podle oprávnění a nastavení', async () => {
    const s = await setup();
    const [a, b, c] = [await s.user('A'), await s.user('B'), await s.user('C')];
    const g = await s.chat.createGroup(a, 'Pátek', [b]);
    await s.chat.send(b, g, 'jedu');
    expect(await code(s.chat.history(c, g))).toBe('FORBIDDEN');
    expect(await code(s.chat.createGroup(a, '  ', [b]))).toBe('INVALID');
    // hráči veřejný kanál nezaloží, správce ano; po zapnutí nastavení i hráč
    expect(await code(s.chat.createPublicChannel(a, 'Výsledky'))).toBe('FORBIDDEN');
    const admin = await s.user('Admin', 'admin');
    const ch = await s.chat.createPublicChannel(admin, 'Výsledky');
    expect((await s.chat.listChannels(a)).map((x) => x.name)).toContain('Výsledky');
    expect(await code(s.chat.createPublicChannel(admin, 'Výsledky'))).toBe('INVALID');
    await s.chat.archiveChannel(admin, ch);
    expect((await s.chat.listChannels(a)).map((x) => x.name)).not.toContain('Výsledky');
    expect(await code(s.chat.archiveChannel(admin, s.main))).toBe('INVALID');
    const open = await setup({ 'chat.playerChannels': true });
    const p = await open.user('P');
    expect(await code(open.chat.createPublicChannel(p, 'Hráčský'))).toBe('OK');
  });

  it('chat stolu: čte a píše jen ten, kdo má ke stolu přístup; přihlížející podle nastavení', async () => {
    const s = await setup();
    const [hrac, divak, cizi] = [await s.user('Hrac'), await s.user('Divak'), await s.user('Cizi')];
    const ch = await s.chat.ensureTableChannel('stul-1', 'Stůl 1');
    s.tableMembers.set('stul-1', { read: [hrac, divak], write: [hrac] });
    expect(await code(s.chat.send(hrac, ch, 'good luck'))).toBe('OK');
    expect(await code(s.chat.send(divak, ch, 'hlas z publika'))).toBe('FORBIDDEN');
    expect(await code(s.chat.history(divak, ch))).toBe('OK');
    expect(await code(s.chat.history(cizi, ch))).toBe('FORBIDDEN');
    expect((await s.chat.listChannels(cizi)).some((c) => c.kind === 'table')).toBe(false);
    expect((await s.chat.listChannels(divak)).some((c) => c.kind === 'table')).toBe(true);
  });
});

describe('zprávy', () => {
  it('odeslání, historie ve správném pořadí a stránkování', async () => {
    const s = await setup();
    const u = await s.user('U');
    for (let i = 1; i <= 7; i++) await s.chat.send(u, s.main, `zpráva ${i}`);
    const last = await s.chat.history(u, s.main, { limit: 3 });
    expect(last.map((m) => m.body)).toEqual(['zpráva 5', 'zpráva 6', 'zpráva 7']);
    const older = await s.chat.history(u, s.main, { limit: 3, before: last[0]!.id });
    expect(older.map((m) => m.body)).toEqual(['zpráva 2', 'zpráva 3', 'zpráva 4']);
    expect(s.log.filter((l) => l.kind === 'message')).toHaveLength(7);
  });

  it('validace: prázdná, příliš dlouhá, limit za minutu, odpověď na zprávu', async () => {
    const s = await setup({ 'chat.maxLength': 20, 'chat.messagesPerMinute': 3 });
    const u = await s.user('U');
    expect(await code(s.chat.send(u, s.main, '   '))).toBe('EMPTY');
    expect(await code(s.chat.send(u, s.main, 'x'.repeat(21)))).toBe('TOO_LONG');
    const first = await s.chat.send(u, s.main, 'jedna');
    const reply = await s.chat.send(u, s.main, 'odpověď', { replyTo: first.id });
    expect(reply.replyTo).toBe(first.id);
    expect(await code(s.chat.send(u, s.main, 'x', { replyTo: 99999 }))).toBe('NOT_FOUND');
    await s.chat.send(u, s.main, 'tři');
    expect(await code(s.chat.send(u, s.main, 'čtyři'))).toBe('RATE_LIMITED');
    s.advance(61_000);
    expect(await code(s.chat.send(u, s.main, 'zase'))).toBe('OK');
  });

  it('zmínky @přezdívka: jen existující a oprávnění čtenáři, ne autor sám sebe', async () => {
    const s = await setup();
    const [a, b, host, zablok] = [await s.user('Adam'), await s.user('Beata'), await s.user('Hostik', 'host'), await s.user('Zlobivy', 'zablokovany')];
    const m = await s.chat.send(a, s.main, 'ahoj @Beata, @hostik, @zlobivy, @Adam a @nikdo');
    expect(m.mentions.sort()).toEqual([b, host].sort());
    expect(s.log.filter((l) => l.kind === 'mention').map((l) => l.payload.u).sort()).toEqual([b, host].sort());
    const dm = await s.chat.openDm(a, b);
    const m2 = await s.chat.send(a, dm, '@Hostik tohle neuvidí');
    expect(m2.mentions).toEqual([]);
    void zablok;
  });

  it('filtr slov, úprava (jen autor a jen v časovém okně) a smazání', async () => {
    const s = await setup({ 'chat.wordFilter': 'blbec, hlupak', 'chat.editWindowMinutes': 10 });
    const [a, b] = [await s.user('A'), await s.user('B')];
    const m = await s.chat.send(a, s.main, 'ty Blbec a hlupak');
    expect(m.body).toBe('ty ***** a ******');
    const e = await s.chat.edit(a, m.id, 'oprava');
    expect(e.body).toBe('oprava');
    expect(e.editedAt).not.toBeNull();
    expect(await code(s.chat.edit(b, m.id, 'cizí'))).toBe('FORBIDDEN');
    s.advance(11 * 60_000);
    expect(await code(s.chat.edit(a, m.id, 'pozdě'))).toBe('EDIT_EXPIRED');
    expect(await code(s.chat.delete(b, m.id))).toBe('FORBIDDEN');
    await s.chat.delete(a, m.id);
    const h = await s.chat.history(b, s.main);
    expect(h[0]).toMatchObject({ deleted: true, body: '' });
    expect(await code(s.chat.edit(a, m.id, 'znovu'))).toBe('FORBIDDEN');
    expect(s.log.some((l) => l.kind === 'deleted' && l.payload === m.id)).toBe(true);
  });

  it('moderátor smaže cizí zprávu (a zapíše se do auditu), hráč ne', async () => {
    const s = await setup();
    const [a, mod] = [await s.user('A'), await s.user('Mod', 'moderator')];
    const m = await s.chat.send(a, s.main, 'nevhodné');
    await s.chat.delete(mod, m.id);
    expect((await s.chat.history(a, s.main))[0]!.deleted).toBe(true);
    const audit = await new AuditService(s.db).list({ action: 'chat.zprava_smazana' });
    expect(audit[0]).toMatchObject({ actorId: mod, targetId: String(m.id) });
    expect((audit[0]!.before as { body: string }).body).toBe('nevhodné');
  });

  it('reakce: přepínání, jen povolené emoji, viditelné všem', async () => {
    const s = await setup();
    const [a, b] = [await s.user('A'), await s.user('B')];
    const m = await s.chat.send(a, s.main, 'vtip');
    expect(await s.chat.react(b, m.id, '😂')).toEqual({ '😂': [b] });
    expect(await s.chat.react(a, m.id, '😂')).toEqual({ '😂': [b, a] });
    expect(await s.chat.react(b, m.id, '😂')).toEqual({ '😂': [a] });
    expect(await code(s.chat.react(b, m.id, '💩'))).toBe('BAD_EMOJI');
    expect((await s.chat.history(a, s.main))[0]!.reactions['😂']).toEqual([a]);
  });

  it('připínání zpráv vyžaduje oprávnění', async () => {
    const s = await setup();
    const [a, mod] = [await s.user('A'), await s.user('Mod', 'moderator')];
    const m = await s.chat.send(a, s.main, 'důležité');
    expect(await code(s.chat.pin(a, m.id, true))).toBe('FORBIDDEN');
    expect((await s.chat.pin(mod, m.id, true)).pinned).toBe(true);
    expect((await s.chat.pinned(a, s.main)).map((x) => x.id)).toEqual([m.id]);
    await s.chat.pin(mod, m.id, false);
    expect(await s.chat.pinned(a, s.main)).toEqual([]);
  });

  it('vyhledávání jen v kanálech, které smím číst; speciální znaky se escapují', async () => {
    const s = await setup();
    const [a, b, c] = [await s.user('A'), await s.user('B'), await s.user('C')];
    await s.chat.send(a, s.main, 'turnaj v pátek 100% jistě');
    const dm = await s.chat.openDm(a, b);
    await s.chat.send(a, dm, 'soukromý turnaj');
    expect((await s.chat.search(a, 'turnaj')).map((m) => m.body).sort()).toEqual(['soukromý turnaj', 'turnaj v pátek 100% jistě']);
    expect((await s.chat.search(c, 'turnaj')).map((m) => m.body)).toEqual(['turnaj v pátek 100% jistě']);
    expect((await s.chat.search(a, '100%')).length).toBe(1);
    expect((await s.chat.search(a, '%%')).length).toBe(0);
    expect(await code(s.chat.search(a, 'x'))).toBe('INVALID');
  });
});

describe('nepřečtené, ztlumení a ignorování', () => {
  it('nepřečtené zprávy se počítají a po označení za přečtené zmizí', async () => {
    const s = await setup();
    const [a, b] = [await s.user('A'), await s.user('B')];
    await s.chat.send(a, s.main, 'jedna');
    const m2 = await s.chat.send(a, s.main, 'dvě');
    expect((await s.chat.listChannels(b))[0]!.unread).toBe(2);
    expect((await s.chat.listChannels(a))[0]!.unread).toBe(0);
    await s.chat.markRead(b, s.main, m2.id);
    expect((await s.chat.listChannels(b))[0]!.unread).toBe(0);
    await s.chat.send(a, s.main, 'tři');
    expect((await s.chat.listChannels(b))[0]!.unread).toBe(1);
  });

  it('ztlumení: omezené délkou z oprávnění, platí v kanálu, vyprší, jde zrušit, je v auditu', async () => {
    const s = await setup();
    const [a, mod] = [await s.user('A'), await s.user('Mod', 'moderator')];
    expect(await code(s.chat.mute(a, mod, 1, 'x'))).toBe('FORBIDDEN');
    expect(await code(s.chat.mute(mod, a, 48, 'moc dlouho'))).toBe('FORBIDDEN');
    await s.chat.mute(mod, a, 2, 'spam');
    try {
      await s.chat.send(a, s.main, 'dál spamuju');
      throw new Error('měl být ztlumen');
    } catch (e) {
      expect((e as ChatError).code).toBe('MUTED');
      expect((e as ChatError).params!.reason).toBe('spam');
    }
    s.advance(3 * 3600_000);
    expect(await code(s.chat.send(a, s.main, 'už můžu'))).toBe('OK');
    await s.chat.mute(mod, a, 1, 'znovu');
    await s.chat.unmute(mod, a);
    expect(await code(s.chat.send(a, s.main, 'zase můžu'))).toBe('OK');
    const audit = (await new AuditService(s.db).list({})).map((x) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['chat.ztlumit', 'chat.zrusit_ztlumeni']));
  });

  it('ztlumení jen v jednom kanálu neovlivní ostatní', async () => {
    const s = await setup();
    const [a, mod] = [await s.user('A'), await s.user('Mod', 'moderator')];
    const other = await s.chat.createPublicChannel(mod, 'Druhý');
    await s.chat.mute(mod, a, 1, 'jen tady', s.main);
    expect(await code(s.chat.send(a, s.main, 'x'))).toBe('MUTED');
    expect(await code(s.chat.send(a, other, 'x'))).toBe('OK');
  });

  it('ignorovaný hráč se v historii a ve vyhledávání nezobrazuje, ostatním ano', async () => {
    const s = await setup();
    const [a, b, c] = [await s.user('A'), await s.user('B'), await s.user('C')];
    await s.chat.send(b, s.main, 'zpráva od B');
    await s.chat.send(c, s.main, 'zpráva od C');
    await s.chat.setIgnore(a, b, true);
    expect((await s.chat.history(a, s.main)).map((m) => m.body)).toEqual(['zpráva od C']);
    expect((await s.chat.history(c, s.main)).map((m) => m.body)).toEqual(['zpráva od B', 'zpráva od C']);
    expect((await s.chat.search(a, 'zpráva')).map((m) => m.body)).toEqual(['zpráva od C']);
    expect(await s.chat.recipients(s.main, b, [a, c])).toEqual([c]);
    await s.chat.setIgnore(a, b, false);
    expect((await s.chat.history(a, s.main)).length).toBe(2);
    expect(await code(s.chat.setIgnore(a, a, true))).toBe('INVALID');
  });

  it('systémové zprávy a úklid staré historie', async () => {
    const s = await setup({ 'chat.historyDays': 30 });
    const u = await s.user('U');
    await s.chat.send(u, s.main, 'stará');
    await s.chat.system(s.main, 'Blindy stoupají na 100/200');
    s.advance(31 * 86400_000);
    await s.chat.send(u, s.main, 'nová');
    expect(await s.chat.purgeOld()).toBe(2);
    expect((await s.chat.history(u, s.main)).map((m) => m.body)).toEqual(['nová']);
    expect(s.log.some((l) => l.kind === 'message' && (l.payload as MessageDto).system)).toBe(true);
  });
});
