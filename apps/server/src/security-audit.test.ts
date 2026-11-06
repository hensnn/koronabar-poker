import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const UUID = '00000000-0000-4000-8000-000000000000';

/** Trasy, které jsou záměrně veřejné (nebo se přihlašují jinak než cookie: zařízení TV, podepsané odkazy). */
const PUBLIC = new Set(['/health', '/api/settings/schema', '/api/v1/openapi.json', '/manifest.webmanifest']);
const PUBLIC_PREFIXES = ['/api/auth/', '/api/public/', '/api/tv/', '/api/v1/', '/api/mcp', '/api/calendar', '/socket.io', '/api/announcer/audio/', '/api/push/key'];

/** Vlastní data přihlášeného i bez zvláštního oprávnění (odebrání upozornění, smazání historie vlastního asistenta). */
const OWN_DATA = new Set(['POST /api/push/test', 'POST /api/push/unsubscribe', 'DELETE /api/assistant/history']);

async function setup() {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    masterKey: { key: Buffer.alloc(32, 9), version: 1 },
    settingsOverride: { 'system.publicUrl': 'http://localhost', 'system.emailVerificationRequired': false, 'system.mailRequestsPerHour': 100 },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
    scheduler: false,
    emailWorker: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const cookies: Record<string, string> = {};
  let n = 0;
  for (const role of ['host', 'novacek', 'hrac']) {
    const nick = `A${n++}${role}`.slice(0, 12);
    clock.advance(3_600_000);
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    clock.advance(60_000);
    const res = await server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: nick, password: 'heslo-hrace-123' }, headers: { origin: 'http://localhost' } });
    cookies[role] = String(res.headers['set-cookie']).split(';')[0]!;
  }
  const routes: { method: string; url: string }[] = [];
  for (const line of server.app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /(\/\S*)\s+\(([A-Z, ]+)\)/.exec(line.replace(/[├└│─]/g, ' '));
    if (!m) continue;
    for (const method of m[2]!.split(',').map((x) => x.trim())) if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) routes.push({ method, url: m[1]! });
  }
  const call = async (r: { method: string; url: string }, cookie?: string) => {
    const res = await server.app.inject({
      method: r.method as 'GET',
      url: r.url.replace(/:[A-Za-z]+/g, UUID),
      payload: r.method === 'GET' ? undefined : {},
      headers: { ...(cookie ? { cookie } : {}), ...(r.method !== 'GET' ? { origin: 'http://localhost' } : {}) },
    });
    return res.statusCode;
  };
  return { cookies, routes: routes.filter((r) => !r.url.includes('*')), call };
}

describe('bezpečnostní kontrola tras (neoprávněné role)', () => {
  it('nepřihlášený nesmí na žádnou trasu kromě veřejných; správní trasy jsou zavřené i pro Hosta, Nováčka a Hráče', async () => {
    const { cookies, routes, call } = await setup();
    expect(routes.length).toBeGreaterThan(300);
    const anonOpen: string[] = [];
    const adminOpen: string[] = [];
    const ownOpen: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      const isPublic = PUBLIC.has(r.url) || PUBLIC_PREFIXES.some((p) => r.url.startsWith(p));
      if (!isPublic && (await call(r)) < 300) anonOpen.push(key);
      for (const role of ['host', 'novacek', 'hrac']) {
        const code = await call(r, cookies[role]);
        if (r.url.startsWith('/api/admin') && code < 300) adminOpen.push(`${role}: ${key}`);
        // Host (jen sleduje) nesmí nic měnit kromě vlastních dat.
        if (role === 'host' && r.method !== 'GET' && !isPublic && !r.url.startsWith('/api/admin') && code < 300 && !OWN_DATA.has(key)) ownOpen.push(key);
      }
    }
    expect(anonOpen, 'nepřihlášený prošel').toEqual([]);
    expect(adminOpen, 'správní trasa bez oprávnění prošla').toEqual([]);
    expect(ownOpen, 'host mohl měnit').toEqual([]);
  }, 180_000);
});
