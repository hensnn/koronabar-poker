import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { BlindStructureError } from './structures.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start() {
  const server = await buildServer({
    clock: new FakeClock(),
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 3), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost' },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  const { userId: player } = await server.accounts.register({ inviteCode: inv, nickname: 'Hrac', email: 'hrac@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
  return { server, admin: admin!, player };
}

describe('uložené struktury blindů', () => {
  it('správce založí, upraví a smaže strukturu; zápis se normalizuje; hráč jen čte', async () => {
    const s = await start();
    const created = await s.server.structures.create(s.admin, { name: 'Domácí', levels: '25/50\n50/100/10, 75/150', startingStack: 1500, levelMinutes: 15 });
    expect(created.id).toMatch(/^bs-domaci-[0-9a-f]{6}$/);
    expect(created.levels).toBe('25/50, 50/100/10, 75/150');
    expect((await s.server.structures.list()).map((x) => x.name)).toEqual(['Domácí']);
    const upd = await s.server.structures.update(s.admin, created.id, { name: 'Domácí 2', levels: '10/20, 20/40', startingStack: 1000, levelMinutes: 10 });
    expect(upd.name).toBe('Domácí 2');
    expect((await s.server.structures.get(created.id))!.levelMinutes).toBe(10);
    await expect(s.server.structures.create(s.player, { name: 'X', levels: '10/20', startingStack: 1, levelMinutes: 1 })).rejects.toBeInstanceOf(BlindStructureError);
    await expect(s.server.structures.create(s.admin, { name: 'Špatná', levels: '50/25', startingStack: 1000, levelMinutes: 10 })).rejects.toThrow('INVALID');
    await s.server.structures.remove(s.admin, created.id);
    expect(await s.server.structures.list()).toEqual([]);
    await expect(s.server.structures.remove(s.admin, created.id)).rejects.toThrow('NOT_FOUND');
  });
});
