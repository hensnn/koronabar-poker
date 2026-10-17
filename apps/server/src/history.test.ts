import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { HistoryError } from './history.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start() {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
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
  return { server, clock, admin: admin!, player };
}

describe('správa historie', () => {
  it('přehled ukazuje skončené věci; zavřený stůl a skončený turnaj jde smazat; otevřené ne; hráč nesmí', async () => {
    const s = await start();
    const { id: tableId } = await s.server.tables.createTable(s.admin, { name: 'Starý stůl', templateId: 'cash-klasika' });
    const t = await s.server.tournaments.create(s.admin, { name: 'Starý turnaj', templateId: 'tour-turbo' });
    let o = await s.server.history.overview(s.admin);
    expect(o.items.some((x) => x.kind === 'cashTable' && x.id === tableId)).toBe(false);
    expect(o.items.some((x) => x.kind === 'tournament' && x.id === t.id)).toBe(false);

    await expect(s.server.history.remove(s.admin, 'cashTable', tableId)).rejects.toThrow('STATE');
    await s.server.tables.closeTable(s.admin, tableId);
    await s.server.tournaments.cancel(s.admin, t.id);
    o = await s.server.history.overview(s.admin);
    expect(o.items.some((x) => x.kind === 'cashTable' && x.id === tableId)).toBe(true);
    expect(o.items.some((x) => x.kind === 'tournament' && x.id === t.id)).toBe(true);

    await expect(s.server.history.remove(s.player, 'cashTable', tableId)).rejects.toBeInstanceOf(HistoryError);
    await s.server.history.remove(s.admin, 'cashTable', tableId);
    await s.server.history.remove(s.admin, 'tournament', t.id);
    o = await s.server.history.overview(s.admin);
    expect(o.items.some((x) => x.id === tableId || x.id === t.id)).toBe(false);
    await expect(s.server.history.remove(s.admin, 'cashTable', tableId)).rejects.toThrow('NOT_FOUND');
  });

  it('mazání starých hand podle stáří', async () => {
    const s = await start();
    expect(await s.server.history.purgeHands(s.admin, 30)).toBe(0);
    await expect(s.server.history.purgeHands(s.player, 30)).rejects.toThrow('FORBIDDEN');
  });
});
