import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { thin } from './timeline.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

describe('časové řady hráče', () => {
  it('thin zachová první a poslední bod a nepřekročí maximum', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => i);
    const out = thin(rows, 100);
    expect(out.length).toBe(100);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(999);
    expect(thin([1, 2, 3], 100)).toEqual([1, 2, 3]);
  });

  it('zůstatek je běžící součet pohybů peněženky a končí aktuálním zůstatkem; XP roste; cizí data nevidí', async () => {
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
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: 'Hrac', email: 'hrac@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
    await server.wallet.topUp(admin!, userId, 500, 'test');
    server.progress.grant(userId, 'test', 120);
    await server.progress.idle();
    await server.journal.flush();
    const tl = await server.timeline.of(userId);
    const last = tl.balance[tl.balance.length - 1]!;
    expect(last[1]).toBe(10_500);
    expect(tl.balance.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < tl.balance.length; i++) expect(tl.balance[i]![0]).toBeGreaterThanOrEqual(tl.balance[i - 1]![0]);
    expect(tl.xp[tl.xp.length - 1]![1]).toBe(120);
    expect(tl.tournaments).toEqual([]);
    expect(tl.earnings).toEqual([]);
    expect(tl.rating.visible).toBe(true);
    const other = await server.timeline.of(admin!);
    expect(other.xp).toEqual([]);
  });
});
