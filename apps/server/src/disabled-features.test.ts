import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';

// Vypnutá funkce (správce ji vypnul v globálním nastavení) musí server odmítat sám, nejen schovat v klientovi.

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(settings: Record<string, unknown>) {
  const server = await buildServer({
    clock: new FakeClock(),
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 21), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  const { userId } = await server.accounts.register({ inviteCode: inv, nickname: 'Hrac1', email: 'hrac1@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
  return { server, admin: admin!, userId };
}

const errCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

describe('vypnuté funkce server odmítá', () => {
  it('ankety: poll.enabled=false', async () => {
    const { server, admin } = await start({ 'poll.enabled': false });
    expect(await errCode(server.polls.create(admin, { title: 'Hrajeme?', config: { type: 'yesno' }, condition: { type: 'players', keys: [admin] }, durationMinutes: 60 }))).toBe('DISABLED');
  });

  it('obchod: cosmetics.enabled=false', async () => {
    const { server, userId } = await start({ 'cosmetics.enabled': false });
    expect(await errCode(server.cosmetics.buy(userId, 'cokoli'))).toBe('DISABLED');
    expect(await errCode(server.cosmetics.equip(userId, 'cokoli', true))).toBe('DISABLED');
    expect(await server.cosmetics.sync(userId)).toEqual([]);
  });

  it('sdílení handy: hands.shareEnabled=false', async () => {
    const { server, userId } = await start({ 'hands.shareEnabled': false });
    expect(await errCode(server.sharedHands.share(userId, 'neexistuje'))).toBe('DISABLED');
  });
});
