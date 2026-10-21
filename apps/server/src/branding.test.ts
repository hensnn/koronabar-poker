import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

// 1×1 průhledné PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function start() {
  const server = await buildServer({
    clock: new FakeClock(),
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 12), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost' },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  await server.accounts.register({ inviteCode: inv, nickname: 'Hrac', email: 'hrac@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
  const login = async (identifier: string, password: string) => String((await server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier, password }, headers: { origin: 'http://localhost' } })).headers['set-cookie']).split(';')[0]!;
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie?: string, payload?: unknown) => server.app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), origin: 'http://localhost' }, payload: payload as never });
  return { server, login, call, admin: admin! };
}

describe('logo aplikace', () => {
  it('bez loga je značka jen název; správce logo nahraje, je veřejně vidět a jde odebrat; hráč nahrát nesmí', async () => {
    const c = await start();
    const admin = await c.login('Admin', 'admin-heslo-123');
    const player = await c.login('Hrac', 'heslo-hrace-123');

    expect((await c.call('GET', '/api/public/brand')).json()).toEqual({ logo: null, showName: true, heightPercent: 100 });
    expect((await c.call('GET', '/api/public/brand/logo')).statusCode).toBe(404);

    // hráč logo nahrát nesmí
    const denied = await c.call('POST', '/api/theme-assets', player, { kind: 'brand', data: PNG.toString('base64') });
    expect(denied.statusCode).toBe(403);
    // neobrázek se odmítne
    expect((await c.call('POST', '/api/theme-assets', admin, { kind: 'brand', data: Buffer.from('nejde o obrázek').toString('base64') })).statusCode).toBe(400);

    const up = await c.call('POST', '/api/theme-assets', admin, { kind: 'brand', data: PNG.toString('base64') });
    expect(up.statusCode).toBe(200);
    const id = up.json().id as string;
    // dokud není v nastavení, nejde přečíst veřejně
    expect((await c.call('GET', '/api/public/brand/logo')).statusCode).toBe(404);
    expect((await c.call('PUT', '/api/settings/global', admin, { key: 'branding.logoAssetId', value: id })).statusCode).toBe(200);
    await c.call('PUT', '/api/settings/global', admin, { key: 'branding.logoHeightPercent', value: 150 });
    await c.call('PUT', '/api/settings/global', admin, { key: 'branding.showName', value: false });

    // veřejně (bez přihlášení)
    expect((await c.call('GET', '/api/public/brand')).json()).toEqual({ logo: id, showName: false, heightPercent: 150 });
    const img = await c.call('GET', '/api/public/brand/logo');
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.rawPayload.equals(PNG)).toBe(true);

    // odebrání: nastavení se vyprázdní a logo zmizí
    await c.call('PUT', '/api/settings/global', admin, { key: 'branding.logoAssetId', value: '' });
    expect((await c.call('DELETE', `/api/theme-assets/${id}`, admin)).statusCode).toBe(200);
    expect((await c.call('GET', '/api/public/brand')).json().logo).toBeNull();
    expect((await c.call('GET', '/api/public/brand/logo')).statusCode).toBe(404);
  });

  it('obrázek jiného druhu nejde použít jako logo, i kdyby jeho id někdo zadal do nastavení', async () => {
    const c = await start();
    const admin = await c.login('Admin', 'admin-heslo-123');
    const up = await c.call('POST', '/api/theme-assets', admin, { kind: 'felt', data: PNG.toString('base64') });
    await c.call('PUT', '/api/settings/global', admin, { key: 'branding.logoAssetId', value: up.json().id });
    expect((await c.call('GET', '/api/public/brand')).json().logo).toBeNull();
    expect((await c.call('GET', '/api/public/brand/logo')).statusCode).toBe(404);
  });
});
