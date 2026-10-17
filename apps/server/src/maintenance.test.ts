import { afterEach, describe, expect, it } from 'vitest';
import { accounts } from '@kb/ledger';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { MaintenanceError } from './maintenance.js';

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
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000 },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  const inv = await server.accounts.createInvite(admin!, {});
  const { userId: player } = await server.accounts.register({ inviteCode: inv, nickname: 'Hrac', email: 'hrac@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
  return { server, admin: admin!, player };
}

describe('údržba: vynulování po testování', () => {
  it('vynuluje XP, úspěchy, rating i peněženky; hráč bez oprávnění nesmí', async () => {
    const s = await start();
    s.server.progress.grant(s.player, 'test', 500);
    await s.server.progress.idle();
    expect((await s.server.progress.progressOf(s.player)).xp).toBe(500);
    await s.server.wallet.topUp(s.admin, s.player, 2500, 'test');
    expect(s.server.ledger.balance(accounts.wallet(s.player))).toBe(12_500);
    const before = await s.server.maintenance.counts(s.admin);
    expect(before.xpEvents).toBeGreaterThan(0);

    await expect(s.server.maintenance.reset(s.player, { xp: true })).rejects.toBeInstanceOf(MaintenanceError);
    await expect(s.server.maintenance.reset(s.admin, {})).rejects.toBeInstanceOf(MaintenanceError);

    const done = await s.server.maintenance.reset(s.admin, { xp: true, achievements: true, rating: true, stats: true, wallets: true });
    expect(done.xpEvents).toBeGreaterThan(0);
    expect((await s.server.progress.progressOf(s.player)).xp).toBe(0);
    expect(s.server.ledger.balance(accounts.wallet(s.player))).toBe(10_000);
    expect(s.server.ledger.balance(accounts.wallet(s.admin))).toBe(10_000);
    const after = await s.server.maintenance.counts(s.admin);
    expect(after).toMatchObject({ xpEvents: 0, players: 0, achievements: 0, ratings: 0, hands: 0, results: 0 });
  });

  it('vynuluje jednoho hráče (XP), ostatním nic nemění', async () => {
    const s = await start();
    s.server.progress.grant(s.player, 'a', 300);
    s.server.progress.grant(s.admin, 'b', 700);
    await s.server.progress.idle();
    await s.server.maintenance.resetUser(s.admin, s.player, { xp: true });
    expect((await s.server.progress.progressOf(s.player)).xp).toBe(0);
    expect((await s.server.progress.progressOf(s.admin)).xp).toBe(700);
  });

  it('ukončený turnaj jde smazat z historie; běžící ne; hráč bez oprávnění ne', async () => {
    const s = await start();
    const t = await s.server.tournaments.create(s.admin, { name: 'Historie', templateId: 'tour-turbo' });
    await expect(s.server.tournaments.deleteFromHistory(s.admin, t.id)).rejects.toThrow('STATE');
    await s.server.tournaments.cancel(s.admin, t.id);
    await expect(s.server.tournaments.deleteFromHistory(s.player, t.id)).rejects.toThrow('FORBIDDEN');
    await s.server.tournaments.deleteFromHistory(s.admin, t.id);
    expect((await s.server.tournaments.lobby()).some((x) => x.id === t.id)).toBe(false);
    await expect(s.server.tournaments.deleteFromHistory(s.admin, t.id)).rejects.toThrow('NOT_FOUND');
  });

  it('zavře otevřené stoly a zruší turnaje, žetony se vrátí', async () => {
    const s = await start();
    const { id } = await s.server.tables.createTable(s.admin, { name: 'Test', templateId: 'cash-klasika' });
    s.server.tables.get(id)!.join(s.player, 'Hrac', 0, 500);
    expect(s.server.ledger.balance(accounts.wallet(s.player))).toBe(9_500);
    const t = await s.server.tournaments.create(s.admin, { name: 'Testovací', templateId: 'tour-turbo' });
    const done = await s.server.maintenance.reset(s.admin, { games: true });
    expect(done).toMatchObject({ tables: 1, tournaments: 1 });
    expect(s.server.tables.get(id)).toBeUndefined();
    expect(s.server.tournaments.get(t.id)!.state().status).toBe('cancelled');
    expect(s.server.ledger.balance(accounts.wallet(s.player))).toBe(10_000);
  });
});
