import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(over: Record<string, string | number | boolean> = {}) {
  const server = await buildServer({
    clock: new FakeClock(),
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 3), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', ...over },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  const { userId: player } = await server.accounts.register({ inviteCode: inv, nickname: 'Hrac', email: 'hrac@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
  return { server, admin: admin!, player };
}

describe('přehled mezi hráči', () => {
  it('ukáže všechny aktivní hráče se zůstatkem a úrovní; srovnání vrací řady po hráčích', async () => {
    const s = await start();
    await s.server.wallet.topUp(s.admin, s.player, 500, 'test');
    s.server.progress.grant(s.player, 'x', 90);
    await s.server.progress.idle();
    await s.server.journal.flush();
    const o = await s.server.overview.overview();
    expect(o.rows.map((r) => r.nickname).sort()).toEqual(['Admin', 'Hrac']);
    const me = o.rows.find((r) => r.userId === s.player)!;
    expect(me.balance).toBe(10_500);
    expect(me.xp).toBe(90);
    expect(me.level).toBeGreaterThanOrEqual(1);
    const bal = await s.server.overview.compare([s.player, s.admin], 'balance');
    expect(bal.series).toHaveLength(2);
    expect(bal.series.find((x) => x.userId === s.player)!.points.at(-1)![1]).toBe(10_500);
    const xp = await s.server.overview.compare([s.player], 'xp');
    expect(xp.series[0]!.points.at(-1)![1]).toBe(90);
    const profit = await s.server.overview.compare([s.player], 'profit');
    expect(profit.series[0]!.points).toEqual([]);
    await expect(s.server.overview.compare([], 'balance')).rejects.toThrow('INVALID');
  });

  it('správce přehled vypne: čísla ostatních se nevydají', async () => {
    const s = await start({ 'stats.publicOverview': false });
    await expect(s.server.overview.overview()).rejects.toThrow('HIDDEN');
    await expect(s.server.overview.compare([s.player], 'balance')).rejects.toThrow('HIDDEN');
  });
});
