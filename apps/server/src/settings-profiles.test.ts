import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(over: Record<string, unknown> = {}) {
  const server = await buildServer({
    clock: new FakeClock(),
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 7), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', ...over },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const login = async (identifier: string, password: string) => {
    const r = await server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier, password }, headers: { origin: 'http://localhost' } });
    return { cookie: String(r.headers['set-cookie']).split(';')[0]!, origin: 'http://localhost' };
  };
  for (const nick of ['Hrac', 'Druhy']) {
    const inv = await server.accounts.createInvite(admin!, {});
    await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick.toLowerCase()}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
  }
  const call = async (who: { cookie: string; origin: string }, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    server.app.inject({ method, url, headers: { cookie: who.cookie, origin: who.origin }, payload: payload as object | undefined });
  return { server, call, hrac: await login('Hrac', 'heslo-hrace-123'), druhy: await login('Druhy', 'heslo-hrace-123'), admin: await login('Admin', 'admin-heslo-123') };
}

describe('sdílené profily osobního nastavení', () => {
  it('uložení, seznam, převzetí cizím hráčem; neplatné a neosobní klíče se vyřadí', async () => {
    const c = await start();
    const save = await c.call(c.hrac, 'POST', '/api/settings-profiles', { name: 'Můj telefon', description: 'bez ruky', data: { user: { 'ui.sfxEnabled': false, 'economy.currencyName': 'X', nesmysl: 1 }, device: { 'ui.mobileBest': false }, deviceKind: 'phone', set: 'tablePhone' } });
    expect(save.statusCode).toBe(200);
    const id = save.json().id as string;
    const list = (await c.call(c.druhy, 'GET', '/api/settings-profiles')).json().profiles as { id: string; name: string; author: string; count: number; mine: boolean; canDelete: boolean }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, name: 'Můj telefon', author: 'Hrac', count: 2, mine: false, canDelete: false, set: 'tablePhone' });
    const got = (await c.call(c.druhy, 'GET', `/api/settings-profiles/${id}`)).json();
    expect(got.data).toEqual({ user: { 'ui.sfxEnabled': false }, device: { 'ui.mobileBest': false }, deviceKind: 'phone', set: 'tablePhone' });
    expect((await c.call(c.druhy, 'GET', `/api/settings-profiles/${crypto.randomUUID()}`)).statusCode).toBe(404);
  });

  it('mazat smí autor a správce, jiný hráč ne; limit počtu profilů na hráče', async () => {
    const c = await start({ 'system.profilesMaxPerUser': 2 });
    const body = (n: string) => ({ name: n, data: { user: { 'ui.sfxEnabled': false }, device: {}, deviceKind: null } });
    const a = (await c.call(c.hrac, 'POST', '/api/settings-profiles', body('A'))).json().id as string;
    await c.call(c.hrac, 'POST', '/api/settings-profiles', body('B'));
    const over = await c.call(c.hrac, 'POST', '/api/settings-profiles', body('C'));
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ code: 'PROFILE_LIMIT', params: { max: 2 } });
    expect((await c.call(c.druhy, 'DELETE', `/api/settings-profiles/${a}`)).statusCode).toBe(403);
    expect((await c.call(c.admin, 'DELETE', `/api/settings-profiles/${a}`)).statusCode).toBe(200);
    expect((await c.call(c.hrac, 'POST', '/api/settings-profiles', body('C'))).statusCode).toBe(200);
    expect((await c.call(c.hrac, 'POST', '/api/settings-profiles', { name: 'Prázdný', data: { user: { nesmysl: 1 }, device: {}, deviceKind: null } })).statusCode).toBe(400);
    expect((await c.server.app.inject({ method: 'GET', url: '/api/settings-profiles' })).statusCode).toBe(401);
  });
});
