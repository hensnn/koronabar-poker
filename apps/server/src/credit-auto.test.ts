import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { accounts } from '@kb/ledger';
import { buildServer } from './app.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(settings: Record<string, unknown> = {}) {
  const server = await buildServer({
    clock: new FakeClock(),
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 23), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 30, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `C${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, admin: admin!, user };
}

const LIVE = { 'tournament.live': true, 'tournament.minPlayers': 2, 'tournament.buyIn': 100, 'tournament.fee': 0, 'tournament.startingStack': 1500, 'table.seats': 9, 'tournament.payoutPreset': 'wta' };

describe('předschválený úvěr při platbě za hru', { timeout: 90_000 }, () => {
  it('hráči, kterému chybí na vstup do turnaje, se chybějící část sama načerpá na dluh; bez úvěru se vstup odmítne', async () => {
    const s = await start({ 'economy.creditLimit': 200 });
    const org = await s.user('organizator');
    const [a, b] = [await s.user(), await s.user()];
    const { id } = await s.server.tournaments.create(org, { name: 'Bez peněz', templateId: 'tour-turbo', settings: LIVE });
    await s.server.tournaments.liveRegister(org, id, a); // má 30, vstup 100 → 70 na dluh
    expect(s.server.ledger.balance(accounts.wallet(a))).toBe(0);
    expect(s.server.wallet.creditInfo(a)).toMatchObject({ debt: 70, limit: 200, available: 130 });
    expect(s.server.ledger.balance(accounts.tournament(id))).toBe(100);

    // správce hráči b úvěr odebere: vstup se odmítne a nic se nestrhne
    await s.server.wallet.setCreditLimit(s.admin, b, 0);
    await expect(s.server.tournaments.liveRegister(org, id, b)).rejects.toThrow();
    expect(s.server.ledger.balance(accounts.wallet(b))).toBe(30);
    expect(s.server.wallet.creditInfo(b).debt).toBe(0);
    // po zvýšení limitu to jde
    await s.server.wallet.setCreditLimit(s.admin, b, 100);
    await s.server.tournaments.liveRegister(org, id, b);
    expect(s.server.wallet.creditInfo(b).debt).toBe(70);

    // součet celé knihy sedí (vydané Korony = peněženky + turnaj + dům)
    await s.server.journal.flush();
    const rec = (await s.server.wallet.balances(s.admin)).reconciliation;
    expect(rec.issued).toBe(rec.wallets + rec.house + rec.funds + rec.tables + rec.tournaments + rec.external);
    expect(rec.byKind.find((k) => k.kind === 'credit_draw')).toMatchObject({ issued: 140, count: 2 });

    // zrušení turnaje: vrácený vstup se nejdřív použije na splacení kontokorentu (priorita), zbytek zůstane hráči
    await s.server.tournaments.cancel(org, id);
    await s.server.journal.flush();
    for (const p of [a, b]) {
      expect(s.server.wallet.creditInfo(p).debt).toBe(0);
      expect(s.server.ledger.balance(accounts.wallet(p))).toBe(30); // původních 30, dluh 70 se splatil z vráceného vstupu 100
    }
    const after = (await s.server.wallet.balances(s.admin)).reconciliation;
    expect(after.byKind.find((k) => k.kind === 'credit_repay')).toMatchObject({ destroyed: 140, count: 2 });
  });
});
