import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDefaultRegistry, resolveSettings, t } from '@kb/shared';
import { openPglite, schema, type Database } from '../db/index.js';
import { AuditService } from '../auth/audit.js';
import { PermissionService } from '../auth/permissions.js';
import { seedRoles } from '../auth/seed.js';
import { SecretStore } from '../secrets/store.js';
import { EmailService, fillTemplate, translateSmtpError, unknownVariables, type MailMessage, type MailTransport } from './service.js';

let database: Database | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});
const reg = createDefaultRegistry();

async function setup(over: Record<string, number | boolean | string> = {}) {
  database = await openPglite();
  const { db } = database;
  let clock = new Date('2026-04-01T10:00:00Z');
  const audit = new AuditService(db);
  const perms = new PermissionService(db, audit, () => clock);
  await seedRoles(db, perms);
  const [u] = await db.insert(schema.users).values({ nickname: 'Main', nicknameLower: 'main', passwordHash: 'x' }).returning({ id: schema.users.id });
  await perms.grantUnchecked(u!.id, perms.roleByKey('main_admin')!.id);
  const [h] = await db.insert(schema.users).values({ nickname: 'Hrac', nicknameLower: 'hrac', passwordHash: 'x' }).returning({ id: schema.users.id });
  await perms.grantUnchecked(h!.id, perms.roleByKey('hrac')!.id);
  const secrets = new SecretStore(db, audit, perms, { key: randomBytes(32), version: 1 });
  const sent: MailMessage[] = [];
  const failure: { error?: unknown; times: number } = { times: 0 };
  const transport: MailTransport = {
    send: async (m) => {
      if (failure.times > 0) {
        failure.times--;
        throw failure.error;
      }
      sent.push(m);
    },
  };
  const settings = () => resolveSettings(reg, [{ scope: 'global', values: { 'email.dailyLimit': 400, ...over } }]).values;
  const email = new EmailService({ db, audit, perms, secrets, settings, now: () => clock, transport: () => transport });
  await secrets.set(u!.id, 'smtp.password', 'heslo-aplikace-abcd');
  return { db, email, secrets, sent, failure, admin: u!.id, hrac: h!.id, advance: (ms: number) => void (clock = new Date(clock.getTime() + ms)) };
}

describe('šablony', () => {
  it('dosazení proměnných, escapování v HTML, kontrola neznámých proměnných', () => {
    expect(fillTemplate('Ahoj {prezdivka}, {nic}', { prezdivka: 'Petr' })).toBe('Ahoj Petr, {nic}');
    expect(fillTemplate('<b>{x}</b>', { x: '<script>&' }, true)).toBe('<b>&lt;script&gt;&amp;</b>');
    expect(unknownVariables('{prezdivka} {odkaz} {hacker}', ['prezdivka', 'odkaz'])).toEqual(['hacker']);
  });

  it('výchozí šablony se vykreslí česky; vlastní úprava se uloží a jde vrátit na výchozí', async () => {
    const s = await setup();
    const r = await s.email.render('overeni_emailu', { prezdivka: 'Petr', odkaz: 'https://x.cz/a?token=1', platnost: 48 });
    expect(r.subject).toBe('Ověření e-mailu – KoronaBar Poker');
    expect(r.text).toContain('Ahoj Petr');
    expect(r.html).toContain('<a href="https://x.cz/a?token=1">');
    expect((await s.email.saveTemplate(s.admin, 'overeni_emailu', { subject: 'Vítej, {prezdivka}', bodyText: 'Klikni: {odkaz}' })).unknown).toEqual([]);
    expect((await s.email.render('overeni_emailu', { prezdivka: 'Petr', odkaz: 'L' })).subject).toBe('Vítej, Petr');
    expect((await s.email.saveTemplate(s.admin, 'overeni_emailu', { subject: 'x', bodyText: '{neznama}' })).unknown).toEqual(['neznama']);
    await expect(s.email.saveTemplate(s.hrac, 'overeni_emailu', { subject: 'x', bodyText: 'y' })).rejects.toThrow('FORBIDDEN');
    await s.email.resetTemplate(s.admin, 'overeni_emailu');
    expect((await s.email.template('overeni_emailu')).custom).toBe(false);
  });

  it('náhled bez uložení', async () => {
    const s = await setup();
    const r = await s.email.render('zmena_hesla', { prezdivka: 'Eva' }, { subject: 'Test {prezdivka}', bodyText: 'Text {prezdivka}' });
    expect(r.subject).toBe('Test Eva');
    expect((await s.email.template('zmena_hesla')).custom).toBe(false);
  });
});

describe('fronta e-mailů', () => {
  it('zprávy se odešlou přes SMTP z nastavené adresy a označí jako odeslané', async () => {
    const s = await setup();
    await s.email.enqueue('overeni_emailu', 'petr@example.cz', { prezdivka: 'Petr', odkaz: 'https://x.cz', platnost: 48 });
    const r = await s.email.processQueue();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(s.sent[0]).toMatchObject({ to: 'petr@example.cz', from: '"KoronaBar Poker" <poker@example.cz>' });
    expect((await s.email.stats()).sent).toBe(1);
    expect(await s.email.processQueue()).toMatchObject({ sent: 0 });
  });

  it('bez nastaveného SMTP (chybí heslo) aplikace funguje dál a zprávy čekají', async () => {
    const s = await setup();
    await s.secrets.delete(s.admin, 'smtp.password');
    await s.email.enqueue('zmena_hesla', 'a@example.cz', { prezdivka: 'A' });
    expect(await s.email.processQueue()).toMatchObject({ skipped: true });
    expect((await s.email.stats()).pending).toBe(1);
    await s.secrets.set(s.admin, 'smtp.password', 'nove-heslo-xyz1');
    expect((await s.email.processQueue()).sent).toBe(1);
  });

  it('vypnuté odesílání nic neposílá', async () => {
    const s = await setup({ 'email.enabled': false });
    await s.email.enqueue('zmena_hesla', 'a@example.cz', { prezdivka: 'A' });
    expect((await s.email.processQueue()).skipped).toBe(true);
    expect(s.sent).toHaveLength(0);
  });

  it('chyba odeslání: opakování s prodlevou, po vyčerpání pokusů trvalá chyba s českou hláškou', async () => {
    const s = await setup({ 'email.maxAttempts': 3 });
    s.failure.error = Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 });
    s.failure.times = 99;
    const id = await s.email.enqueue('zmena_hesla', 'a@example.cz', { prezdivka: 'A' });
    await s.email.processQueue();
    let [row] = await s.db.select().from(schema.emailQueue).where(eq(schema.emailQueue.id, id));
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row!.lastError).toMatch(/^email\.error\.auth\|/);
    // dřív než uplyne prodleva se nic neděje
    await s.email.processQueue();
    [row] = await s.db.select().from(schema.emailQueue).where(eq(schema.emailQueue.id, id));
    expect(row!.attempts).toBe(1);
    s.advance(2 * 60_000);
    await s.email.processQueue();
    s.advance(60 * 60_000);
    const last = await s.email.processQueue();
    [row] = await s.db.select().from(schema.emailQueue).where(eq(schema.emailQueue.id, id));
    expect(row).toMatchObject({ status: 'failed', attempts: 3 });
    expect(last.failed).toBe(1);
    expect(t('email.error.auth')).toMatch(/heslo aplikace/);
  });

  it('po přechodné chybě se zpráva nakonec odešle', async () => {
    const s = await setup();
    s.failure.error = Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
    s.failure.times = 1;
    await s.email.enqueue('zmena_hesla', 'a@example.cz', { prezdivka: 'A' });
    await s.email.processQueue();
    expect(s.sent).toHaveLength(0);
    s.advance(2 * 60_000);
    expect((await s.email.processQueue()).sent).toBe(1);
  });

  it('denní limit: nepovinné e-maily se odloží, bezpečnostní se odešlou vždy', async () => {
    const s = await setup({ 'email.dailyLimit': 2 });
    for (let i = 0; i < 3; i++) await s.email.enqueue('pozvanka', `p${i}@example.cz`, { kod: 'K', odkaz: 'L', zvouci: 'Z' });
    const first = await s.email.processQueue();
    expect(first).toMatchObject({ sent: 2, deferred: 1 });
    await s.email.enqueue('obnova_hesla', 'sec@example.cz', { prezdivka: 'S', odkaz: 'L', platnost: 1 });
    const second = await s.email.processQueue();
    expect(second.sent).toBe(1);
    expect(s.sent.at(-1)!.to).toBe('sec@example.cz');
    s.advance(25 * 3600_000);
    expect((await s.email.processQueue()).sent).toBe(1);
    expect(s.sent.map((m) => m.to)).toContain('p2@example.cz');
  });

  it('bezpečnostní zprávy se zpracují před ostatními', async () => {
    const s = await setup();
    await s.email.enqueue('pozvanka', 'normal@example.cz', { kod: 'K', odkaz: 'L', zvouci: 'Z' });
    await s.email.enqueue('obnova_hesla', 'sec@example.cz', { prezdivka: 'S', odkaz: 'L', platnost: 1 });
    await s.email.processQueue();
    expect(s.sent.map((m) => m.to)).toEqual(['sec@example.cz', 'normal@example.cz']);
  });

  it('seznam fronty vyžaduje oprávnění; notifikátor účtů vytvoří správné zprávy', async () => {
    const s = await setup();
    s.email.notifier().verifyEmail('novy@example.cz', { nickname: 'Novy', link: 'https://x.cz/ov?token=abc', hours: 48 });
    s.email.notifier().invite('p@example.cz', { code: 'ABC', link: 'https://x.cz/r', inviter: 'Michal' });
    await new Promise((r) => setTimeout(r, 200));
    await expect(s.email.list(s.hrac)).rejects.toThrow('FORBIDDEN');
    const rows = await s.email.list(s.admin);
    expect(rows.map((r) => r.kind).sort()).toEqual(['overeni_emailu', 'pozvanka']);
    expect(rows.find((r) => r.kind === 'overeni_emailu')!.bodyText).toContain('https://x.cz/ov?token=abc');
    expect(rows.find((r) => r.kind === 'overeni_emailu')!.priority).toBe('security');
    expect(rows.find((r) => r.kind === 'pozvanka')!.priority).toBe('normal');
  });
});

describe('testovací e-mail a hlášky chyb', () => {
  it('testovací e-mail odešle hned; výsledek je srozumitelný', async () => {
    const s = await setup();
    expect(await s.email.sendTest(s.admin, 'ja@example.cz')).toEqual({ ok: true });
    expect(s.sent[0]!.subject).toMatch(/Zkušební/);
    s.failure.error = Object.assign(new Error('Invalid login: 535'), { code: 'EAUTH', responseCode: 535 });
    s.failure.times = 1;
    const bad = await s.email.sendTest(s.admin, 'ja@example.cz');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(t(bad.error.key, bad.error.params)).toMatch(/heslo aplikace/);
    await expect(s.email.sendTest(s.hrac, 'x@example.cz')).rejects.toThrow('FORBIDDEN');
    await s.secrets.delete(s.admin, 'smtp.password');
    const none = await s.email.sendTest(s.admin, 'ja@example.cz');
    expect(none).toMatchObject({ ok: false, error: { key: 'email.error.notConfigured' } });
  });

  it('překlad chyb SMTP', () => {
    expect(translateSmtpError({ code: 'EAUTH' }).key).toBe('email.error.auth');
    expect(translateSmtpError({ responseCode: 535 }).key).toBe('email.error.auth');
    expect(translateSmtpError({ code: 'ENOTFOUND' }, { host: 'smtp.x.cz', port: 587 })).toMatchObject({ key: 'email.error.connect', params: { host: 'smtp.x.cz', port: 587 } });
    expect(t('email.error.connect', { host: 'smtp.x.cz', port: 587 })).toContain('smtp.x.cz:587');
    expect(translateSmtpError(new Error('wrong version number')).key).toBe('email.error.tls');
    expect(translateSmtpError({ responseCode: 553 }).key).toBe('email.error.rejected');
    expect(translateSmtpError({ responseCode: 421 }).key).toBe('email.error.limit');
    expect(translateSmtpError(new Error('???')).key).toBe('email.error.unknown');
  });
});

describe('pravidla odesílání (správce)', () => {
  const kinds = async (s: Awaited<ReturnType<typeof setup>>) => {
    const rows = await s.db.select().from(schema.emailQueue);
    return rows.map((r) => `${r.kind}:${r.status}:${r.lastError ?? ''}`);
  };
  const vars = { prezdivka: 'X', platnost: 1, odkaz: 'https://x.cz', turnaj: 'T', udalost: 'u', text: 't', souhrn: 's', akce: 'a', vysledek: 'v', druh: 'd', poznamka: '', kod: 'k', zvouci: 'z', novy_email: 'n@example.cz' };

  it('vypnuté odesílání nepošle nic, ani bezpečnostní zprávy; zápis zůstane jako přeskočený', async () => {
    const s = await setup({ 'email.enabled': false });
    await s.email.enqueue('zmena_hesla', 'a@example.cz', vars);
    await s.email.enqueue('turnaj_upozorneni', 'a@example.cz', vars);
    expect(await kinds(s)).toEqual(['zmena_hesla:skipped:email.skip.disabled', 'turnaj_upozorneni:skipped:email.skip.disabled']);
    await s.email.processQueue();
    expect(s.sent).toHaveLength(0);
  });

  it('vypnutý druh zpráv se neposílá, bezpečnostní druh vypnout nejde', async () => {
    const s = await setup({ 'email.disabledKinds': 'turnaj_upozorneni, zmena_hesla' });
    await s.email.enqueue('turnaj_upozorneni', 'a@example.cz', vars);
    await s.email.enqueue('vecer_souhrn', 'a@example.cz', vars);
    await s.email.enqueue('zmena_hesla', 'a@example.cz', vars);
    expect(await kinds(s)).toEqual(['turnaj_upozorneni:skipped:email.skip.kind', 'vecer_souhrn:pending:', 'zmena_hesla:pending:']);
  });

  it('příjemci: jen s ověřeným e-mailem', async () => {
    const s = await setup({ 'email.recipientMode': 'verified' });
    await s.db.update(schema.users).set({ email: 'overeny@example.cz', emailVerifiedAt: new Date() }).where(eq(schema.users.id, s.hrac));
    await s.email.enqueue('vecer_souhrn', 'overeny@example.cz', vars);
    await s.email.enqueue('vecer_souhrn', 'cizi@example.cz', vars);
    expect(await kinds(s)).toEqual(['vecer_souhrn:pending:', 'vecer_souhrn:skipped:email.skip.notVerified']);
  });

  it('příjemci: jen vybrané role', async () => {
    const s = await setup({ 'email.recipientMode': 'roles', 'email.recipientRoles': 'organizator' });
    await s.db.update(schema.users).set({ email: 'hrac@example.cz', emailVerifiedAt: new Date() }).where(eq(schema.users.id, s.hrac));
    await s.email.enqueue('vecer_souhrn', 'hrac@example.cz', vars);
    expect(await kinds(s)).toEqual(['vecer_souhrn:skipped:email.skip.role']);
    const s2 = await setup({ 'email.recipientMode': 'roles', 'email.recipientRoles': 'hrac' });
    await s2.db.update(schema.users).set({ email: 'hrac@example.cz', emailVerifiedAt: new Date() }).where(eq(schema.users.id, s2.hrac));
    await s2.email.enqueue('vecer_souhrn', 'hrac@example.cz', vars);
    expect(await kinds(s2)).toEqual(['vecer_souhrn:pending:']);
  });

  it('příjemci: jen adresy a domény ze seznamu; blokace platí i pro bezpečnostní zprávy', async () => {
    const s = await setup({ 'email.recipientMode': 'list', 'email.recipientList': 'jan@example.cz; @firma.cz', 'email.blockList': 'spam@firma.cz' });
    for (const to of ['jan@example.cz', 'eva@firma.cz', 'eva@pobocka.firma.cz', 'nikdo@example.cz', 'spam@firma.cz']) await s.email.enqueue('vecer_souhrn', to, vars);
    await s.email.enqueue('zmena_hesla', 'spam@firma.cz', vars);
    await s.email.enqueue('zmena_hesla', 'nikdo@example.cz', vars);
    expect(await kinds(s)).toEqual([
      'vecer_souhrn:pending:',
      'vecer_souhrn:pending:',
      'vecer_souhrn:pending:',
      'vecer_souhrn:skipped:email.skip.notListed',
      'vecer_souhrn:skipped:email.skip.blocked',
      'zmena_hesla:skipped:email.skip.blocked',
      'zmena_hesla:pending:',
    ]);
  });

  it('osobní vypnutí hráče platí jen, když ho správce dovolil', async () => {
    const s = await setup();
    await s.email.enqueue('vecer_souhrn', 'a@example.cz', vars, { userOptedOut: true });
    const s2 = await setup({ 'email.allowUserOptOut': false });
    await s2.email.enqueue('vecer_souhrn', 'a@example.cz', vars, { userOptedOut: true });
    expect(await kinds(s)).toEqual(['vecer_souhrn:skipped:email.skip.userOptOut']);
    expect(await kinds(s2)).toEqual(['vecer_souhrn:pending:']);
  });
});
