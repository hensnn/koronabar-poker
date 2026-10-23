import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDefaultRegistry, resolveSettings } from '@kb/shared';
import { openPglite, schema, type Database } from '../db/index.js';
import { AccountError, AccountService, type AccountNotifier } from './accounts.js';
import { AuditService } from './audit.js';
import { sha256 } from './crypto.js';
import { PermissionError, PermissionService } from './permissions.js';
import { seedRoles } from './seed.js';

let database: Database | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});

const reg = createDefaultRegistry();

async function setup(over: Record<string, number | boolean | string> = {}) {
  database = await openPglite();
  const { db } = database;
  let t = new Date('2026-06-01T10:00:00Z');
  const now = () => t;
  const audit = new AuditService(db);
  const perms = new PermissionService(db, audit, now);
  await seedRoles(db, perms);
  const mails: { kind: string; to: string; vars: any }[] = [];
  const notifier: AccountNotifier = {
    verifyEmail: (to, vars) => void mails.push({ kind: 'verify', to, vars }),
    resetPassword: (to, vars) => void mails.push({ kind: 'reset', to, vars }),
    passwordChanged: (to, vars) => void mails.push({ kind: 'changed', to, vars }),
    emailChange: (to, vars) => void mails.push({ kind: 'emailChange', to, vars }),
    emailChangedNotice: (to, vars) => void mails.push({ kind: 'emailNotice', to, vars }),
    invite: (to, vars) => void mails.push({ kind: 'invite', to, vars }),
  };
  const activated: string[] = [];
  const settings = () => resolveSettings(reg, [{ scope: 'global', values: { 'system.passwordMinLength': 8, ...over } }]).values;
  const accounts = new AccountService({ db, audit, perms, settings, notifier, now, onActivated: (id) => void activated.push(id) });
  const admin = await accounts.ensureMainAdmin('Michal', 'tajneheslo123');
  const adminId = (await db.select().from(schema.users).where(eq(schema.users.nicknameLower, 'michal')))[0]!.id;
  const tokenFrom = (kind: string, idx = -1) => {
    const m = mails.filter((x) => x.kind === kind);
    const link: string = m.at(idx)!.vars.link;
    return new URL(link).searchParams.get('token')!;
  };
  return { db, audit, perms, accounts, mails, activated, adminId, admin, advance: (ms: number) => void (t = new Date(t.getTime() + ms)), tokenFrom, now };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AccountError || e instanceof PermissionError) return e.code;
    throw e;
  }
};
const reg1 = (code: string, n = 'Petr', over: Partial<Parameters<AccountService['register']>[0]> = {}) => ({
  inviteCode: code,
  nickname: n,
  email: `${n.toLowerCase()}@example.cz`,
  password: 'dlouhe-heslo-1',
  acceptTerms: true,
  ...over,
});

describe('první start a nouzová obnova', () => {
  it('vytvoří hlavního administrátora s vygenerovaným heslem, podruhé už ne', async () => {
    const s = await setup();
    expect(s.admin.created).toBe(true);
    expect(s.perms.isMainAdmin(s.adminId)).toBe(true);
    expect((await s.accounts.ensureMainAdmin('Jiny')).created).toBe(false);
    expect(s.activated).toContain(s.adminId);
  });

  it('nouzová obnova nastaví nové heslo a přidělí roli hlavního administrátora', async () => {
    const s = await setup();
    const [u] = await s.db.insert(schema.users).values({ nickname: 'Pepa', nicknameLower: 'pepa', passwordHash: 'x' }).returning({ id: schema.users.id });
    await s.perms.reload();
    await s.accounts.recoverAdmin('pepa', 'nove-heslo-123');
    expect(s.perms.isMainAdmin(u!.id)).toBe(true);
    expect((await s.accounts.login('pepa', 'nove-heslo-123')).user.nickname).toBe('Pepa');
    expect(await code(s.accounts.recoverAdmin('neexistuje', 'nove-heslo-123'))).toBe('NOT_FOUND');
    expect(await code(s.accounts.recoverAdmin('pepa', 'kratke'))).toBe('WEAK_PASSWORD');
  });
});

describe('pozvánky a registrace', () => {
  it('registrace jen s platnou pozvánkou; po ověření e-mailu se Nováček stane Hráčem', async () => {
    const s = await setup();
    const inv = await s.accounts.createInvite(s.adminId);
    const r = await s.accounts.register(reg1(inv));
    expect(r.needsVerification).toBe(true);
    expect(s.perms.can(r.userId, 'stul.hrat').allowed).toBe(false);
    expect(s.perms.can(r.userId, 'chat.psat').allowed).toBe(true);
    expect(s.activated).not.toContain(r.userId);
    expect(s.mails.filter((m) => m.kind === 'verify')).toHaveLength(1);
    expect(s.mails[0]!.to).toBe('petr@example.cz');
    await s.accounts.verifyEmail(s.tokenFrom('verify'));
    expect(s.perms.can(r.userId, 'stul.hrat').allowed).toBe(true);
    expect(s.activated).toContain(r.userId);
    expect(await code(s.accounts.verifyEmail(s.tokenFrom('verify')))).toBe('INVALID_TOKEN');
  });

  it('bez povinného ověření se hráč aktivuje hned', async () => {
    const s = await setup({ 'system.emailVerificationRequired': false });
    const r = await s.accounts.register(reg1(await s.accounts.createInvite(s.adminId)));
    expect(r.needsVerification).toBe(false);
    expect(s.perms.can(r.userId, 'stul.hrat').allowed).toBe(true);
    expect(s.activated).toContain(r.userId);
    expect(s.mails.filter((m) => m.kind === 'verify')).toHaveLength(0);
  });

  it('pozvánka s rolí dá pozvanému tuto roli po ověření', async () => {
    const s = await setup();
    const role = s.perms.roleByKey('moderator')!;
    const inv = await s.accounts.createInvite(s.adminId, { roleId: role.id });
    const r = await s.accounts.register(reg1(inv));
    await s.accounts.verifyEmail(s.tokenFrom('verify'));
    expect(s.perms.can(r.userId, 'chat.mazat_zpravy').allowed).toBe(true);
  });

  it('neplatné pozvánky: zrušená, prošlá, vyčerpaná, jiný e-mail, neexistující', async () => {
    const s = await setup();
    const revoked = await s.accounts.createInvite(s.adminId);
    await s.accounts.revokeInvite(s.adminId, revoked);
    const expired = await s.accounts.createInvite(s.adminId, { hours: 1 });
    const forMail = await s.accounts.createInvite(s.adminId, { email: 'jina@example.cz' });
    expect(await code(s.accounts.register(reg1(revoked)))).toBe('INVALID_INVITE');
    expect(await code(s.accounts.register(reg1(forMail)))).toBe('INVALID_INVITE');
    expect(await code(s.accounts.register(reg1('NEEXISTUJE1')))).toBe('INVALID_INVITE');
    const once = await s.accounts.createInvite(s.adminId);
    expect(await code(s.accounts.register(reg1(once)))).toBe('OK');
    expect(await code(s.accounts.register(reg1(once, 'Karel')))).toBe('INVALID_INVITE');
    s.advance(2 * 3600_000);
    expect(await code(s.accounts.register(reg1(expired, 'Jana')))).toBe('INVALID_INVITE');
  });

  it('souběžné použití jednorázové pozvánky projde jen jednou', async () => {
    const s = await setup();
    const inv = await s.accounts.createInvite(s.adminId);
    const results = await Promise.all(['Adam', 'Beata', 'Cyril'].map((n) => code(s.accounts.register(reg1(inv, n)))));
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r === 'INVALID_INVITE')).toHaveLength(2);
  });

  it('validace přezdívky, e-mailu, hesla, souhlasu s podmínkami a duplicit', async () => {
    const s = await setup();
    const inv = await s.accounts.createInvite(s.adminId, { maxUses: 20 });
    expect(await code(s.accounts.register(reg1(inv, 'a')))).toBe('INVALID_NICKNAME');
    expect(await code(s.accounts.register(reg1(inv, 'Špatná přezdívka!')))).toBe('INVALID_NICKNAME');
    expect(await code(s.accounts.register(reg1(inv, 'admin')))).toBe('INVALID_NICKNAME');
    expect(await code(s.accounts.register(reg1(inv, 'Dobra', { email: 'neni-email' })))).toBe('INVALID_EMAIL');
    expect(await code(s.accounts.register(reg1(inv, 'Dobra', { password: 'kratke' })))).toBe('WEAK_PASSWORD');
    expect(await code(s.accounts.register(reg1(inv, 'Dobra', { acceptTerms: false })))).toBe('TERMS_NOT_ACCEPTED');
    expect(await code(s.accounts.register(reg1(inv, 'Dobra')))).toBe('OK');
    expect(await code(s.accounts.register(reg1(inv, 'dobra', { email: 'jiny@example.cz' })))).toBe('NICKNAME_TAKEN');
    expect(await code(s.accounts.register(reg1(inv, 'Jina', { email: 'DOBRA@example.cz' })))).toBe('EMAIL_TAKEN');
    const [row] = await s.db.select().from(schema.users).where(eq(schema.users.nicknameLower, 'dobra'));
    expect(row!.termsAcceptedAt).not.toBeNull();
  });

  it('pozvánky smí vytvářet jen ten s oprávněním a jen s rolí, kterou smí přidělit', async () => {
    const s = await setup();
    const inv = await s.accounts.createInvite(s.adminId, { maxUses: 5 });
    const r = await s.accounts.register(reg1(inv));
    await s.accounts.verifyEmail(s.tokenFrom('verify'));
    expect(await code(s.accounts.createInvite(r.userId))).toBe('FORBIDDEN');
    const [adm] = await s.db.insert(schema.users).values({ nickname: 'Adm', nicknameLower: 'adm', passwordHash: 'x' }).returning({ id: schema.users.id });
    await s.perms.grantUnchecked(adm!.id, s.perms.roleByKey('admin')!.id);
    expect(await code(s.accounts.createInvite(adm!.id, { roleId: s.perms.roleByKey('admin')!.id }))).toBe('FORBIDDEN');
    expect(await code(s.accounts.createInvite(adm!.id, { roleId: s.perms.roleByKey('moderator')!.id }))).toBe('OK');
  });

  it('pozvánka e-mailem odešle kód a odkaz', async () => {
    const s = await setup();
    const code1 = await s.accounts.createInvite(s.adminId, { email: 'novy@example.cz' });
    const mail = s.mails.find((m) => m.kind === 'invite')!;
    expect(mail.to).toBe('novy@example.cz');
    expect(mail.vars.code).toBe(code1);
    expect(mail.vars.link).toContain(`kod=${code1}`);
  });
});

describe('přihlášení a relace', () => {
  async function user(s: Awaited<ReturnType<typeof setup>>, n = 'Petr') {
    const r = await s.accounts.register(reg1(await s.accounts.createInvite(s.adminId), n));
    await s.accounts.verifyEmail(s.tokenFrom('verify'));
    return r.userId;
  }

  it('přihlášení přezdívkou i e-mailem, relace jde ověřit a odhlásit', async () => {
    const s = await setup();
    const id = await user(s);
    const a = await s.accounts.login('PETR', 'dlouhe-heslo-1');
    const b = await s.accounts.login('petr@example.cz', 'dlouhe-heslo-1');
    expect((await s.accounts.authenticate(a.token))!.id).toBe(id);
    expect((await s.accounts.authenticate(b.token))!.id).toBe(id);
    expect(await s.accounts.authenticate('zly-token')).toBeNull();
    expect(await s.accounts.authenticate(undefined)).toBeNull();
    await s.accounts.logout(a.token);
    expect(await s.accounts.authenticate(a.token)).toBeNull();
    expect(await s.accounts.authenticate(b.token)).not.toBeNull();
  });

  it('token se do DB neukládá, jen jeho hash', async () => {
    const s = await setup();
    await user(s);
    const a = await s.accounts.login('petr', 'dlouhe-heslo-1');
    const rows = await s.db.select().from(schema.sessions);
    expect(rows.some((r) => r.tokenHash === a.token)).toBe(false);
    expect(rows.some((r) => r.tokenHash === sha256(a.token))).toBe(true);
    const tokens = await s.db.select().from(schema.emailTokens);
    for (const t of tokens) expect(t.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('relace vyprší podle nastavení', async () => {
    const s = await setup({ 'system.sessionDays': 2 });
    await user(s);
    const a = await s.accounts.login('petr', 'dlouhe-heslo-1');
    s.advance(86400_000);
    expect(await s.accounts.authenticate(a.token)).not.toBeNull();
    s.advance(2 * 86400_000);
    expect(await s.accounts.authenticate(a.token)).toBeNull();
  });

  it('špatné heslo i neexistující účet vrací stejnou chybu; po N pokusech se přihlášení zablokuje a po čase uvolní', async () => {
    const s = await setup({ 'system.loginMaxAttempts': 3, 'system.loginLockMinutes': 10 });
    await user(s);
    expect(await code(s.accounts.login('petr', 'spatne'))).toBe('INVALID_CREDENTIALS');
    expect(await code(s.accounts.login('nikdo', 'spatne'))).toBe('INVALID_CREDENTIALS');
    expect(await code(s.accounts.login('petr', 'spatne'))).toBe('INVALID_CREDENTIALS');
    expect(await code(s.accounts.login('petr', 'spatne'))).toBe('INVALID_CREDENTIALS');
    try {
      await s.accounts.login('petr', 'dlouhe-heslo-1');
      throw new Error('mělo být zamčeno');
    } catch (e) {
      expect((e as AccountError).code).toBe('LOCKED');
      expect((e as AccountError).params!.retryAfterSeconds).toBeGreaterThan(0);
    }
    s.advance(11 * 60_000);
    expect((await s.accounts.login('petr', 'dlouhe-heslo-1')).user.nickname).toBe('Petr');
  });

  it('zablokovaný uživatel se přihlásí (uvidí důvod), ale nemá oprávnění; blokace ho odhlásí', async () => {
    const s = await setup();
    const id = await user(s);
    const a = await s.accounts.login('petr', 'dlouhe-heslo-1');
    await s.accounts.blockUser(s.adminId, id, 'spam v chatu', new Date(s.now().getTime() + 3600_000));
    expect(await s.accounts.authenticate(a.token)).toBeNull();
    const again = await s.accounts.login('petr', 'dlouhe-heslo-1');
    expect(again.user.status).toBe('blocked');
    expect(again.user.blockedReason).toBe('spam v chatu');
    expect(s.perms.can(id, 'stul.zobrazit').allowed).toBe(false);
    await s.accounts.unblockUser(s.adminId, id);
    expect(s.perms.can(id, 'stul.zobrazit').allowed).toBe(true);
  });
});

describe('heslo a e-mail', () => {
  async function user(s: Awaited<ReturnType<typeof setup>>) {
    const r = await s.accounts.register(reg1(await s.accounts.createInvite(s.adminId)));
    await s.accounts.verifyEmail(s.tokenFrom('verify'));
    return r.userId;
  }

  it('změna hesla vyžaduje staré heslo, odhlásí ostatní relace a pošle upozornění', async () => {
    const s = await setup();
    const id = await user(s);
    const a = await s.accounts.login('petr', 'dlouhe-heslo-1');
    const b = await s.accounts.login('petr', 'dlouhe-heslo-1');
    expect(await code(s.accounts.changePassword(id, 'spatne-heslo', 'nove-heslo-123', a.token))).toBe('INVALID_CREDENTIALS');
    expect(await code(s.accounts.changePassword(id, 'dlouhe-heslo-1', 'kratke', a.token))).toBe('WEAK_PASSWORD');
    await s.accounts.changePassword(id, 'dlouhe-heslo-1', 'nove-heslo-123', a.token);
    expect(await s.accounts.authenticate(a.token)).not.toBeNull();
    expect(await s.accounts.authenticate(b.token)).toBeNull();
    expect(s.mails.some((m) => m.kind === 'changed')).toBe(true);
    expect(await code(s.accounts.login('petr', 'dlouhe-heslo-1'))).toBe('INVALID_CREDENTIALS');
    expect(await code(s.accounts.login('petr', 'nove-heslo-123'))).toBe('OK');
  });

  it('zapomenuté heslo: stejná odpověď pro existující i neexistující účet, token je jednorázový a vyprší', async () => {
    const s = await setup({ 'system.resetLinkHours': 1 });
    await user(s);
    const before = s.mails.length;
    await s.accounts.requestPasswordReset('neexistuje');
    expect(s.mails.length).toBe(before);
    await s.accounts.requestPasswordReset('petr@example.cz');
    expect(s.mails.length).toBe(before + 1);
    const token = s.tokenFrom('reset');
    const session = await s.accounts.login('petr', 'dlouhe-heslo-1');
    await s.accounts.resetPassword(token, 'uplne-nove-heslo');
    expect(await s.accounts.authenticate(session.token)).toBeNull();
    expect(await code(s.accounts.login('petr', 'dlouhe-heslo-1'))).toBe('INVALID_CREDENTIALS');
    expect(await code(s.accounts.login('petr', 'uplne-nove-heslo'))).toBe('OK');
    expect(await code(s.accounts.resetPassword(token, 'dalsi-heslo-123'))).toBe('INVALID_TOKEN');
    await s.accounts.requestPasswordReset('petr');
    s.advance(2 * 3600_000);
    expect(await code(s.accounts.resetPassword(s.tokenFrom('reset'), 'dalsi-heslo-123'))).toBe('INVALID_TOKEN');
  });

  it('žádosti o obnovu hesla jsou omezené počtem za hodinu', async () => {
    const s = await setup({ 'system.mailRequestsPerHour': 2 });
    await user(s);
    const before = s.mails.filter((m) => m.kind === 'reset').length;
    for (let i = 0; i < 5; i++) await s.accounts.requestPasswordReset('petr', { ip: '1.2.3.4' });
    expect(s.mails.filter((m) => m.kind === 'reset').length - before).toBe(2);
  });

  it('změna e-mailu: nová adresa se ověří, na starou přijde upozornění', async () => {
    const s = await setup();
    const id = await user(s);
    expect(await code(s.accounts.requestEmailChange(id, 'spatne', 'novy@example.cz'))).toBe('INVALID_CREDENTIALS');
    expect(await code(s.accounts.requestEmailChange(id, 'dlouhe-heslo-1', 'neni-email'))).toBe('INVALID_EMAIL');
    await s.accounts.requestEmailChange(id, 'dlouhe-heslo-1', 'novy@example.cz');
    const mail = s.mails.find((m) => m.kind === 'emailChange')!;
    expect(mail.to).toBe('novy@example.cz');
    await s.accounts.confirmEmailChange(s.tokenFrom('emailChange'));
    const [u] = await s.db.select().from(schema.users).where(eq(schema.users.id, id));
    expect(u!.email).toBe('novy@example.cz');
    const notice = s.mails.find((m) => m.kind === 'emailNotice')!;
    expect(notice.to).toBe('petr@example.cz');
    expect(await code(s.accounts.login('novy@example.cz', 'dlouhe-heslo-1'))).toBe('OK');
  });
});

describe('správa uživatelů', () => {
  it('nelze zablokovat uživatele se stejnou silou ani posledního hlavního administrátora', async () => {
    const s = await setup();
    expect(await code(s.accounts.blockUser(s.adminId, s.adminId, 'x', null))).toBe('LAST_MAIN_ADMIN');
    const [a1, a2] = await Promise.all(
      ['Adm1', 'Adm2'].map(async (n) => {
        const [u] = await s.db.insert(schema.users).values({ nickname: n, nicknameLower: n.toLowerCase(), passwordHash: 'x' }).returning({ id: schema.users.id });
        await s.perms.grantUnchecked(u!.id, s.perms.roleByKey('admin')!.id);
        return u!.id;
      }),
    );
    expect(await code(s.accounts.blockUser(a1!, a2!, 'x', null))).toBe('HIERARCHY');
    expect(await code(s.accounts.blockUser(s.adminId, a2!, 'x', null))).toBe('OK');
    expect(await code(s.accounts.blockUser(a2!, s.adminId, 'x', null))).toBe('FORBIDDEN');
  });

  it('vynucená změna hesla odhlásí uživatele a staré heslo přestane platit; audit eviduje akce', async () => {
    const s = await setup();
    const r = await s.accounts.register(reg1(await s.accounts.createInvite(s.adminId)));
    await s.accounts.verifyEmail(s.tokenFrom('verify'));
    const sess = await s.accounts.login('petr', 'dlouhe-heslo-1');
    await s.accounts.forcePasswordChange(s.adminId, r.userId);
    expect(await s.accounts.authenticate(sess.token)).toBeNull();
    expect(await code(s.accounts.login('petr', 'dlouhe-heslo-1'))).toBe('INVALID_CREDENTIALS');
    const actions = (await s.audit.list({ limit: 200 })).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['ucet.registrace', 'ucet.overeni_emailu', 'ucet.prihlaseni', 'uzivatel.vynutit_zmenu_hesla', 'pozvanka.vytvorit']));
  });

  it('ruční ověření e-mailu adminem povýší Nováčka', async () => {
    const s = await setup();
    const r = await s.accounts.register(reg1(await s.accounts.createInvite(s.adminId)));
    expect(s.perms.can(r.userId, 'stul.hrat').allowed).toBe(false);
    await s.accounts.markEmailVerified(s.adminId, r.userId);
    expect(s.perms.can(r.userId, 'stul.hrat').allowed).toBe(true);
  });

  it('seznam uživatelů vyžaduje oprávnění', async () => {
    const s = await setup();
    const r = await s.accounts.register(reg1(await s.accounts.createInvite(s.adminId)));
    expect(await code(s.accounts.listUsers(r.userId))).toBe('FORBIDDEN');
    const list = await s.accounts.listUsers(s.adminId);
    expect(list.map((u) => u.nickname).sort()).toEqual(['Michal', 'Petr']);
    expect(list.find((u) => u.nickname === 'Michal')!.roles[0]!.role).toBe('Hlavní administrátor');
  });
});

describe('časové limity pozvánek a ověřovacích odkazů', () => {
  it('výchozí platnost pozvánky a platnost ověřovacího odkazu se řídí nastavením v hodinách', async () => {
    const s = await setup({ 'system.inviteDefaultHours': 3, 'system.verifyLinkHours': 5 });
    const inv = await s.accounts.createInvite(s.adminId);
    const [row] = await s.db.select().from(schema.invites).where(eq(schema.invites.code, inv));
    expect(row!.expiresAt!.getTime() - s.now().getTime()).toBe(3 * 3600_000);
    await s.accounts.register(reg1(inv));
    expect(s.mails.find((m) => m.kind === 'verify')!.vars.hours).toBe(5);
    const [tok] = await s.db.select().from(schema.emailTokens);
    expect(tok!.expiresAt.getTime() - s.now().getTime()).toBe(5 * 3600_000);
    s.advance(6 * 3600_000);
    expect(await code(s.accounts.verifyEmail(s.tokenFrom('verify')))).toBe('INVALID_TOKEN');
  });
});
