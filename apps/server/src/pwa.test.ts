import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_THEMES, resolveTokens } from '@kb/tokens';
import { buildServer } from './app.js';
import { buildManifest } from './pwa.js';

const PUBLIC = join(__dirname, '..', '..', 'web', 'public');
const png = (name: string) => {
  const b = readFileSync(join(PUBLIC, name));
  return { signature: b.subarray(0, 8).toString('hex'), width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

describe('PWA', () => {
  it('manifest je instalovatelný: název, ikony všech typů, start a rozsah, zkratky', () => {
    const m = buildManifest('classic-green') as Record<string, any>;
    expect(m).toMatchObject({ name: 'KoronaBar Poker', short_name: 'KoronaBar', lang: 'cs', display: 'standalone', start_url: '/', scope: '/', id: '/' });
    const sizes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
    expect(m.shortcuts.map((s: { url: string }) => s.url)).toEqual(['/', '/turnaje', '/chat']);
    // každá ikona z manifestu skutečně existuje
    for (const i of m.icons) expect(existsSync(join(PUBLIC, i.src.slice(1))), i.src).toBe(true);
  });

  it('barvy manifestu se berou z výchozího motivu a neznámý motiv spadne na první vestavěný', () => {
    for (const theme of BUILTIN_THEMES.slice(0, 4)) {
      const m = buildManifest(theme.id) as Record<string, string>;
      expect(m.background_color).toBe(resolveTokens(theme, 'dark')['color.bg']);
      expect(m.theme_color).toBe(m.background_color);
    }
    expect((buildManifest('neexistuje') as Record<string, string>).theme_color).toBe(resolveTokens(BUILTIN_THEMES[0]!, 'dark')['color.bg']);
  });

  it('server vrací manifest s hlavičkou application/manifest+json a respektuje motiv z nastavení', async () => {
    const other = BUILTIN_THEMES.find((x) => x.id !== 'classic-green')!;
    const server = await buildServer({ settingsOverride: { 'pwa.themeId': other.id }, bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' }, defaultTable: false });
    servers.push(server);
    const res = await server.app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/manifest+json');
    expect(JSON.parse(res.body).theme_color).toBe(resolveTokens(other, 'dark')['color.bg']);
  });

  it('server se statickými soubory webu nastartuje, servíruje index i offline stránku a manifest zůstává dynamický', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>KB</title>');
    writeFileSync(join(dir, 'offline.html'), readFileSync(join(PUBLIC, 'offline.html')));
    const server = await buildServer({ webDir: dir, bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' }, defaultTable: false });
    servers.push(server);
    expect((await server.app.inject({ method: 'GET', url: '/' })).body).toContain('<title>KB</title>');
    expect((await server.app.inject({ method: 'GET', url: '/turnaje' })).body).toContain('<title>KB</title>'); // SPA fallback
    expect((await server.app.inject({ method: 'GET', url: '/offline.html' })).statusCode).toBe(200);
    const m = await server.app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(String(m.headers['content-type'])).toContain('application/manifest+json');
    expect(JSON.parse(m.body).shortcuts).toHaveLength(3);
    // v adresáři webu nesmí být statický manifest, jinak by se routa zdvojila a server by nenastartoval
    expect(existsSync(join(PUBLIC, 'manifest.webmanifest'))).toBe(false);
  });

  it('PUBLIC_URL z prostředí nastaví veřejnou adresu a povolený původ, dokud ji správce nezmění', async () => {
    const server = await buildServer({ publicUrlDefault: 'http://herna.local:3200', bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' }, defaultTable: false });
    servers.push(server);
    expect(server.settings.resolve()['system.publicUrl']).toBe('http://herna.local:3200');
    const login = await server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'Admin', password: 'admin-heslo-123' }, headers: { origin: 'http://herna.local:3200' } });
    expect(login.statusCode).toBe(200);
    const denied = await server.app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'Admin', password: 'admin-heslo-123' }, headers: { origin: 'http://jinde.example' } });
    expect(denied.statusCode).toBe(403);
    // hodnota uložená správcem v GUI má přednost
    const [admin] = server.perms.mainAdminIds();
    await server.settings.set(admin!, 'global', '', 'system.publicUrl', 'https://poker.example');
    expect(server.settings.resolve()['system.publicUrl']).toBe('https://poker.example');
  });

  it('ikony mají správný formát a rozměry', () => {
    expect(png('icon-192.png')).toEqual({ signature: '89504e470d0a1a0a', width: 192, height: 192 });
    expect(png('icon-512.png')).toMatchObject({ signature: '89504e470d0a1a0a', width: 512, height: 512 });
    expect(png('icon-maskable-512.png')).toMatchObject({ width: 512, height: 512 });
    expect(png('apple-touch-icon.png')).toMatchObject({ width: 180, height: 180 });
  });

  it('service worker nikdy nekešuje živá data a umí offline stránku; index.html odkazuje na manifest a ikonu', () => {
    const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
    // rozhodnutí o /api a /socket.io padne dřív, než se cokoli otevře v keši nebo odpoví
    const apiGuard = sw.indexOf("url.pathname.startsWith('/api/')");
    expect(apiGuard).toBeGreaterThan(0);
    expect(sw.indexOf("url.pathname.startsWith('/socket.io/')")).toBeGreaterThan(0);
    expect(apiGuard).toBeLessThan(sw.indexOf('respondWith'));
    expect(sw).toContain("req.method !== 'GET'");
    expect(sw).toContain('/offline.html');
    expect(existsSync(join(PUBLIC, 'offline.html'))).toBe(true);
    expect(readFileSync(join(PUBLIC, 'offline.html'), 'utf8')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const html = readFileSync(join(PUBLIC, '..', 'index.html'), 'utf8');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('apple-touch-icon');
    expect(html).toContain('name="viewport"');
  });
});
