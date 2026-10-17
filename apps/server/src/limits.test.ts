import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerGuardError } from '@kb/ledger';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { LimitsError } from './limits.js';
import { NotesError } from './notes.js';
import { schema } from './db/index.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(settings: Record<string, unknown> = {}, dataDir?: string, clock = new FakeClock()) {
  const server = await buildServer({
    clock,
    dataDir,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 23), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000, 'system.mailRequestsPerHour': 100, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `L${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}

type Ctx = Awaited<ReturnType<typeof start>>;
const T = { 'table.seats': 6, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'time.betweenHandsMs': 100, 'odds.enabled': false };

const create = (s: Ctx, org: string, name: string, extra: Record<string, unknown> = {}) => s.server.tournaments.create(org, { name, templateId: 'tour-turbo', settings: { ...T, ...extra } });

/** Co se stane při pokusu o vklad: kód chyby a porušený limit. */
async function tryJoin(s: Ctx, user: string, id: string) {
  try {
    await s.server.tournaments.register(user, id);
    return 'OK';
  } catch (e) {
    if (e instanceof LedgerGuardError) return String(e.params.kind) + (e.params.field ? `:${String(e.params.field)}` : '');
    throw e;
  }
}

describe('osobní limity v účetní knize', { timeout: 90_000 }, () => {
  it('limit počtu buy-inů za den zastaví další vstup do turnaje a nic se nestrhne', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const p = await s.user();
    await s.server.limits.set(p, { buyInsDay: 1 });
    const [a, b] = [await create(s, org, 'První'), await create(s, org, 'Druhý')];
    expect(await tryJoin(s, p, a.id)).toBe('OK');
    expect(await tryJoin(s, p, b.id)).toBe('buyIns:buyInsDay');
    expect(s.server.ledger.balance(`wallet:${p}`)).toBe(10_000 - 100);
    expect(s.server.tournaments.get(b.id)!.state().players).toHaveLength(0);
  });

  it('limit prohry počítá čistý výsledek: po vrácení vkladu jde znovu', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const p = await s.user();
    await s.server.limits.set(p, { lossDay: 150 });
    const [a, b] = [await create(s, org, 'První'), await create(s, org, 'Druhý')];
    expect(await tryJoin(s, p, a.id)).toBe('OK');
    expect(await tryJoin(s, p, b.id)).toBe('loss:lossDay');
    await s.server.tournaments.unregister(p, a.id);
    expect(await tryJoin(s, p, b.id)).toBe('OK');
  });

  it('zpřísnění platí hned, uvolnění až po čekací době', async () => {
    const s = await start({ 'limits.loosenDelayHours': 24 });
    const org = await s.user('organizator');
    const p = await s.user();
    const [a, b, c] = [await create(s, org, 'AA'), await create(s, org, 'BB'), await create(s, org, 'CC')];
    await s.server.limits.set(p, { buyInsDay: 1 });
    expect(await tryJoin(s, p, a.id)).toBe('OK');
    const r = await s.server.limits.set(p, { buyInsDay: 5 });
    expect(r).toEqual({ applied: [], delayed: ['buyInsDay'] });
    expect(await tryJoin(s, p, b.id)).toBe('buyIns:buyInsDay');
    s.clock.advance(25 * 3600_000);
    expect(await tryJoin(s, p, c.id)).toBe('OK');
    const v = await s.server.limits.view(p);
    expect(v.limits.buyInsDay).toBe(5);
    expect(v.pending).toEqual({});
  });

  it('společné limity správce platí pro všechny, přísnější vyhrává', async () => {
    const s = await start({ 'limits.global.buyInsDay': 1 });
    const org = await s.user('organizator');
    const p = await s.user();
    await s.server.limits.set(p, { buyInsDay: 5 });
    const [a, b] = [await create(s, org, 'AA'), await create(s, org, 'BB')];
    expect(await tryJoin(s, p, a.id)).toBe('OK');
    expect(await tryJoin(s, p, b.id)).toBe('buyIns:buyInsDay');
    expect((await s.server.limits.view(p)).effective.buyInsDay).toBe(1);
  });

  it('pauza od hry blokuje vklady, jde jen prodloužit a po uplynutí končí', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const p = await s.user();
    const [a, b] = [await create(s, org, 'AA'), await create(s, org, 'BB')];
    await s.server.limits.setBreak(p, 2);
    expect(await tryJoin(s, p, a.id)).toBe('break');
    await s.server.limits.setBreak(p, 3);
    await expect(s.server.limits.setBreak(p, 1)).rejects.toMatchObject({ code: 'BREAK_SHORTER' });
    await expect(s.server.limits.setBreak(p, 0)).rejects.toBeInstanceOf(LimitsError);
    s.clock.advance(4 * 3600_000);
    expect(await tryJoin(s, p, b.id)).toBe('OK');
    expect((await s.server.limits.view(p)).breakUntil).toBeNull();
  });

  it('sázky a odměny se počítají do prohry, ale ne do počtu buy-inů', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [p, q] = [await s.user(), await s.user()];
    const g = await create(s, org, 'Sázkový', { 'tournament.live': true });
    for (const u of [p, q]) await s.server.tournaments.liveRegister(org, g.id, u);
    await s.server.limits.set(p, { buyInsDay: 1, lossDay: 250 });
    const bet = await s.server.bets.create(q, { tournamentId: g.id, subject: 'winner', params: { userId: q }, side: 'yes', amount: 50 });
    await s.server.bets.stake(p, bet.id, 'no', 50);
    await expect(s.server.bets.stake(p, bet.id, 'no', 200)).rejects.toBeInstanceOf(LedgerGuardError);
  });

  it('vypnuté limity nic nehlídají', async () => {
    const s = await start({ 'limits.enabled': false });
    const org = await s.user('organizator');
    const p = await s.user();
    await expect(s.server.limits.set(p, { buyInsDay: 1 })).rejects.toMatchObject({ code: 'DISABLED' });
    expect(await tryJoin(s, p, (await create(s, org, 'AA')).id)).toBe('OK');
  });

  it('chybné hodnoty limitů server odmítne', async () => {
    const s = await start();
    const p = await s.user();
    for (const bad of [{ nesmysl: 1 }, { lossDay: -5 }, { lossDay: 1.5 }, { lossDay: 'x' }, null]) await expect(s.server.limits.set(p, bad)).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('limity i spotřeba přežijí restart serveru', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-lim-'));
    dirs.push(dir);
    const first = await start({}, dir);
    const org = await first.user('organizator');
    const p = await first.user();
    await first.server.limits.set(p, { buyInsDay: 1 });
    await first.server.limits.setBreak(p, 1);
    await first.server.journal.flush();
    await first.server.close();
    servers.pop();
    const second = await start({}, dir, first.clock);
    const v = await second.server.limits.view(p);
    expect(v.limits.buyInsDay).toBe(1);
    expect(v.breakUntil).not.toBeNull();
  });
});

describe('sezení, připomínky a doba hry', { timeout: 90_000 }, () => {
  it('připomíná pauzu, po dosažení limitu doby hry nepustí další vklad', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [p, q] = [await s.user(), await s.user()];
    const first = await create(s, org, 'Hraje se');
    const other = await create(s, org, 'Další');
    for (const u of [p, q]) await s.server.tournaments.register(u, first.id);
    await s.server.tournaments.start(org, first.id);
    await s.server.limits.set(p, { reminderMinutes: 1, sessionMinutes: 30 });
    await s.server.limits.tick();
    s.clock.advance(90_000);
    await s.server.limits.tick();
    const notes = await s.server.db.select().from(schema.notifications);
    expect(notes.filter((n) => n.kind === 'limitReminder' && n.userId === p)).toHaveLength(1);
    expect(await tryJoin(s, p, other.id)).toBe('OK');
  });

  it('po limitu doby hry další buy-in nejde', async () => {
    const s = await start();
    const org = await s.user('organizator');
    const [p, q] = [await s.user(), await s.user()];
    const first = await create(s, org, 'Hraje se');
    const other = await create(s, org, 'Další');
    for (const u of [p, q]) await s.server.tournaments.register(u, first.id);
    await s.server.tournaments.start(org, first.id);
    await s.server.limits.set(p, { sessionMinutes: 1 });
    await s.server.limits.tick();
    s.clock.advance(2 * 60_000);
    await s.server.limits.tick();
    const notes = await s.server.db.select().from(schema.notifications);
    expect(notes.some((n) => n.kind === 'limitSession' && n.userId === p)).toBe(true);
    expect(await tryJoin(s, p, other.id)).toBe('session:sessionMinutes');
    expect(await tryJoin(s, q, other.id)).toBe('OK');
  });
});

describe('poznámky a štítky o hráčích', { timeout: 60_000 }, () => {
  it('poznámky vidí jen autor, štítek má barvu z tokenů a jde je exportovat', async () => {
    const s = await start();
    const [a, b, c] = [await s.user(), await s.user(), await s.user()];
    const label = await s.server.notes.createLabel(a, 'Bluffuje', 'danger');
    await s.server.notes.put(a, b, 'Často blufuje na riveru', label.id);
    await s.server.notes.put(a, c, '', null); // prázdné nic neuloží
    const mine = await s.server.notes.list(a);
    expect(mine.labels).toEqual([{ id: label.id, name: 'Bluffuje', color: 'danger' }]);
    expect(mine.notes).toHaveLength(1);
    expect(mine.notes[0]).toMatchObject({ targetId: b, note: 'Často blufuje na riveru', labelId: label.id });
    expect((await s.server.notes.list(b)).notes).toEqual([]);
    expect(JSON.parse(await s.server.notes.export(a)).notes[0]).toMatchObject({ note: 'Často blufuje na riveru', label: 'Bluffuje' });
    expect(JSON.stringify(await s.server.notes.export(b))).not.toContain('blufuje');
  });

  it('pravidla: ne na sebe, jen vlastní štítek, povolená barva, limity a smazání štítku nesmaže poznámku', async () => {
    const s = await start();
    const [a, b] = [await s.user(), await s.user()];
    const err = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'OK';
      } catch (e) {
        if (e instanceof NotesError) return e.code;
        throw e;
      }
    };
    expect(await err(s.server.notes.put(a, a, 'já', null))).toBe('INVALID');
    expect(await err(s.server.notes.createLabel(a, 'X', 'fialová'))).toBe('INVALID');
    expect(await err(s.server.notes.createLabel(a, '', 'danger'))).toBe('INVALID');
    expect(await err(s.server.notes.put(a, b, 'x'.repeat(1001), null))).toBe('INVALID');
    const foreign = await s.server.notes.createLabel(b, 'Cizí', 'primary');
    expect(await err(s.server.notes.put(a, b, 'x', foreign.id))).toBe('INVALID');
    expect(await err(s.server.notes.updateLabel(a, foreign.id, 'Moje', 'primary'))).toBe('NOT_FOUND');
    for (let i = 0; i < 12; i++) await s.server.notes.createLabel(a, `L${i}`, 'muted');
    expect(await err(s.server.notes.createLabel(a, 'Třináctý', 'muted'))).toBe('LIMIT');
    const mine = await s.server.notes.list(a);
    await s.server.notes.put(a, b, 'Poznámka', mine.labels[0]!.id);
    await s.server.notes.deleteLabel(a, mine.labels[0]!.id);
    const after = await s.server.notes.list(a);
    expect(after.notes[0]).toMatchObject({ note: 'Poznámka', labelId: null });
    await s.server.notes.remove(a, b);
    expect((await s.server.notes.list(a)).notes).toEqual([]);
  });
});
