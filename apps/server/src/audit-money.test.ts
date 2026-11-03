// Opravy z auditu 2. 11. 2026: souběžné schválení žádosti o dobití, souběžné zápisy živého cashe, ruční úprava herních účtů.
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { accounts } from '@kb/ledger';
import { buildServer } from './app.js';
import { PermissionError } from './auth/permissions.js';

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
    masterKey: { key: Buffer.alloc(32, 7), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 1000, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `M${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, admin: admin!, user };
}

describe('žádost o dobití', { timeout: 60_000 }, () => {
  const REQ = { 'economy.topupRequestsEnabled': true };
  it('dvě souběžná schválení dobijí jen jednou', async () => {
    const s = await start(REQ);
    const hrac = await s.user();
    const before = s.server.ledger.balance(accounts.wallet(hrac));
    const id = await s.server.wallet.createRequest(hrac, { kind: 'dobiti', amount: 100, message: 'prosím' });
    const results = await Promise.allSettled([s.server.wallet.decideRequest(s.admin, id, true), s.server.wallet.decideRequest(s.admin, id, true)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof PermissionError)).toHaveLength(1);
    expect(s.server.ledger.balance(accounts.wallet(hrac))).toBe(before + 100);
    // opakované vyřízení už vyřízené žádosti se odmítne
    await expect(s.server.wallet.decideRequest(s.admin, id, true)).rejects.toBeInstanceOf(PermissionError);
    expect(s.server.ledger.balance(accounts.wallet(hrac))).toBe(before + 100);
  });

  it('zamítnutí žádost uzavře a nic nedobije', async () => {
    const s = await start(REQ);
    const hrac = await s.user();
    const before = s.server.ledger.balance(accounts.wallet(hrac));
    const id = await s.server.wallet.createRequest(hrac, { kind: 'dobiti', amount: 100, message: 'prosím' });
    const r = await s.server.wallet.decideRequest(s.admin, id, false, 'ne');
    expect(r.status).toBe('rejected');
    expect(s.server.ledger.balance(accounts.wallet(hrac))).toBe(before);
  });
});

describe('živý cash: souběh', { timeout: 60_000 }, () => {
  it('souběžné buy-iny různých hráčů projdou a evidence sedí s knihou', async () => {
    const s = await start({ 'live.enabled': true, 'liveCash.enabled': true });
    const org = await s.user('organizator');
    const [a, b] = [await s.user(), await s.user()];
    const { id } = await s.server.liveCash.create(org, 'Souběh');
    await Promise.all([s.server.liveCash.buyIn(org, id, a, 300), s.server.liveCash.buyIn(org, id, b, 200), s.server.liveCash.buyIn(org, id, a, 50)]);
    expect(s.server.ledger.balance(accounts.table(id))).toBe(550);
    const v = await s.server.liveCash.view(id, org);
    expect(v.players.find((p) => p.userId === a)?.buyIns).toBe(350);
    expect(v.players.find((p) => p.userId === b)?.buyIns).toBe(200);
  });
});

describe('ruční úprava knihy', { timeout: 60_000 }, () => {
  it('nesmí sáhnout na účty běžících her', async () => {
    const s = await start();
    const hrac = await s.user();
    // úschova sázky je zamčená vždy, účet turnaje jen dokud turnaj běží (neznámý/skončený turnaj jde opravit)
    await expect(
      s.server.wallet.adjust(s.admin, [{ account: accounts.escrow('bet:neco'), amount: -10 }, { account: accounts.wallet(hrac), amount: 10 }], 'oprava'),
    ).rejects.toMatchObject({ code: 'INVALID', params: { reason: 'running_game' } });
    await expect(
      s.server.wallet.adjust(s.admin, [{ account: accounts.tournament('t-neco'), amount: -10 }, { account: accounts.wallet(hrac), amount: 10 }], 'oprava'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    // převod mezi peněženkou a mintem (opak dobití) projde
    const r = await s.server.wallet.adjust(s.admin, [{ account: accounts.wallet(hrac), amount: -10 }, { account: accounts.mint(), amount: 10 }], 'oprava');
    expect(r.done).toBe(true);
  });
});
