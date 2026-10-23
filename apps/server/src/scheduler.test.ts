import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accounts } from '@kb/ledger';
import { FakeClock, TournamentError } from '@kb/game-core';
import { toLocal } from '@kb/shared';
import { buildServer } from './app.js';
import { calendarToken } from './calendar.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const FAST = {
  'time.betweenHandsMs': 100,
  'time.allInRunoutDelayMs': 50,
  'time.allInRiverDramaMs': 50,
  'time.showdownMs': 50,
  'time.potToWinnerMs': 50,
  'time.turnSeconds': 3,
  'odds.enabled': false,
  'tournament.levelMinutes': 1,
  'tournament.targetMinutes': 12,
  'tournament.startingStack': 1000,
  'tournament.buyIn': 100,
  'tournament.fee': 10,
};

async function start(dataDir?: string, clock = new FakeClock()) {
  const server = await buildServer({
    clock,
    dataDir,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 3), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000 },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `S${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}
type Ctx = Awaited<ReturnType<typeof start>>;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof TournamentError) return e.code;
    throw e;
  }
};

const create = (c: Ctx, org: string, startInMs: number, settings: Record<string, number | boolean | string> = {}) =>
  c.server.tournaments.scheduleTournament(org, { name: 'Páteční hra', templateId: 'tour-turbo', settings: { ...FAST, 'tournament.autoStartWhenFull': false, 'tournament.minPlayers': 3, ...settings }, startAt: c.clock.now() + startInMs });

/** Posune čas a po každém kroku nechá plánovač zareagovat. */
async function run(c: Ctx, totalMs: number, stepMs = 1000) {
  for (let t = 0; t < totalMs; t += stepMs) {
    c.clock.advance(stepMs);
    await c.server.scheduler.tick();
  }
}

describe('plánované turnaje', { timeout: 300_000 }, () => {
  it('registrace se otevře v nastavený čas, odhlášení je možné jen do uzávěrky a oprávnění „naplánovat“ se kontroluje', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const player = await c.user();
    await expect(c.server.tournaments.scheduleTournament(player, { name: 'Pokus', templateId: 'tour-turbo', startAt: c.clock.now() + HOUR })).rejects.toThrow(/FORBIDDEN/);
    const { id } = await create(c, org, 3 * HOUR, { 'tournament.registerOpensMinutes': 60, 'tournament.unregisterUntilMinutes': 10 });
    expect(await code(c.server.tournaments.register(player, id))).toBe('REGISTRATION_CLOSED');
    expect((await c.server.tournaments.view(id, player)).me.canRegister).toBe(false);
    await run(c, 2 * HOUR + 1000, 60_000);
    expect((await c.server.tournaments.view(id, player)).schedule!.registrationOpen).toBe(true);
    expect(await code(c.server.tournaments.register(player, id))).toBe('OK');
    // upozornění o otevření registrace dostali všichni
    const inbox = await c.server.notifications.list(player);
    expect(inbox.items.some((n) => n.kind === 'registrationOpened')).toBe(true);
    expect(inbox.unread).toBeGreaterThan(0);
    // do uzávěrky (10 min před startem) se lze odhlásit, potom ne
    await run(c, 50 * MIN, MIN);
    expect(c.clock.now()).toBeGreaterThan(0);
    expect(await code(c.server.tournaments.unregister(player, id))).toBe('STATE');
  });

  it('celý turnaj proběhne sám: otevření, připomenutí, start v čase, offline hráči v sit outu, hra a výplata', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const ps = [await c.user(), await c.user(), await c.user()];
    const t0 = c.clock.now();
    const { id } = await create(c, org, 2 * HOUR, { 'tournament.registerOpensMinutes': 120, 'tournament.reminders': '60, 10', 'tournament.payoutPreset': 'top2' });
    await c.server.scheduler.tick();
    for (const p of ps) await c.server.tournaments.register(p, id);
    // před startem: připomenutí 60 a 10 min, každé jednou
    await run(c, 2 * HOUR - 30_000, 30_000);
    const reminders = (await c.server.notifications.list(ps[0]!)).items.filter((n) => n.kind === 'reminder');
    expect(reminders).toHaveLength(2);
    expect(reminders.map((r) => r.params.minutes).sort()).toEqual([10, 60]);
    expect((await c.server.tournaments.view(id, ps[0]!)).status).toBe('registering');
    // v čase startu turnaj začne bez zásahu; nikdo není online, takže všichni začínají v sit outu
    await run(c, 60_000, 1000);
    const tour = c.server.tournaments.get(id)!;
    expect(tour.state().status).toBe('running');
    expect(c.server.tournaments.schedOf(id)!.startAt).toBe(t0 + 2 * HOUR);
    const actor = c.server.tables.actors.get(id)!;
    expect(actor.playersSeated().every((s) => s.mode === 'out' || s.mode === 'in')).toBe(true);
    expect(actor.playersSeated().filter((s) => s.mode === 'out').length).toBeGreaterThanOrEqual(1);
    // hráči se připojí a hrají (jednoduchý bot), zbytek proběhne sám
    for (const p of ps) {
      actor.setConnected(p, true);
      try {
        actor.sitIn(p);
      } catch {
        /* už hraje */
      }
    }
    for (let i = 0; i < 20_000 && c.server.tournaments.get(id)!.state().status === 'running'; i++) {
      const v = actor.viewFor(null);
      if (actor.currentPhase() === 'hand' && v.actingSeat !== null) {
        const pl = v.seats.find((x) => x.seat === v.actingSeat)!;
        const legal = actor.viewFor(pl.playerId).legal;
        if (legal) actor.act(pl.playerId, legal.callAmount > 0 && i % 3 === 0 ? { type: 'fold' } : legal.canCheck ? { type: 'check' } : { type: 'call' });
      }
      c.clock.advance(1000);
      if (i % 10 === 0) await c.server.scheduler.tick();
    }
    const view = await c.server.tournaments.view(id, ps[0]!);
    expect(view.status).toBe('finished');
    expect(view.results!.reduce((n, r) => n + r.payout, 0)).toBe(300);
    expect(c.server.ledger.balance(accounts.tournament(id))).toBe(0);
    const wallets = ps.reduce((n, p) => n + c.server.ledger.balance(accounts.wallet(p)), 0);
    expect(wallets + c.server.ledger.balance(accounts.house())).toBe(3 * 10_000);
    expect((await c.server.notifications.list(ps[1]!)).items.some((n) => n.kind === 'started')).toBe(true);
  });

  it('nedostatek hráčů: zrušení vrátí buy-iny a upozorní přihlášené', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const p = await c.user();
    const { id } = await create(c, org, HOUR, { 'tournament.minPlayersAction': 'cancel' });
    await c.server.tournaments.register(p, id);
    expect(c.server.ledger.balance(accounts.wallet(p))).toBe(10_000 - 110);
    await run(c, HOUR + 5000, 5000);
    expect((await c.server.tournaments.view(id, p)).status).toBe('cancelled');
    expect(c.server.ledger.balance(accounts.wallet(p))).toBe(10_000);
    expect(c.server.ledger.balance(accounts.house())).toBe(0);
    expect((await c.server.notifications.list(p)).items.some((n) => n.kind === 'cancelled')).toBe(true);
  });

  it('odložení: nejvýš N-krát, mezitím může dorazit dost hráčů; jinak se zruší', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const ps = [await c.user(), await c.user(), await c.user()];
    const { id } = await create(c, org, HOUR, { 'tournament.minPlayersAction': 'postpone', 'tournament.postponeMinutes': 30, 'tournament.postponeMax': 2, 'tournament.reminders': '10' });
    await c.server.tournaments.register(ps[0]!, id);
    await c.server.tournaments.register(ps[1]!, id);
    const first = c.server.tournaments.schedOf(id)!.startAt;
    await run(c, HOUR + 5000, 5000);
    expect(c.server.tournaments.schedOf(id)).toMatchObject({ postponed: 1, startAt: first + 30 * MIN });
    expect((await c.server.notifications.list(ps[0]!)).items.some((n) => n.kind === 'postponed')).toBe(true);
    // po odložení se připomenutí pošle znovu 10 min před novým startem
    await run(c, 25 * MIN, 30_000);
    expect((await c.server.notifications.list(ps[0]!)).items.filter((n) => n.kind === 'reminder').length).toBeGreaterThanOrEqual(2);
    // třetí hráč se přihlásí během odložení → turnaj začne
    await c.server.tournaments.register(ps[2]!, id);
    await run(c, 10 * MIN, 5000);
    expect(c.server.tournaments.get(id)!.state().status).toBe('running');
    await c.server.tournaments.cancel(org, id); // aby dál nehrál na pozadí

    // druhý turnaj: nikdo nedorazí, po vyčerpání odložení se zruší
    const second = await create(c, org, HOUR, { 'tournament.minPlayersAction': 'postpone', 'tournament.postponeMinutes': 10, 'tournament.postponeMax': 1 });
    await c.server.tournaments.register(ps[0]!, second.id).catch(() => undefined);
    await run(c, 2 * HOUR, 30_000);
    expect(c.server.tournaments.get(second.id)!.state().status).toBe('cancelled');
    expect(c.server.tournaments.schedOf(second.id)!.postponed).toBe(1);
  });

  it('začít i s menším počtem (aspoň 2)', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const ps = [await c.user(), await c.user()];
    const { id } = await create(c, org, 10 * MIN, { 'tournament.minPlayersAction': 'startAnyway' });
    for (const p of ps) await c.server.tournaments.register(p, id);
    await run(c, 10 * MIN + 2000, 2000);
    expect(c.server.tournaments.get(id)!.state().status === 'running' || c.server.tournaments.get(id)!.state().status === 'finished').toBe(true);
  });

  it('opakovaný plán vytváří výskyty dopředu, každý jen jednou, i po zrušení; vypnutý plán nic nevytváří', async () => {
    const c = await start();
    const org = await c.user('organizator');
    // „každý pátek ve 20:00“ od roku 1970 (hodiny testu začínají v roce 1970)
    const { id: planId } = await c.server.scheduler.createSchedule(org, { name: 'Páteční liga', templateId: 'tour-turbo', settings: { ...FAST, 'tournament.autoStartWhenFull': false }, rule: { type: 'weekly', weekday: 5, time: '20:00', everyWeeks: 1, from: '1970-01-01' } });
    const rows = () => c.server.tournaments.scheduled().filter((t) => t.sched.scheduleId === planId);
    expect(rows().length).toBeGreaterThanOrEqual(1);
    expect(rows().length).toBeLessThanOrEqual(2);
    for (const r of rows()) expect(toLocal(r.sched.startAt)).toMatchObject({ weekday: 5, h: 20, mi: 0 });
    const before = rows().length;
    await c.server.scheduler.tick();
    await c.server.scheduler.tick();
    expect(rows().length).toBe(before);
    // zrušený výskyt se znovu nevytvoří
    const first = rows()[0]!;
    await c.server.tournaments.cancel(org, first.id);
    await c.server.scheduler.tick();
    expect(rows().filter((r) => r.sched.occurrence === first.sched.occurrence)).toHaveLength(1);
    // s časem přibývají další týdny
    c.clock.advance(14 * 24 * HOUR);
    await c.server.scheduler.tick();
    expect(rows().length).toBeGreaterThan(before);
    // vypnutý plán
    await c.server.scheduler.setEnabled(org, planId, false);
    const count = rows().length;
    c.clock.advance(30 * 24 * HOUR);
    await c.server.scheduler.tick();
    expect(rows().length).toBe(count);
    await expect(c.server.scheduler.createSchedule(org, { name: 'Zlý', templateId: 'tour-turbo', rule: { type: 'weekly', weekday: 5, time: '25:00', everyWeeks: 1, from: '2026-01-01' } })).rejects.toThrow(/INVALID/);
  });

  it('pojistka: málo připojených hráčů turnaj pozastaví a po návratu hráčů pokračuje', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const ps = [await c.user(), await c.user(), await c.user()];
    const { id } = await create(c, org, 10 * MIN, { 'tournament.autoPauseBelow': 2 });
    for (const p of ps) await c.server.tournaments.register(p, id);
    await run(c, 10 * MIN + 2000, 2000);
    const tour = c.server.tournaments.get(id)!;
    // nikdo není připojený → pauza
    await c.server.scheduler.tick();
    expect(tour.state().paused).toBe(true);
    expect(c.server.tournaments.schedOf(id)!.autoPaused).toBe(true);
    const actor = c.server.tables.actors.get(id)!;
    actor.setConnected(ps[0]!, true);
    await c.server.scheduler.tick();
    expect(tour.state().paused).toBe(true);
    actor.setConnected(ps[1]!, true);
    await c.server.scheduler.tick();
    expect(tour.state().paused).toBe(false);
    expect(c.server.tournaments.schedOf(id)!.autoPaused).toBe(false);
    // ruční pauza organizátora se automaticky neruší
    await c.server.tournaments.pause(org, id, false);
    await c.server.scheduler.tick();
    expect(tour.state().paused).toBe(true);
  });

  it('po restartu serveru plán pokračuje: turnaj naplánovaný před restartem se spustí v čase', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-sched-'));
    dirs.push(dir);
    const first = await start(dir);
    const org = await first.user('organizator');
    const ps = [await first.user(), await first.user(), await first.user()];
    const { id } = await create(first, org, HOUR, { 'tournament.reminders': '10' });
    for (const p of ps) await first.server.tournaments.register(p, id);
    const startAt = first.server.tournaments.schedOf(id)!.startAt;
    await first.server.journal.flush();
    await first.server.close();
    servers.pop();

    const clock = new FakeClock();
    clock.advance(HOUR + 5000); // server byl vypnutý přes čas startu
    const second = await start(dir, clock);
    expect(second.server.tournaments.schedOf(id)!.startAt).toBe(startAt);
    expect(second.server.tournaments.get(id)!.state().players).toHaveLength(3);
    await second.server.scheduler.tick();
    expect(second.server.tournaments.get(id)!.state().status).toBe('running');
    expect(second.server.ledger.balance(accounts.tournament(id))).toBe(300);
  });

  it('kalendář: nadcházející turnaje a ICS odkaz podepsaný pro uživatele', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const p = await c.user();
    const { id } = await create(c, org, 5 * HOUR);
    await c.server.tournaments.register(p, id);
    const token = calendarToken(Buffer.alloc(32, 3), p);
    const res = await c.server.app.inject({ method: 'GET', url: `/api/calendar/${p}/${token}.ics` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.body).toContain('BEGIN:VCALENDAR');
    expect(res.body).toContain(`UID:${id}@koronabar-poker`);
    expect(res.body).toContain('SUMMARY:✔ Páteční hra');
    const bad = await c.server.app.inject({ method: 'GET', url: `/api/calendar/${p}/${'0'.repeat(32)}.ics` });
    expect(bad.statusCode).toBe(404);
    // cizí uživatel nevidí ✔ u turnaje, do kterého není přihlášen
    const other = await c.server.app.inject({ method: 'GET', url: `/api/calendar/${org}/${calendarToken(Buffer.alloc(32, 3), org)}.ics` });
    expect(other.body).toContain('SUMMARY:Páteční hra');
  });

  it('pojistka automatické pauzy platí i pro ručně založený turnaj a změna „registrace se otevře před startem“ přepočítá plán', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const ps = [await c.user(), await c.user(), await c.user()];
    const { id } = await c.server.tournaments.create(org, { name: 'Ruční hra', templateId: 'tour-turbo', settings: { ...FAST, 'tournament.minPlayers': 3, 'tournament.autoPauseBelow': 2 } });
    for (const p of ps) await c.server.tournaments.register(p, id);
    await c.server.tournaments.start(org, id);
    const tour = c.server.tournaments.get(id)!;
    expect(tour.state().paused).toBe(false);
    for (const p of ps) c.server.tables.actors.get(id)!.setConnected(p, false);
    await c.server.scheduler.tick(); // nikdo není připojený
    expect(tour.state().paused).toBe(true);
    c.server.tables.actors.get(id)!.setConnected(ps[0]!, true);
    c.server.tables.actors.get(id)!.setConnected(ps[1]!, true);
    await c.server.scheduler.tick();
    expect(tour.state().paused).toBe(false);

    const sched = await create(c, org, 5 * HOUR, { 'tournament.registerOpensMinutes': 60 });
    expect(c.server.tournaments.schedOf(sched.id)!.opensAt).toBe(c.server.tournaments.schedOf(sched.id)!.startAt - 60 * MIN);
    await c.server.tournaments.updateSettings(org, sched.id, { 'tournament.registerOpensMinutes': 180 });
    expect(c.server.tournaments.schedOf(sched.id)!.opensAt).toBe(c.server.tournaments.schedOf(sched.id)!.startAt - 180 * MIN);
  });
});
