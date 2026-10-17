import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { AssetError } from './theme-assets.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AssetError) return e.code;
    throw e;
  }
};

async function start(settings: Record<string, unknown> = {}) {
  const server = await buildServer({
    clock: new FakeClock(),
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 15), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  const { userId } = await server.accounts.register({ inviteCode: inv, nickname: 'Obr1', email: 'obr1@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
  return { server, user: userId };
}

describe('obrázky motivů', { timeout: 60_000 }, () => {
  it('nahraje obrázek, přečte ho a smaže', async () => {
    const { server, user } = await start();
    const r = await server.themeAssets.upload(user, 'felt', png);
    expect((await server.themeAssets.read(r.id)).mime).toBe('image/png');
    expect(await server.themeAssets.list(user)).toHaveLength(1);
    await server.themeAssets.remove(user, r.id);
    expect(await code(server.themeAssets.read(r.id))).toBe('NOT_FOUND');
  });

  it('odmítne SVG, neznámý druh, příliš velký soubor a překročení počtu', async () => {
    const { server, user } = await start({ 'theme.imageMaxKb': 16, 'theme.maxImagesPerUser': 1 });
    expect(await code(server.themeAssets.upload(user, 'felt', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')))).toBe('INVALID');
    expect(await code(server.themeAssets.upload(user, 'jiny', png))).toBe('INVALID');
    expect(await code(server.themeAssets.upload(user, 'felt', Buffer.concat([png, Buffer.alloc(17 * 1024)])))).toBe('TOO_LARGE');
    expect(await code(server.themeAssets.upload(user, 'logo', png))).toBe('OK');
    expect(await code(server.themeAssets.upload(user, 'logo', png))).toBe('LIMIT');
  });

  it('cizí obrázek nesmaže hráč bez práva schvalovat', async () => {
    const { server, user } = await start();
    const r = await server.themeAssets.upload(user, 'roomBg', png);
    const inv = await server.accounts.createInvite(server.perms.mainAdminIds()[0]!, {});
    const { userId: other } = await server.accounts.register({ inviteCode: inv, nickname: 'Obr2', email: 'obr2@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
    expect(await code(server.themeAssets.remove(other, r.id))).toBe('FORBIDDEN');
  });
});
