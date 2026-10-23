import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(global: Record<string, number | boolean | string> = {}) {
  const mails: { kind: string; to: string; vars: any }[] = [];
  const server = await buildServer({
    settingsOverride: { 'system.publicUrl': 'http://localhost', 'system.emailVerificationRequired': true, ...global },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
    notifier: {
      verifyEmail: (to, vars) => void mails.push({ kind: 'verify', to, vars }),
      resetPassword: (to, vars) => void mails.push({ kind: 'reset', to, vars }),
      passwordChanged: (to, vars) => void mails.push({ kind: 'changed', to, vars }),
      emailChange: (to, vars) => void mails.push({ kind: 'emailChange', to, vars }),
      emailChangedNotice: (to, vars) => void mails.push({ kind: 'notice', to, vars }),
      invite: (to, vars) => void mails.push({ kind: 'invite', to, vars }),
    },
  });
  servers.push(server);
  return { server, mails };
}

/** Klient s cookie jar nad `app.inject`. */
function http(server: Server, origin = 'http://localhost') {
  let cookie = '';
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await server.app.inject({
      method: method as 'GET',
      url,
      payload: body === undefined ? undefined : (body as object),
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin } : {}) },
    });
    const set = res.headers['set-cookie'];
    const raw = Array.isArray(set) ? set[0] : set;
    if (raw) cookie = raw.startsWith('kb_session=;') ? '' : raw.split(';')[0]!;
    const text = res.body;
    return { status: res.statusCode, json: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  return { call, get cookie() { return cookie; } };
}

async function login(server: Server, nick: string, password: string) {
  const c = http(server);
  const r = await c.call('POST', '/api/auth/login', { identifier: nick, password });
  return { c, r };
}

describe('HTTP API: účty', () => {
  it('registrace s pozvánkou, ověření e-mailu, přihlášení a /me', async () => {
    const { server, mails } = await start();
    const admin = await login(server, 'Admin', 'admin-heslo-123');
    expect(admin.r.status).toBe(200);
    expect(admin.r.json.mainAdmin).toBe(true);
    expect(admin.r.json.permissions.length).toBeGreaterThan(50);
    const inv = (await admin.c.call('POST', '/api/admin/invites', { maxUses: 1 })).json.code as string;

    const anon = http(server);
    expect((await anon.call('GET', '/api/public/terms')).json.text).toMatch(/nemá žádnou peněžní hodnotu/);
    const reg = await anon.call('POST', '/api/auth/register', { inviteCode: inv, nickname: 'Petr', email: 'petr@example.cz', password: 'dlouhe-heslo-1', acceptTerms: true });
    expect(reg.status).toBe(200);
    expect(reg.json.needsVerification).toBe(true);
    const token = new URL(mails.find((m) => m.kind === 'verify')!.vars.link).searchParams.get('token');
    expect((await anon.call('POST', '/api/auth/verify-email', { token })).status).toBe(200);

    const l = await anon.call('POST', '/api/auth/login', { identifier: 'petr@example.cz', password: 'dlouhe-heslo-1' });
    expect(l.status).toBe(200);
    const sc = String(l.headers['set-cookie']);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Lax');
    const me = await anon.call('GET', '/api/auth/me');
    expect(me.json.user.nickname).toBe('Petr');
    expect(me.json.balance).toBe(10_000);
    expect(me.json.permissions).toContain('stul.hrat');
    expect(me.json.permissions).not.toContain('role.vytvorit');
    expect(JSON.stringify(me.json)).not.toContain('passwordHash');
  });

  it('chyby mají kód a správný stav; všechny odpovědi bez relace jsou 401', async () => {
    const { server } = await start();
    const anon = http(server);
    expect((await anon.call('GET', '/api/auth/me')).status).toBe(401);
    expect((await anon.call('GET', '/api/admin/users')).status).toBe(401);
    expect((await anon.call('POST', '/api/auth/login', { identifier: 'Admin', password: 'spatne' })).json.code).toBe('INVALID_CREDENTIALS');
    expect((await anon.call('POST', '/api/auth/login', {})).json.code).toBe('INVALID_INPUT');
    const r = await anon.call('POST', '/api/auth/register', { inviteCode: 'NEEXISTUJE', nickname: 'Petr', email: 'p@example.cz', password: 'dlouhe-heslo-1', acceptTerms: true });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('INVALID_INVITE');
  });

  it('ochrana CSRF: změna stavu z cizího původu se odmítne', async () => {
    const { server } = await start();
    const evil = http(server, 'https://evil.example');
    const r = await evil.call('POST', '/api/auth/login', { identifier: 'Admin', password: 'admin-heslo-123' });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('FORBIDDEN_ORIGIN');
    expect(evil.cookie).toBe('');
  });

  it('odhlášení zruší relaci; zapomenuté heslo odpoví vždy stejně', async () => {
    const { server, mails } = await start();
    const { c } = await login(server, 'Admin', 'admin-heslo-123');
    expect((await c.call('POST', '/api/auth/logout')).status).toBe(200);
    expect((await c.call('GET', '/api/auth/me')).status).toBe(401);
    const a = await http(server).call('POST', '/api/auth/forgot', { identifier: 'neexistuje' });
    const b = await http(server).call('POST', '/api/auth/forgot', { identifier: 'Admin' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.json).toEqual(b.json);
    expect(mails.filter((m) => m.kind === 'reset')).toHaveLength(0); // admin nemá e-mail
  });

  it('změna hesla přes API odhlásí ostatní relace', async () => {
    const { server } = await start();
    const one = (await login(server, 'Admin', 'admin-heslo-123')).c;
    const two = (await login(server, 'Admin', 'admin-heslo-123')).c;
    expect((await one.call('POST', '/api/auth/change-password', { current: 'admin-heslo-123', next: 'nove-heslo-1234' })).status).toBe(200);
    expect((await one.call('GET', '/api/auth/me')).status).toBe(200);
    expect((await two.call('GET', '/api/auth/me')).status).toBe(401);
  });
});

describe('HTTP API: správa', () => {
  async function seeded() {
    const s = await start({ 'system.emailVerificationRequired': false });
    const admin = (await login(s.server, 'Admin', 'admin-heslo-123')).c;
    const mk = async (nick: string, role?: string) => {
      const code = (await admin.call('POST', '/api/admin/invites', {})).json.code;
      const c = http(s.server);
      const reg = await c.call('POST', '/api/auth/register', { inviteCode: code, nickname: nick, email: `${nick.toLowerCase()}@example.cz`, password: 'dlouhe-heslo-1', acceptTerms: true });
      await c.call('POST', '/api/auth/login', { identifier: nick, password: 'dlouhe-heslo-1' });
      if (role) {
        const roles = (await admin.call('GET', '/api/admin/roles')).json as { id: string; key: string }[];
        await admin.call('POST', '/api/admin/assignments', { userId: reg.json.userId, roleId: roles.find((r) => r.key === role)!.id });
      }
      return { c, id: reg.json.userId as string };
    };
    return { ...s, admin, mk };
  }

  it('nepřihlášený nevidí seznam stolů ani struktury blindů (401), přihlášený ano', async () => {
    const { server, admin } = await seeded();
    const anon = http(server);
    for (const url of ['/api/tables', '/api/structures']) {
      expect((await anon.call('GET', url)).status, url).toBe(401);
      expect((await admin.call('GET', url)).status, url).toBe(200);
    }
  });

  it('běžný hráč nemá přístup ke správě (403), administrátor ano', async () => {
    const { admin, mk } = await seeded();
    const hrac = await mk('Hrac');
    for (const url of ['/api/admin/users', '/api/admin/roles', '/api/admin/audit', '/api/admin/invites']) {
      expect((await hrac.c.call('GET', url)).status, url).toBe(403);
      expect((await admin.call('GET', url)).status, url).toBe(200);
    }
    expect((await hrac.c.call('POST', '/api/admin/invites', {})).status).toBe(403);
    expect((await hrac.c.call('PUT', '/api/settings/global', { key: 'economy.startingBalance', value: 1 })).status).toBe(403);
  });

  it('role: vytvoření, úprava, přidělení, hierarchie a smazání přes API', async () => {
    const { admin, mk } = await seeded();
    const hrac = await mk('Hrac');
    const created = await admin.call('POST', '/api/admin/roles', { key: 'vip', name: 'VIP', power: 20, permissions: [{ key: 'stul.hrat' }, { key: 'chat.psat' }] });
    expect(created.status).toBe(200);
    const roleId = created.json.id as string;
    expect((await admin.call('PATCH', `/api/admin/roles/${roleId}`, { name: 'VIP hráč' })).status).toBe(200);
    const assign = await admin.call('POST', '/api/admin/assignments', { userId: hrac.id, roleId, validTo: '2999-01-01T00:00:00Z' });
    expect(assign.status).toBe(200);
    expect((await admin.call('DELETE', `/api/admin/roles/${roleId}`)).json.code).toBe('ROLE_IN_USE');
    expect((await admin.call('DELETE', `/api/admin/assignments/${assign.json.id}`)).status).toBe(200);
    expect((await admin.call('DELETE', `/api/admin/roles/${roleId}`)).status).toBe(200);
    // role se silou vyšší než 100 nebo neplatná oprávnění
    expect((await admin.call('POST', '/api/admin/roles', { key: 'zly', name: 'Zlý', power: 500, permissions: [] })).json.code).toBe('INVALID');
    expect((await admin.call('POST', '/api/admin/roles', { key: 'zly2', name: 'Zlý', power: 5, permissions: [{ key: 'neexistuje' }] })).json.code).toBe('INVALID');
    const roles = (await admin.call('GET', '/api/admin/roles')).json as { id: string; key: string; isLocked: boolean }[];
    const main = roles.find((r) => r.isLocked)!;
    expect((await admin.call('PATCH', `/api/admin/roles/${main.id}`, { name: 'x' })).json.code).toBe('LOCKED_ROLE');
    expect((await admin.call('DELETE', `/api/admin/roles/${main.id}`)).json.code).toBe('LOCKED_ROLE');
  });

  it('pozvánky, blokace uživatele a audit log přes API', async () => {
    const { admin, mk } = await seeded();
    const hrac = await mk('Hrac');
    expect((await admin.call('POST', `/api/admin/users/${hrac.id}/block`, { reason: 'spam', until: null })).status).toBe(200);
    expect((await hrac.c.call('GET', '/api/auth/me')).status).toBe(401);
    expect((await admin.call('POST', `/api/admin/users/${hrac.id}/unblock`, {})).status).toBe(200);
    const users = (await admin.call('GET', '/api/admin/users')).json as { nickname: string; status: string }[];
    expect(users.find((u) => u.nickname === 'Hrac')!.status).toBe('active');
    const audit = (await admin.call('GET', '/api/admin/audit?limit=50')).json as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['uzivatel.blokovat', 'uzivatel.odblokovat', 'pozvanka.vytvorit']));
    expect((await admin.call('POST', `/api/admin/users/neni-uuid/block`, { reason: 'x' })).json.code).toBe('INVALID_INPUT');
  });

  it('osobní nastavení hráče se ukládá na server (a jen jemu), s přepsáním pro zařízení', async () => {
    const { mk } = await seeded();
    const a = await mk('Alice');
    const b = await mk('Bob');
    expect((await a.c.call('PUT', '/api/me/settings', { key: 'ui.colorMode', value: 'dark' })).status).toBe(200);
    expect((await a.c.call('PUT', '/api/me/settings', { key: 'ui.sfxVolumePercent', value: 20, device: 'mobil' })).status).toBe(200);
    const mine = (await a.c.call('GET', '/api/me/settings?device=mobil')).json;
    expect(mine.user['ui.colorMode']).toBe('dark');
    expect(mine.device['ui.sfxVolumePercent']).toBe(20);
    expect((await b.c.call('GET', '/api/me/settings')).json.user).toEqual({});
    // herní parametr do osobní vrstvy nepatří, neplatná hodnota se odmítne
    expect((await a.c.call('PUT', '/api/me/settings', { key: 'table.bigBlind', value: 50 })).json.code).toBe('SETTINGS_SCOPE_NOT_ALLOWED');
    expect((await a.c.call('PUT', '/api/me/settings', { key: 'ui.sfxVolumePercent', value: 500 })).json.code).toBe('SETTINGS_INVALID');
    expect((await a.c.call('DELETE', '/api/me/settings/ui.colorMode')).status).toBe(200);
    expect((await a.c.call('GET', '/api/me/settings')).json.user).toEqual({});
  });

  it('zrušený (už neexistující) klíč v uložených nastaveních neblokuje další ukládání', async () => {
    const { server, mk } = await seeded();
    const a = await mk('Alice');
    server.settings.preset('user', a.id, { 'ui.dávno.zrušené': 5 } as never);
    expect((await a.c.call('PUT', '/api/me/settings', { key: 'chat.showPlayersAtTable', value: false })).status).toBe(200);
    expect((await a.c.call('GET', '/api/me/settings')).json.user['chat.showPlayersAtTable']).toBe(false);
  });

  it('hodnocení souboje s chybějícím nebo neplatným id hráče vrátí 400, ne 500', async () => {
    const { mk } = await seeded();
    const a = await mk('Alice');
    expect((await a.c.call('GET', '/api/rating/duel')).status).toBeLessThan(500);
    expect((await a.c.call('GET', '/api/rating/duel?b=neni-uuid')).status).toBeLessThan(500);
  });

  it('globální nastavení smí měnit jen oprávněný a změna jde do audit logu', async () => {
    const { admin, mk } = await seeded();
    const hrac = await mk('Hrac');
    expect((await hrac.c.call('PUT', '/api/settings/global', { key: 'economy.startingBalance', value: 99 })).status).toBe(403);
    expect((await admin.call('PUT', '/api/settings/global', { key: 'economy.startingBalance', value: 5000 })).status).toBe(200);
    expect((await admin.call('GET', '/api/settings/global')).json.values['economy.startingBalance']).toBe(5000);
    expect((await admin.call('PUT', '/api/settings/global', { key: 'economy.startingBalance', value: -5 })).json.code).toBe('SETTINGS_INVALID');
    // uloženou obecnou hodnotu jde odstranit (vrací se výchozí), hráč to nesmí
    expect((await hrac.c.call('DELETE', '/api/settings/global/economy.startingBalance')).status).toBe(403);
    expect((await admin.call('DELETE', '/api/settings/global/economy.startingBalance')).status).toBe(200);
    expect((await admin.call('GET', '/api/settings/global')).json.values['economy.startingBalance']).toBeUndefined();
    await admin.call('PUT', '/api/settings/global', { key: 'economy.startingBalance', value: 5000 });
    const audit = (await admin.call('GET', '/api/admin/audit?limit=20')).json as { action: string; after: any }[];
    expect(audit.find((a) => a.action === 'nastaveni.zmena')!.after['economy.startingBalance']).toBe(5000);
  });
});

describe('HTTP API: tajné údaje a e-mail (celý řetěz)', () => {
  async function startMail() {
    const sent: { to: string; subject: string; text: string; from: string }[] = [];
    const server = await buildServer({
      settingsOverride: { 'system.publicUrl': 'http://localhost', 'system.emailVerificationRequired': true },
      bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
      defaultTable: false,
      emailWorker: false,
      masterKey: { key: Buffer.alloc(32, 7), version: 1 },
      mailTransport: () => ({ send: async (m) => void sent.push(m as never) }),
    });
    servers.push(server);
    const admin = http(server);
    await admin.call('POST', '/api/auth/login', { identifier: 'Admin', password: 'admin-heslo-123' });
    return { server, admin, sent };
  }

  it('SMTP heslo se zadává s ověřením hesla, klient vidí jen poslední 4 znaky a e-maily se odesílají', async () => {
    const { server, admin, sent } = await startMail();
    expect((await admin.call('PUT', '/api/admin/secrets/smtp.password', { value: 'heslo-aplikace-1234', password: 'spatne-heslo' })).status).toBe(401);
    expect((await admin.call('PUT', '/api/admin/secrets/smtp.password', { value: 'heslo-aplikace-1234', password: 'admin-heslo-123' })).status).toBe(200);
    const status = (await admin.call('GET', '/api/admin/secrets')).json as { key: string; set: boolean; last4?: string }[];
    expect(status.find((s) => s.key === 'smtp.password')).toMatchObject({ set: true, last4: '1234' });
    expect(JSON.stringify(status)).not.toContain('heslo-aplikace');
    expect((await admin.call('PUT', '/api/admin/secrets/neznamy', { value: 'x', password: 'admin-heslo-123' })).json.code).toBe('SECRET_UNKNOWN_SECRET');

    expect((await admin.call('POST', '/api/admin/email/test', { to: 'ja@example.cz' })).json).toEqual({ ok: true });
    expect(sent[0]!.from).toContain('poker@example.cz');

    // registrace → ověřovací e-mail ve frontě → odeslán → odkaz funguje
    const code = (await admin.call('POST', '/api/admin/invites', {})).json.code;
    const anon = http(server);
    await anon.call('POST', '/api/auth/register', { inviteCode: code, nickname: 'Petr', email: 'petr@example.cz', password: 'dlouhe-heslo-1', acceptTerms: true });
    await new Promise((r) => setTimeout(r, 200));
    expect((await server.email.processQueue()).sent).toBe(1);
    const mail = sent.find((m) => m.to === 'petr@example.cz')!;
    expect(mail.subject).toMatch(/Ověření e-mailu/);
    const link = mail.text.match(/https?:\/\/\S+/)![0];
    expect(link.startsWith('http://localhost/overit-email?token=')).toBe(true);
    const token = new URL(link).searchParams.get('token');
    expect((await anon.call('POST', '/api/auth/verify-email', { token })).status).toBe(200);
    expect((await anon.call('POST', '/api/auth/login', { identifier: 'petr', password: 'dlouhe-heslo-1' })).json.permissions).toContain('stul.hrat');

    const rotated = await admin.call('POST', '/api/admin/secrets/rotate', { password: 'admin-heslo-123' });
    expect(rotated.json.version).toBe(2);
    expect(await server.secrets.reveal('smtp.password')).toBe('heslo-aplikace-1234');
  });

  it('běžný hráč nevidí tajné údaje ani frontu a nemůže je měnit', async () => {
    const { server, admin } = await startMail();
    const code = (await admin.call('POST', '/api/admin/invites', {})).json.code;
    await server.settings.set((server.perms.mainAdminIds())[0]!, 'global', '', 'system.emailVerificationRequired', false);
    const c = http(server);
    await c.call('POST', '/api/auth/register', { inviteCode: code, nickname: 'Hrac', email: 'hrac@example.cz', password: 'dlouhe-heslo-1', acceptTerms: true });
    await c.call('POST', '/api/auth/login', { identifier: 'hrac', password: 'dlouhe-heslo-1' });
    expect((await c.call('GET', '/api/admin/secrets')).status).toBe(403);
    expect((await c.call('PUT', '/api/admin/secrets/smtp.password', { value: 'x', password: 'dlouhe-heslo-1' })).status).toBe(403);
    expect((await c.call('GET', '/api/admin/email/queue')).status).toBe(403);
    expect((await c.call('POST', '/api/admin/email/test', { to: 'a@example.cz' })).status).toBe(403);
    expect((await c.call('POST', '/api/admin/secrets/rotate', { password: 'dlouhe-heslo-1' })).status).toBe(403);
  });

  it('e-mail o vyřízení žádosti respektuje osobní předvolbu hráče', async () => {
    const { server, admin, sent } = await startMail();
    await admin.call('PUT', '/api/admin/secrets/smtp.password', { value: 'heslo-aplikace-1234', password: 'admin-heslo-123' });
    await server.settings.set(server.perms.mainAdminIds()[0]!, 'global', '', 'system.emailVerificationRequired', false);
    const code = (await admin.call('POST', '/api/admin/invites', {})).json.code;
    const c = http(server);
    await c.call('POST', '/api/auth/register', { inviteCode: code, nickname: 'Hrac', email: 'hrac@example.cz', password: 'dlouhe-heslo-1', acceptTerms: true });
    await c.call('POST', '/api/auth/login', { identifier: 'hrac', password: 'dlouhe-heslo-1' });
    await server.email.processQueue();
    sent.length = 0;

    const first = await c.call('POST', '/api/requests', { kind: 'dobiti', amount: 500, message: 'prosím' });
    expect((await admin.call('POST', `/api/requests/${first.json.id}/decide`, { approve: true, note: 'ok' })).json.status).toBe('approved');
    await new Promise((r) => setTimeout(r, 100));
    await server.email.processQueue();
    expect(sent.filter((m) => m.to === 'hrac@example.cz' && /žádost/.test(m.subject))).toHaveLength(1);

    expect((await c.call('PUT', '/api/me/settings', { key: 'email.notifyRequestDecided', value: false })).status).toBe(200);
    sent.length = 0;
    const second = await c.call('POST', '/api/requests', { kind: 'dobiti', amount: 500, message: 'ještě' });
    await admin.call('POST', `/api/requests/${second.json.id}/decide`, { approve: false });
    await new Promise((r) => setTimeout(r, 100));
    await server.email.processQueue();
    expect(sent.filter((m) => m.to === 'hrac@example.cz')).toHaveLength(0);
  });

  it('šablony e-mailů: úprava, kontrola proměnných a náhled', async () => {
    const { admin } = await startMail();
    const list = (await admin.call('GET', '/api/admin/email/templates')).json as { key: string; custom: boolean }[];
    expect(list.map((t) => t.key)).toContain('obnova_hesla');
    const bad = await admin.call('PUT', '/api/admin/email/templates/obnova_hesla', { subject: 'S', bodyText: 'Ahoj {hacker}' });
    expect(bad.status).toBe(400);
    expect(bad.json.params.variables).toEqual(['hacker']);
    expect((await admin.call('PUT', '/api/admin/email/templates/obnova_hesla', { subject: 'Heslo pro {prezdivka}', bodyText: 'Odkaz: {odkaz}' })).status).toBe(200);
    const prev = await admin.call('POST', '/api/admin/email/templates/obnova_hesla/preview', { subject: 'Heslo pro {prezdivka}', bodyText: 'Odkaz: {odkaz}', vars: { prezdivka: 'Eva', odkaz: 'https://x' } });
    expect(prev.json.subject).toBe('Heslo pro Eva');
    expect((await admin.call('DELETE', '/api/admin/email/templates/obnova_hesla')).status).toBe(200);
  });
});

describe('HTTP API: peněženka, žádosti a vyúčtování', () => {
  async function seeded() {
    const s = await start({ 'system.emailVerificationRequired': false });
    const admin = (await login(s.server, 'Admin', 'admin-heslo-123')).c;
    const mk = async (nick: string, role?: string) => {
      const code = (await admin.call('POST', '/api/admin/invites', {})).json.code;
      const c = http(s.server);
      const reg = await c.call('POST', '/api/auth/register', { inviteCode: code, nickname: nick, email: `${nick.toLowerCase()}@example.cz`, password: 'dlouhe-heslo-1', acceptTerms: true });
      await c.call('POST', '/api/auth/login', { identifier: nick, password: 'dlouhe-heslo-1' });
      if (role) {
        const roles = (await admin.call('GET', '/api/admin/roles')).json as { id: string; key: string }[];
        await admin.call('POST', '/api/admin/assignments', { userId: reg.json.userId, roleId: roles.find((r) => r.key === role)!.id });
      }
      return { c, id: reg.json.userId as string };
    };
    return { ...s, admin, mk };
  }

  it('dobití přes API, historie peněženky a žádost hráče vyřízená pokladníkem', async () => {
    const { admin, mk } = await seeded();
    const pok = await mk('Pok', 'pokladnik');
    const hrac = await mk('Hrac');
    const top = await pok.c.call('POST', '/api/admin/wallet/topup', { userId: hrac.id, amount: 2500, reason: 'výhra' });
    expect(top.json.done).toBe(true);
    expect((await hrac.c.call('GET', '/api/auth/me')).json.balance).toBe(12_500);
    expect((await pok.c.call('POST', '/api/admin/wallet/topup', { userId: hrac.id, amount: 99_999, reason: 'moc' })).status).toBe(403);
    expect((await hrac.c.call('POST', '/api/admin/wallet/topup', { userId: hrac.id, amount: 5, reason: 'sám sobě' })).status).toBe(403);
    await new Promise((r) => setTimeout(r, 100));
    const hist = (await hrac.c.call('GET', '/api/wallet/history')).json as { kind: string; amount: number }[];
    expect(hist.map((h) => h.amount)).toEqual(expect.arrayContaining([2500, 10_000]));

    const req = await hrac.c.call('POST', '/api/requests', { kind: 'dobiti', amount: 1000, message: 'prosím' });
    expect(req.status).toBe(200);
    expect(((await pok.c.call('GET', '/api/requests?all=1&status=pending')).json as unknown[]).length).toBe(1);
    expect((await hrac.c.call('POST', `/api/requests/${req.json.id}/decide`, { approve: true })).status).toBe(403);
    expect((await pok.c.call('POST', `/api/requests/${req.json.id}/decide`, { approve: true, note: 'ok' })).json.status).toBe('approved');
    expect((await hrac.c.call('GET', '/api/auth/me')).json.balance).toBe(13_500);
    expect((await admin.call('GET', '/api/admin/ledger')).status).toBe(200);
    expect((await hrac.c.call('GET', '/api/admin/ledger')).status).toBe(403);
  });

  it('schvalování: návrh juniora provede až druhá osoba', async () => {
    const { admin, mk } = await seeded();
    const created = await admin.call('POST', '/api/admin/roles', { key: 'junior', name: 'Junior', power: 30, permissions: [{ key: 'mena.dobit', needsApproval: true, limits: { maxPerOperation: 5000 } }] });
    const junior = await mk('Junior');
    await admin.call('POST', '/api/admin/assignments', { userId: junior.id, roleId: created.json.id });
    const hrac = await mk('Hrac');
    const r = await junior.c.call('POST', '/api/admin/wallet/topup', { userId: hrac.id, amount: 700, reason: 'test' });
    expect(r.json.done).toBe(false);
    expect((await hrac.c.call('GET', '/api/auth/me')).json.balance).toBe(10_000);
    expect((await junior.c.call('POST', `/api/approvals/${r.json.approvalId}/decide`, { approve: true })).status).toBe(403);
    expect(((await admin.call('GET', '/api/approvals?status=pending')).json as { id: string }[]).map((a) => a.id)).toContain(r.json.approvalId);
    expect((await admin.call('POST', `/api/approvals/${r.json.approvalId}/decide`, { approve: true })).json.status).toBe('executed');
    expect((await hrac.c.call('GET', '/api/auth/me')).json.balance).toBe(10_700);
  });

  it('vyúčtování stolu je přístupné účastníkům a obsahuje upozornění na virtuální měnu', async () => {
    const { server, admin, mk } = await seeded();
    const a = await mk('Alice');
    const b = await mk('Bob');
    const cizi = await mk('Cizi');
    server.cash.buyIn(a.id, 'stul-x', 500, 'x1');
    server.cash.buyIn(b.id, 'stul-x', 500, 'x2');
    server.cash.cashOut(a.id, 'stul-x', 800, 'x3');
    server.cash.cashOut(b.id, 'stul-x', 200, 'x4');
    await server.journal.flush();
    const r = await a.c.call('GET', '/api/tables/stul-x/settlement');
    expect(r.status).toBe(200);
    expect(r.json.transfers).toEqual([{ from: b.id, to: a.id, amount: 300 }]);
    expect(r.json.note).toMatch(/virtuální měně/);
    expect((await cizi.c.call('GET', '/api/tables/stul-x/settlement')).status).toBe(403);
    expect((await admin.call('GET', '/api/tables/stul-x/settlement')).status).toBe(200);
  });
});

describe('HTTP API: lobby', () => {
  it('přehled, založení stolu ze šablony, úprava a zrušení s kódy chyb', async () => {
    const s = await start({ 'system.emailVerificationRequired': false });
    const admin = (await login(s.server, 'Admin', 'admin-heslo-123')).c;
    const code = (await admin.call('POST', '/api/admin/invites', {})).json.code;
    const hrac = http(s.server);
    await hrac.call('POST', '/api/auth/register', { inviteCode: code, nickname: 'Hrac', email: 'h@example.cz', password: 'dlouhe-heslo-1', acceptTerms: true });
    await hrac.call('POST', '/api/auth/login', { identifier: 'Hrac', password: 'dlouhe-heslo-1' });

    const lobby = await hrac.call('GET', '/api/lobby');
    expect(lobby.status).toBe(200);
    expect(lobby.json.tables).toEqual([]);
    expect(lobby.json.templates.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(['cash-klasika', 'cash-heads-up']));
    expect((await http(s.server).call('GET', '/api/lobby')).status).toBe(401);

    const created = await hrac.call('POST', '/api/lobby/tables', { name: 'Heads-up duel', templateId: 'cash-heads-up' });
    expect(created.status).toBe(200);
    const id = created.json.id as string;
    expect((await hrac.call('GET', '/api/lobby')).json.tables[0]).toMatchObject({ name: 'Heads-up duel', seats: 2, owner: 'Hrac' });
    const bad = await hrac.call('POST', '/api/lobby/tables', { name: 'X', templateId: 'cash-klasika' });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('TABLE_INVALID');
    expect((await hrac.call('PATCH', `/api/lobby/tables/${id}`, { settings: { 'time.turnSeconds': 15 } })).json).toEqual({ applied: ['time.turnSeconds'], pending: [] });
    expect((await hrac.call('PATCH', `/api/lobby/tables/${id}`, { settings: { 'table.smallBlind': 999 } })).json.code).toBe('TABLE_INVALID');

    const other = http(s.server);
    const code2 = (await admin.call('POST', '/api/admin/invites', {})).json.code;
    await other.call('POST', '/api/auth/register', { inviteCode: code2, nickname: 'Jiny', email: 'j@example.cz', password: 'dlouhe-heslo-1', acceptTerms: true });
    await other.call('POST', '/api/auth/login', { identifier: 'Jiny', password: 'dlouhe-heslo-1' });
    expect((await other.call('PATCH', `/api/lobby/tables/${id}`, { settings: { 'time.turnSeconds': 5 } })).status).toBe(403);
    expect((await other.call('DELETE', `/api/lobby/tables/${id}`)).status).toBe(403);
    expect((await hrac.call('DELETE', `/api/lobby/tables/${id}`)).status).toBe(200);
    expect((await hrac.call('DELETE', `/api/lobby/tables/${id}`)).status).toBe(404);
  });
});
