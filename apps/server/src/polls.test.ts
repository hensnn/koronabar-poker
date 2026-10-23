import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { schema } from './db/index.js';
import { PollError } from './polls.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});
const MIN = 60_000;

async function start(settings: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  clock.advance(1000 * MIN);
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 13), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `P${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user, polls: server.polls };
}
type Ctx = Awaited<ReturnType<typeof start>>;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof PollError) return e.code;
    throw e;
  }
};
const only = (...ids: string[]) => ({ type: 'players' as const, keys: ids });
const yes = { type: 'yesno' as const, value: 'yes' as const };
const no = { type: 'yesno' as const, value: 'no' as const };
const opts = (...labels: string[]) => labels.map((label, i) => ({ id: `o${i + 1}`, label }));
const settle = () => new Promise((r) => setTimeout(r, 80));

describe('ankety', { timeout: 120_000 }, () => {
  it('ano / ne: výsledky se ukážou až po hlasu, předčasné ukončení, zpráva v chatu a upozornění', async () => {
    const c = await start();
    const [f, a, b] = [await c.user(), await c.user(), await c.user()];
    const id = await c.polls.create(f, { title: 'Hrajeme v pátek?', config: { type: 'yesno' }, condition: only(a, b, f), durationMinutes: 60 });
    await settle();
    expect((await c.polls.view(a, id)).result).toBeNull(); // výchozí: výsledky po vlastním hlasu
    expect((await c.polls.view(a, id)).canVote).toBe(true);
    await c.polls.vote(a, id, yes);
    const seen = await c.polls.view(a, id);
    expect(seen.result).not.toBeNull();
    expect(seen).toMatchObject({ voted: true, votedCount: 1, eligibleCount: 3 });
    expect(await code(c.polls.vote(a, id, { type: 'single', option: 'x' } as never))).toBe('BAD_ANSWER');
    await c.polls.vote(a, id, no); // změna hlasu je povolená
    await c.polls.vote(b, id, yes);
    expect((await c.polls.view(f, id)).status).toBe('open');
    await c.polls.vote(f, id, yes); // hlasovali všichni: anketa se hned uzavře
    const done = await c.polls.view(f, id);
    expect(done).toMatchObject({ status: 'closed' });
    expect(done.result).toMatchObject({ outcome: 'passed', winners: ['yes'], final: true });
    expect(await code(c.polls.vote(a, id, no))).toBe('CLOSED');
    const main = await c.server.chat.ensureMainChannel();
    const bodies = (await c.server.chat.history(a, main, {})).map((m) => m.body);
    expect(bodies.some((x) => x.includes('Hrajeme v pátek?') && x.includes(`{{anketa:${id}}}`))).toBe(true);
    expect(bodies.some((x) => x.includes('skončila'))).toBe(true);
    const notes = await c.server.db.select().from(schema.notifications).where(eq(schema.notifications.userId, a));
    expect(notes.some((n) => n.kind === 'poll')).toBe(true);
    expect(await code(c.polls.view(await c.user(), id))).toBe('FORBIDDEN'); // anketa je jen pro oprávněné, i po uzavření
  });

  it('podmínky: neoprávněný nehlasuje, prázdný okruh nejde založit, pevný okruh se nemění, živý ano', async () => {
    const c = await start();
    const [f, a, b] = [await c.user(), await c.user('kurator'), await c.user()];
    const outsider = await c.user();
    const roleCond = { type: 'role' as const, keys: ['kurator'] };
    const fixed = await c.polls.create(f, { title: 'Pevná', config: { type: 'yesno' }, condition: roleCond, eligibility: 'fixed' });
    const live = await c.polls.create(f, { title: 'Živá', config: { type: 'yesno' }, condition: roleCond, eligibility: 'live' });
    expect(await code(c.polls.vote(outsider, fixed, yes))).toBe('NOT_ELIGIBLE');
    expect(await code(c.polls.create(f, { title: 'Nikdo', config: { type: 'yesno' }, condition: { type: 'level', min: 999 } }))).toBe('INVALID');
    expect(await code(c.polls.create(f, { title: 'Špatně', config: { type: 'yesno' }, condition: { type: 'nesmysl' } }))).toBe('INVALID');
    // b dostane roli po spuštění
    await c.server.perms.assignRole(c.admin, b, c.server.perms.roleByKey('kurator')!.id);
    expect(await code(c.polls.vote(b, fixed, yes))).toBe('NOT_ELIGIBLE');
    expect(await code(c.polls.vote(b, live, yes))).toBe('OK');
    expect((await c.polls.view(a, live)).eligibleCount).toBeGreaterThanOrEqual(2);
    // živý náhled v editoru
    const prev = await c.polls.preview(f, only(a, b));
    expect(prev.count).toBe(2);
    expect(prev.players.map((p) => p.userId).sort()).toEqual([a, b].sort());
  });

  it('tajná anketa neukládá, kdo jak hlasoval; anonymní nezveřejní hlasující; veřejná po konci ano', async () => {
    const c = await start();
    const [f, a, b] = [await c.user(), await c.user(), await c.user()];
    const secret = await c.polls.create(f, { title: 'Tajná', config: { type: 'single', options: opts('A', 'B'), anonymity: 'secret', allowChange: true }, condition: only(a, b), results: 'always' });
    await c.polls.vote(a, secret, { type: 'single', option: 'o1' });
    expect(await code(c.polls.vote(a, secret, { type: 'single', option: 'o2' }))).toBe('ALREADY_VOTED'); // u tajné nejde změnit
    await c.polls.vote(b, secret, { type: 'single', option: 'o1' });
    const rows = await c.server.db.select().from(schema.pollVotes).where(eq(schema.pollVotes.pollId, secret));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.answer === null)).toBe(true);
    const bag = await c.server.db.select().from(schema.pollSecretBallots).where(eq(schema.pollSecretBallots.pollId, secret));
    expect(bag).toHaveLength(2);
    expect(Object.keys(bag[0]!)).not.toContain('userId');
    const v = await c.polls.view(f, secret);
    expect(v.status).toBe('closed');
    expect(v.result).toMatchObject({ winners: ['o1'] });
    expect(v.voters).toBeNull();
    expect(v.myAnswer).toBeNull();

    const pub = await c.polls.create(f, { title: 'Veřejná', config: { type: 'single', options: opts('A', 'B'), anonymity: 'public' }, condition: only(a, b), results: 'always' });
    await c.polls.vote(a, pub, { type: 'single', option: 'o2' });
    expect((await c.polls.view(b, pub)).voters).toHaveLength(1);
    const anon = await c.polls.create(f, { title: 'Anonymní', config: { type: 'single', options: opts('A', 'B'), anonymity: 'anonymous' }, condition: only(a, b), results: 'always' });
    await c.polls.vote(a, anon, { type: 'single', option: 'o2' });
    expect((await c.polls.view(b, anon)).voters).toBeNull();
  });

  it('remíza: zakladatel, prodloužení, los a nejvýše postavená role', async () => {
    const c = await start();
    const [f, a, b] = [await c.user(), await c.user('moderator'), await c.user()];
    const mk = (tie: 'founder' | 'extend' | 'random' | 'role') => c.polls.create(f, { title: `Remíza ${tie}`, config: { type: 'single', options: opts('A', 'B'), tie }, condition: only(a, b), durationMinutes: 30, results: 'always' });
    const pa = { type: 'single' as const, option: 'o1' };
    const pb = { type: 'single' as const, option: 'o2' };

    const byFounder = await mk('founder');
    await c.polls.vote(a, byFounder, pa);
    await c.polls.vote(b, byFounder, pb);
    expect((await c.polls.view(f, byFounder)).status).toBe('tie');
    expect(await code(c.polls.decideTie(b, byFounder, 'o1'))).toBe('FORBIDDEN');
    expect(await code(c.polls.decideTie(f, byFounder, 'nic'))).toBe('BAD_ANSWER');
    await c.polls.decideTie(f, byFounder, 'o2');
    expect((await c.polls.view(f, byFounder)).result).toMatchObject({ outcome: 'passed', winners: ['o2'] });

    const ext = await mk('extend');
    await c.polls.vote(a, ext, pa);
    await c.polls.vote(b, ext, pb);
    const v1 = await c.polls.view(f, ext);
    expect(v1.status).toBe('open'); // prodlouženo
    expect(v1.endsAt).toBeGreaterThan(c.clock.now() + 30 * MIN);
    c.clock.advance(120 * MIN);
    await c.polls.tick();
    expect((await c.polls.view(f, ext)).status).toBe('tie'); // podruhé už rozhoduje zakladatel

    const byRole = await mk('role');
    await c.polls.vote(a, byRole, pa); // moderátor má vyšší sílu než hráč
    await c.polls.vote(b, byRole, pb);
    expect((await c.polls.view(f, byRole)).result).toMatchObject({ outcome: 'passed', winners: ['o1'] });

    const lottery = await mk('random');
    await c.polls.vote(a, lottery, pa);
    await c.polls.vote(b, lottery, pb);
    const w = (await c.polls.view(f, lottery)).result!;
    expect(w.outcome).toBe('passed');
    expect(['o1', 'o2']).toContain(w.winners[0]);
  });

  it('pravidla jdou měnit jen do prvního hlasu, prodloužit lze vždy; limity a oprávnění', async () => {
    const c = await start({ 'poll.maxOpenPerUser': 2 });
    const [f, a] = [await c.user(), await c.user()];
    const id = await c.polls.create(f, { title: 'Úprava', config: { type: 'yesno' }, condition: only(a, f), durationMinutes: 60, results: 'always' });
    await c.polls.update(f, id, { title: 'Nový název' });
    expect((await c.polls.view(f, id)).title).toBe('Nový název');
    await c.polls.vote(a, id, yes);
    expect(await code(c.polls.update(f, id, { title: 'Pozdě' }))).toBe('LOCKED');
    expect(await code(c.polls.update(a, id, { title: 'Cizí' }))).toBe('FORBIDDEN');
    await c.polls.extend(f, id, 30);
    expect((await c.polls.view(f, id)).endsAt).toBe(c.clock.now() + 90 * MIN);
    expect(await code(c.polls.extend(f, id, 999_999))).toBe('INVALID');
    await c.polls.create(f, { title: 'Druhá', config: { type: 'yesno' }, condition: only(a) });
    expect(await code(c.polls.create(f, { title: 'Třetí', config: { type: 'yesno' }, condition: only(a) }))).toBe('LIMIT');
    expect(await code(c.polls.cancel(a, id))).toBe('FORBIDDEN');
    await c.polls.cancel(f, id);
    expect((await c.polls.view(f, id)).status).toBe('cancelled');
    // bez oprávnění zakládat anketu
    const lone = await c.user('statistik');
    for (const x of c.server.perms.assignmentsOf(lone)) await c.server.perms.revokeAssignment(c.admin, x.id);
    await c.server.perms.assignRole(c.admin, lone, c.server.perms.roleByKey('novacek')!.id);
    expect(await code(c.polls.create(lone, { title: 'Nemůžu', config: { type: 'yesno' } }))).toBe('FORBIDDEN');
    expect(await code(c.polls.create(f, { title: 'Akce', config: { type: 'yesno' }, action: { kind: 'pauseGame', params: { tournamentId: 'x' } } }))).toBe('FORBIDDEN'); // hráč nemá oprávnění k akcím
  });

  it('ankety zakládané serverem (trusted) se nepočítají do limitu otevřených anket a nejdelší anketa je neomezuje', async () => {
    const c = await start({ 'poll.maxOpenPerUser': 1, 'poll.maxDurationDays': 1 });
    const [f, a] = [await c.user(), await c.user()];
    await c.polls.create(f, { title: 'První', config: { type: 'yesno' }, condition: only(a, f) });
    expect(await code(c.polls.create(f, { title: 'Druhá', config: { type: 'yesno' }, condition: only(a, f) }))).toBe('LIMIT');
    expect(await code(c.polls.create(f, { title: 'Server', config: { type: 'yesno' }, condition: only(a, f), durationMinutes: 3 * 1440 }, { trusted: true }))).toBe('OK');
    expect(await code(c.polls.create(a, { title: 'Dlouhá', config: { type: 'yesno' }, condition: only(a, f), durationMinutes: 3 * 1440 }))).toBe('INVALID');
  });

  it('plánovač ukončí anketu po termínu, připomene nehlasujícím a export CSV je jen pro zakladatele', async () => {
    const c = await start({ 'poll.reminderMinutes': 30 });
    const [f, a, b] = [await c.user(), await c.user(), await c.user()];
    const id = await c.polls.create(f, { title: 'Termín', config: { type: 'yesno', quorum: { kind: 'count', value: 3 } }, condition: only(a, b, f), durationMinutes: 60, results: 'always' });
    await c.polls.vote(a, id, yes);
    c.clock.advance(40 * MIN);
    await c.polls.tick();
    const remind = await c.server.db.select().from(schema.notifications).where(eq(schema.notifications.kind, 'pollReminder'));
    expect(remind.map((n) => n.userId).sort()).toEqual([b, f].sort());
    await c.polls.tick(); // připomenutí jen jednou
    expect((await c.server.db.select().from(schema.notifications).where(eq(schema.notifications.kind, 'pollReminder'))).length).toBe(2);
    c.clock.advance(30 * MIN);
    await c.polls.tick();
    const done = await c.polls.view(f, id);
    expect(done).toMatchObject({ status: 'closed' });
    expect(done.result).toMatchObject({ outcome: 'no_quorum', winners: [] }); // hlasoval jen jeden ze tří
    const csv = await c.polls.exportCsv(f, id);
    expect(csv).toContain('no_quorum');
    expect(csv).toContain('P1x'); // veřejná anketa: jméno hlasujícího
    expect(await code(c.polls.exportCsv(a, id))).toBe('FORBIDDEN');
  });

  it('šablony anket, vlastní možnost od hlasujícího a ostatní typy (hodnocení, termín, pořadí)', async () => {
    const c = await start();
    const [f, a, b] = [await c.user(), await c.user(), await c.user()];
    const tpl = await c.polls.saveTemplate(f, 'Týdenní termín', { config: { type: 'schedule' } });
    expect((await c.polls.templates(f)).map((t) => t.name)).toEqual(['Týdenní termín']);
    expect(await c.polls.templates(a)).toEqual([]);
    await c.polls.deleteTemplate(a, tpl); // cizí šablonu nesmaže
    expect(await c.polls.templates(f)).toHaveLength(1);
    await c.polls.deleteTemplate(f, tpl);
    expect(await c.polls.templates(f)).toEqual([]);

    const own = await c.polls.create(f, { title: 'Kam půjdeme', config: { type: 'single', options: opts('Hospoda', 'Kino'), allowAddOptions: true }, condition: only(a, b), results: 'always' });
    const added = await c.polls.addOption(a, own, 'Bowling', '🎳');
    await c.polls.vote(b, own, { type: 'single', option: added });
    expect((await c.polls.view(f, own)).result).toMatchObject({ winners: [added] });
    expect(await code(c.polls.addOption(f, own, 'Já nesmím'))).toBe('NOT_ELIGIBLE');

    const when = await c.polls.create(f, { title: 'Kdy', config: { type: 'schedule', options: opts('Pátek 18:00', 'Sobota 19:00') }, condition: only(a, b), results: 'always' });
    await c.polls.vote(a, when, { type: 'schedule', slots: { o1: 'yes', o2: 'maybe' } });
    await c.polls.vote(b, when, { type: 'schedule', slots: { o1: 'no', o2: 'yes' } });
    const w = await c.polls.view(f, when);
    expect(w.status).toBe('closed');
    expect(w.result).toMatchObject({ winners: ['o2'] });

    const ranked = await c.polls.create(f, { title: 'Pořadí', config: { type: 'ranked', options: opts('A', 'B', 'C') }, condition: only(a, b), results: 'always' });
    await c.polls.vote(a, ranked, { type: 'ranked', order: ['o1', 'o2'] });
    await c.polls.vote(b, ranked, { type: 'ranked', order: ['o1', 'o3'] });
    expect((await c.polls.view(f, ranked)).result).toMatchObject({ winners: ['o1'] });
  });
});

describe('akce po výsledku ankety', { timeout: 120_000 }, () => {
  const DAY = 24 * 60 * MIN;

  it('naplánuje turnaj na vítězný termín až po potvrzení; zamítnutí nic nevytvoří', async () => {
    const c = await start();
    const [a, b] = [await c.user(), await c.user()];
    const slots = [
      { id: 'o1', label: 'Pátek', at: c.clock.now() + 2 * DAY },
      { id: 'o2', label: 'Sobota', at: c.clock.now() + 3 * DAY },
    ];
    const action = { kind: 'scheduleTournament' as const, params: { name: 'Anketní turnaj', templateId: 'tour-turbo' } };
    // bez termínů u možností akce nesedí
    expect(await code(c.polls.create(c.admin, { title: 'Špatně', config: { type: 'schedule', options: [{ label: 'A' }, { label: 'B' }] }, condition: only(c.admin, a, b), action }))).toBe('INVALID');
    const mk = () => c.polls.create(c.admin, { title: 'Kdy turnaj?', config: { type: 'schedule', options: slots }, condition: only(c.admin, a, b), results: 'always', action });
    const id = await mk();
    await c.polls.vote(a, id, { type: 'schedule', slots: { o1: 'no', o2: 'yes' } });
    await c.polls.vote(b, id, { type: 'schedule', slots: { o1: 'maybe', o2: 'yes' } });
    await c.polls.vote(c.admin, id, { type: 'schedule', slots: { o1: 'yes', o2: 'yes' } });
    const v = await c.polls.view(c.admin, id);
    expect(v.status).toBe('closed');
    expect(v.action).toMatchObject({ kind: 'scheduleTournament', state: 'pendingConfirm' });
    expect(v.canConfirm).toBe(true);
    expect((await c.polls.view(a, id)).canConfirm).toBe(false);
    expect(await code(c.polls.confirmAction(a, id, true))).toBe('FORBIDDEN');
    expect(c.server.tournaments.list().filter((t) => t.name === 'Anketní turnaj')).toHaveLength(0);
    await c.polls.confirmAction(c.admin, id, true);
    const done = await c.polls.view(c.admin, id);
    expect(done.action).toMatchObject({ state: 'done' });
    const createdId = done.action!.createdId!;
    expect(c.server.tournaments.schedOf(createdId)!.startAt).toBe(slots[1]!.at);
    expect(await code(c.polls.confirmAction(c.admin, id, true))).toBe('NOT_TIED'); // podruhé už nic

    // zamítnutí potvrzení
    const id2 = await mk();
    for (const u of [a, b, c.admin]) await c.polls.vote(u, id2, { type: 'schedule', slots: { o1: 'yes', o2: 'no' } });
    await c.polls.confirmAction(c.admin, id2, false);
    expect((await c.polls.view(c.admin, id2)).action).toMatchObject({ state: 'rejected' });
    expect(c.server.tournaments.list().filter((t) => t.name === 'Anketní turnaj')).toHaveLength(1);
  });

  it('bez potvrzení se akce provede hned; když anketa neprojde, přeskočí se; selhání se zapíše', async () => {
    const c = await start();
    const [a, b] = [await c.user(), await c.user()];
    const role = { kind: 'assignRole' as const, requireConfirm: false, params: { roleKey: 'kurator', userId: b } };
    const mk = (action: typeof role | { kind: 'pauseGame'; requireConfirm: boolean; params: { tournamentId: string } }) =>
      c.polls.create(c.admin, { title: 'Dáme roli?', config: { type: 'yesno' }, condition: only(c.admin, a), results: 'always', action });
    const yesAll = async (id: string) => {
      await c.polls.vote(a, id, yes);
      await c.polls.vote(c.admin, id, yes);
    };
    const passed = await mk(role);
    await yesAll(passed);
    expect((await c.polls.view(c.admin, passed)).action).toMatchObject({ state: 'done' });
    expect(c.server.perms.assignmentsOf(b).some((x) => x.role?.key === 'kurator')).toBe(true);

    // neprošlo: roli nikdo nedostane
    const [x] = [await c.user()];
    const failing = await c.polls.create(c.admin, { title: 'Ne', config: { type: 'yesno' }, condition: only(c.admin, a), results: 'always', action: { kind: 'assignRole', requireConfirm: false, params: { roleKey: 'kurator', userId: x } } });
    await c.polls.vote(a, failing, no);
    await c.polls.vote(c.admin, failing, no);
    expect((await c.polls.view(c.admin, failing)).action).toMatchObject({ state: 'skipped' });
    expect(c.server.perms.assignmentsOf(x).some((y) => y.role?.key === 'kurator')).toBe(false);

    // akce, která nejde provést (turnaj neexistuje): selže a důvod se uloží
    const broken = await mk({ kind: 'pauseGame', requireConfirm: false, params: { tournamentId: 'neexistuje' } });
    await yesAll(broken);
    const f = await c.polls.view(c.admin, broken);
    expect(f.action!.state).toBe('failed');
    expect(f.action!.message).toBeTruthy();
    const audit = await c.server.audit.list({ action: 'anketa.akce_selhala' });
    expect(audit).toHaveLength(1);
  });

  it('šablona hry z vítězné možnosti vytvoří stůl; akci smí připojit jen oprávněný', async () => {
    const c = await start();
    const [a, b] = [await c.user(), await c.user('moderator')];
    const opts = [
      { id: 'o1', label: 'Klasika', value: 'cash-klasika' },
      { id: 'o2', label: 'Divoká', value: 'cash-klasika' },
    ];
    const cfg = { type: 'single' as const, options: opts };
    expect(await code(c.polls.create(b, { title: 'Moderátor', config: cfg, condition: only(a, b), action: { kind: 'useTemplate', params: { name: 'Stůl z ankety' } } }))).toBe('FORBIDDEN'); // nemá anketa.akce
    const id = await c.polls.create(c.admin, { title: 'Jaký stůl?', config: cfg, condition: only(a, b), results: 'always', action: { kind: 'useTemplate', requireConfirm: false, params: { name: 'Stůl z ankety' } } });
    await c.polls.vote(a, id, { type: 'single', option: 'o2' });
    await c.polls.vote(b, id, { type: 'single', option: 'o2' });
    const v = await c.polls.view(c.admin, id);
    expect(v.action).toMatchObject({ state: 'done' });
    expect((await c.server.tables.lobby()).some((t) => t.name === 'Stůl z ankety')).toBe(true);
  });
});
