import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { accounts } from '@kb/ledger';
import { API_ROUTES } from '@kb/shared';
import { eq } from 'drizzle-orm';
import { ApiError } from './api-tokens.js';
import { buildServer } from './app.js';
import { schema } from './db/index.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(settings: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 37), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 5000, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `A${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  const api = async (token: string | null, method: 'GET' | 'POST', url: string, body?: unknown) => {
    const res = await server.app.inject({ method, url, payload: body as object | undefined, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined, headers: res.headers };
  };
  return { server, clock, admin: admin!, user, api };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};

describe('osobní tokeny a REST API', { timeout: 90_000 }, () => {
  it('token se ukládá jen jako otisk, v seznamu je jen začátek; celá hodnota se vrátí jednou', async () => {
    const c = await start();
    const u = await c.user();
    const { token, id } = await c.server.apiTokens.create(u, { name: 'Home Assistant', scopes: ['tournaments:read', 'wallet:read'], expiresInDays: 30 });
    expect(token.startsWith('kbp_')).toBe(true);
    const rows = await c.server.db.select().from(schema.apiTokens);
    expect(JSON.stringify(rows)).not.toContain(token);
    const list = await c.server.apiTokens.list(u);
    expect(list.tokens[0]).toMatchObject({ id, name: 'Home Assistant', hint: token.slice(0, 8), scopes: ['tournaments:read', 'wallet:read'], revoked: false, expired: false });
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list.allowed).toEqual(expect.arrayContaining(['tournaments:read', 'chat:write']));
  });

  it('bez platného tokenu je API zavřené; cookie z přihlášení se tam nepoužije', async () => {
    const c = await start();
    const u = await c.user();
    const { token } = await c.server.apiTokens.create(u, { name: 'Test', scopes: ['wallet:read'], expiresInDays: 7 });
    expect((await c.api(null, 'GET', '/api/v1/me')).status).toBe(401);
    expect((await c.api('kbp_nesmysl', 'GET', '/api/v1/me')).status).toBe(401);
    expect((await c.api('jiny-token', 'GET', '/api/v1/me')).status).toBe(401);
    const me = await c.api(token, 'GET', '/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ id: u, scopes: ['wallet:read'] });
    // session cookie
    const login = await c.server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'Admin', password: 'admin-heslo-123' }, headers: { origin: 'http://localhost' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const res = await c.server.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('rozsah: token smí jen to, co mu bylo dáno; zrušení, vypršení a vypnuté API ho zneplatní', async () => {
    const c = await start();
    const u = await c.user();
    const { token, id } = await c.server.apiTokens.create(u, { name: 'Jen zustatek', scopes: ['wallet:read'], expiresInDays: 1 });
    const w = await c.api(token, 'GET', '/api/v1/wallet');
    expect(w.json.balance).toBe(c.server.ledger.balance(accounts.wallet(u)));
    const denied = await c.api(token, 'GET', '/api/v1/tournaments');
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ code: 'API_SCOPE', params: { scope: 'tournaments:read' } });
    expect((await c.api(token, 'POST', '/api/v1/chat/messages', { text: 'ahoj' })).status).toBe(403);

    await c.server.settings.set(c.admin, 'global', '', 'api.enabled', false);
    expect((await c.api(token, 'GET', '/api/v1/wallet')).status).toBe(503);
    await c.server.settings.set(c.admin, 'global', '', 'api.enabled', true);
    c.clock.advance(2 * 86_400_000);
    expect((await c.api(token, 'GET', '/api/v1/wallet')).status).toBe(401); // vypršel

    const t2 = await c.server.apiTokens.create(u, { name: 'Druhy', scopes: ['wallet:read'], expiresInDays: 30 });
    expect((await c.api(t2.token, 'GET', '/api/v1/wallet')).status).toBe(200);
    await c.server.apiTokens.revoke(u, t2.id);
    expect((await c.api(t2.token, 'GET', '/api/v1/wallet')).status).toBe(401);
    void id;
  });

  it('token nikdy nemá víc než majitel: scope bez oprávnění nejde vytvořit a ztracené oprávnění se projeví hned', async () => {
    const c = await start();
    const u = await c.user();
    const { token } = await c.server.apiTokens.create(u, { name: 'Chat', scopes: ['chat:write', 'wallet:read'], expiresInDays: 30 });
    expect((await c.api(token, 'POST', '/api/v1/chat/messages', { text: 'ahoj z API' })).status).toBe(200);
    const msgs = await c.server.db.select().from(schema.chatMessages);
    expect(msgs.some((m) => m.body === 'ahoj z API' && m.userId === u)).toBe(true);

    const roleId = await c.server.perms.createRole(c.admin, { key: 'nemluvi', name: 'Nemluví', power: 5, permissions: [{ key: 'chat.psat', effect: 'deny' }] });
    await c.server.perms.assignRole(c.admin, u, roleId);
    const denied = await c.api(token, 'POST', '/api/v1/chat/messages', { text: 'jeste jednou' });
    expect(denied.status).toBe(403);
    expect((await c.api(token, 'GET', '/api/v1/me')).json.scopes).toEqual(['wallet:read']);
    expect(await code(c.server.apiTokens.create(u, { name: 'Novy', scopes: ['chat:write'], expiresInDays: 5 }))).toBe('FORBIDDEN');
  });

  it('kontroly vstupů: název, rozsah, platnost, nejvyšší počet tokenů', async () => {
    const c = await start({ 'api.maxTokensPerUser': 2, 'api.maxExpiryDays': 30 });
    const u = await c.user();
    const mk = (over: Partial<{ name: string; scopes: string[]; expiresInDays: number }> = {}) => c.server.apiTokens.create(u, { name: 'Token', scopes: ['wallet:read'], expiresInDays: 10, ...over });
    expect(await code(mk({ name: 'x' }))).toBe('INVALID');
    expect(await code(mk({ scopes: [] }))).toBe('INVALID');
    expect(await code(mk({ scopes: ['admin:all'] }))).toBe('INVALID');
    expect(await code(mk({ expiresInDays: 0 }))).toBe('INVALID');
    expect(await code(mk({ expiresInDays: 31 }))).toBe('INVALID');
    expect(await code(mk())).toBe('OK');
    expect(await code(mk())).toBe('OK');
    expect(await code(mk())).toBe('LIMIT');
  });

  it('limit volání za minutu vrací 429 s časem do uvolnění a po minutě zase pustí', async () => {
    const c = await start({ 'api.rateLimitPerMinute': 3 });
    const u = await c.user();
    const { token } = await c.server.apiTokens.create(u, { name: 'Rychly', scopes: ['wallet:read'], expiresInDays: 5 });
    for (let i = 0; i < 3; i++) expect((await c.api(token, 'GET', '/api/v1/wallet')).status).toBe(200);
    const blocked = await c.api(token, 'GET', '/api/v1/wallet');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    c.clock.advance(61_000);
    expect((await c.api(token, 'GET', '/api/v1/wallet')).status).toBe(200);
    // limit platí pro každý token zvlášť
    const other = await c.server.apiTokens.create(u, { name: 'Jiny', scopes: ['wallet:read'], expiresInDays: 5 });
    expect((await c.api(other.token, 'GET', '/api/v1/wallet')).status).toBe(200);
  });

  it('čtecí a akční trasy: turnaje, žebříček, statistiky, večery, přihlášení do turnaje', async () => {
    const c = await start();
    const org = await c.user('organizator');
    const u = await c.user();
    const { id: tid } = await c.server.tournaments.create(org, { name: 'Pátek', templateId: 'tour-turbo' });
    const { token } = await c.server.apiTokens.create(u, { name: 'Vse', scopes: ['tournaments:read', 'tournaments:register', 'stats:read', 'evenings:read', 'wallet:read'], expiresInDays: 30 });
    const list = await c.api(token, 'GET', '/api/v1/tournaments');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).toContain('Pátek');
    const detail = await c.api(token, 'GET', `/api/v1/tournaments/${tid}`);
    expect(detail.status).toBe(200);
    const reg = await c.api(token, 'POST', `/api/v1/tournaments/${tid}/register`);
    expect(reg.status).toBe(200);
    expect(c.server.tournaments.get(tid)!.state().players.map((p) => p.userId)).toContain(u);
    expect((await c.api(token, 'GET', '/api/v1/seasons')).json.seasons).toEqual([]);
    expect((await c.api(token, 'GET', '/api/v1/leaderboard?season=all')).json).toHaveProperty('rows');
    expect((await c.api(token, 'GET', '/api/v1/stats/me?season=all')).json).toHaveProperty('hands');
    expect((await c.api(token, 'GET', '/api/v1/evenings')).status).toBe(200);
    expect((await c.api(token, 'GET', '/api/v1/leaderboard?season=nesmysl')).status).toBeGreaterThanOrEqual(400);
  });

  it('dokumentace OpenAPI je veřejná a obsahuje všechny trasy s požadovaným rozsahem', async () => {
    const c = await start();
    const res = await c.api(null, 'GET', '/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.json.openapi).toMatch(/^3\./);
    for (const r of API_ROUTES) {
      const op = res.json.paths[r.path][r.method];
      expect(op.summary).toBeTruthy();
      expect(op['x-required-scope']).toBe(r.scope ?? undefined);
    }
    expect(res.json.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });

  it('správa: hráč nevidí a neruší cizí tokeny, správce ano', async () => {
    const c = await start();
    const [a, b] = [await c.user(), await c.user()];
    const { id, token } = await c.server.apiTokens.create(a, { name: 'Cizi', scopes: ['wallet:read'], expiresInDays: 30 });
    expect(await code(c.server.apiTokens.listAll(b))).toBe('FORBIDDEN');
    expect(await code(c.server.apiTokens.revoke(b, id))).toBe('NOT_FOUND');
    expect((await c.api(token, 'GET', '/api/v1/wallet')).status).toBe(200);
    const all = await c.server.apiTokens.listAll(c.admin);
    expect(all.find((t) => t.id === id)?.owner).toBeTruthy();
    await c.server.apiTokens.revoke(c.admin, id);
    expect((await c.api(token, 'GET', '/api/v1/wallet')).status).toBe(401);
    const [row] = await c.server.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, id));
    expect(row!.revokedAt).not.toBeNull();
    // zablokovaný majitel: token přestane platit
    const t2 = await c.server.apiTokens.create(b, { name: 'Token B', scopes: ['wallet:read'], expiresInDays: 30 });
    await c.server.accounts.blockUser(c.admin, b, 'zkouška', null);
    expect((await c.api(t2.token, 'GET', '/api/v1/wallet')).status).toBe(401);
  });
});
