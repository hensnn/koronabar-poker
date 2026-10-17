import { afterEach, describe, expect, it } from 'vitest';
import { accounts } from '@kb/ledger';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { TableError } from './tables.js';

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
  let n = 0;
  const user = async (role?: string) => {
    const nick = `U${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  /** Nechá uživateli jen zadanou roli (bez výchozí role Hráč). */
  const only = async (userId: string, roleId: string) => {
    for (const a of server.perms.assignmentsOf(userId)) await server.perms.revokeAssignment(admin!, a.id);
    await server.perms.assignRole(admin!, userId, roleId);
  };
  return { server, clock, admin: admin!, user, only };
}
const err = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof TableError) return e.code;
    throw e;
  }
};

describe('lobby: zakládání stolů', () => {
  it('hráč založí stůl ze šablony a vidí ho v přehledu; stůl je okamžitě hratelný', async () => {
    const s = await start();
    const u = await s.user();
    const { id } = await s.server.tables.createTable(u, { name: 'Páteční hra', templateId: 'cash-klasika' });
    expect(id).toMatch(/^patecni-hra-[0-9a-f]{6}$/);
    const lobby = await s.server.tables.lobby();
    expect(lobby).toHaveLength(1);
    expect(lobby[0]).toMatchObject({ name: 'Páteční hra', seats: 9, seated: 0, smallBlind: 5, bigBlind: 10, minBuyInBb: 40, maxBuyInBb: 100, straddle: 'off' });
    expect(lobby[0]!.ownerId).toBe(u);
    s.server.tables.get(id)!.join(u, 'U', 0, 500);
    expect((await s.server.tables.lobby())[0]!.seated).toBe(1);
    expect((await s.server.audit.list({ action: 'stul.vytvorit' }))[0]!.targetId).toBe(id);
  });

  it('rake a jackpot jsou vidět v přehledu stolů (průhlednost pro hráče)', async () => {
    const s = await start();
    const u = await s.user();
    await s.server.tables.createTable(u, { name: 'S rake', templateId: 'cash-klasika', settings: { 'rake.enabled': true, 'rake.percent': 4, 'rake.cap': 20, 'jackpot.badBeatEnabled': true } });
    const row = (await s.server.tables.lobby())[0]!;
    expect(row).toMatchObject({ rakePercent: 4, rakeCap: 20, jackpot: 0 });
    const plain = await s.server.tables.createTable(u, { name: 'Bez rake', templateId: 'cash-klasika' });
    expect((await s.server.tables.lobby()).find((r) => r.id === plain.id)).toMatchObject({ rakePercent: 0, jackpot: null });
  });

  it('přepsání nastavení při založení se uloží; neplatné a nepovolené parametry se odmítnou', async () => {
    const s = await start();
    const u = await s.user();
    const ok = await s.server.tables.createTable(u, { name: 'Dražší', templateId: 'cash-klasika', settings: { 'table.smallBlind': 25, 'table.bigBlind': 50, 'table.straddleEnabled': true } });
    expect(s.server.tables.settingsOf(ok.id)!['table.bigBlind']).toBe(50);
    expect((await s.server.tables.lobby())[0]!.straddle).toBe('optional');
    const bad = async (settings: Record<string, unknown>) => {
      try {
        await s.server.tables.createTable(u, { name: 'Zlý', templateId: 'cash-klasika', settings });
        return 'OK';
      } catch (e) {
        return (e as TableError).issues.map((i) => i.messageKey).join(',');
      }
    };
    expect(await bad({ 'table.smallBlind': 50, 'table.bigBlind': 10 })).toBe('rule.smallBlindAboveBig');
    expect(await bad({ 'cash.minBuyInBb': 500, 'cash.maxBuyInBb': 100 })).toBe('rule.minBuyInAboveMax');
    expect(await bad({ 'neexistuje': 1 })).toBe('validation.unknownKey');
    expect(await bad({ 'economy.currencyName': 'Hacked' })).toBe('validation.unknownKey'); // jen globální
    expect(await bad({ 'ui.colorMode': 'dark' })).toBe('validation.unknownKey'); // osobní
    expect(await bad({ 'table.seats': 99 })).toBe('validation.invalid.int');
    expect(await err(s.server.tables.createTable(u, { name: 'x', templateId: 'cash-klasika' }))).toBe('INVALID');
    expect(await err(s.server.tables.createTable(u, { name: 'Dobrý název', templateId: 'neexistuje' }))).toBe('INVALID');
  });

  it('bez oprávnění (host, nováček) stůl založit nejde', async () => {
    const s = await start();
    const host = await s.user();
    await s.only(host, s.server.perms.roleByKey('host')!.id);
    expect(await err(s.server.tables.createTable(host, { name: 'Host hra', templateId: 'cash-klasika' }))).toBe('FORBIDDEN');
  });

  it('limity z oprávnění: počet současných stolů a největší buy-in', async () => {
    const s = await start();
    const main = s.admin;
    const roleId = await s.server.perms.createRole(main, { key: 'maly_organizator', name: 'Malý', power: 25, permissions: [{ key: 'cash.vytvorit_vlastni', limits: { maxConcurrent: 2, maxBuyIn: 1000 } }, { key: 'stul.zobrazit' }] });
    const org = await s.user();
    await s.only(org, roleId);
    await s.server.tables.createTable(org, { name: 'První stůl', templateId: 'cash-klasika' });
    await s.server.tables.createTable(org, { name: 'Druhý stůl', templateId: 'cash-klasika' });
    expect(await err(s.server.tables.createTable(org, { name: 'Třetí stůl', templateId: 'cash-klasika' }))).toBe('LIMIT_EXCEEDED');
    const org2 = await s.user();
    await s.only(org2, roleId);
    // max buy-in = 100 BB × 50 = 5000 > 1000
    expect(await err(s.server.tables.createTable(org2, { name: 'Drahý stůl', templateId: 'cash-klasika', settings: { 'table.smallBlind': 25, 'table.bigBlind': 50 } }))).toBe('LIMIT_EXCEEDED');
    expect(await err(s.server.tables.createTable(org2, { name: 'Levný stůl', templateId: 'cash-klasika', settings: { 'table.smallBlind': 5, 'table.bigBlind': 10 } }))).toBe('OK');
  });
});

describe('lobby: úprava a zrušení stolu', () => {
  async function table() {
    const s = await start();
    const owner = await s.user();
    const { id } = await s.server.tables.createTable(owner, { name: 'Můj stůl', templateId: 'cash-klasika' });
    return { ...s, owner, id };
  }

  it('zakladatel upraví parametry „kdykoli“ hned; cizí hráč nesmí, správce ano', async () => {
    const s = await table();
    const other = await s.user();
    expect(await err(s.server.tables.updateSettings(other, s.id, { 'time.turnSeconds': 10 }))).toBe('FORBIDDEN');
    const r = await s.server.tables.updateSettings(s.owner, s.id, { 'time.turnSeconds': 10 });
    expect(r).toEqual({ applied: ['time.turnSeconds'], pending: [] });
    expect(s.server.tables.settingsOf(s.id)!['time.turnSeconds']).toBe(10);
    expect(await err(s.server.tables.updateSettings(s.admin, s.id, { 'time.turnSeconds': 12 }))).toBe('OK');
    expect(s.server.tables.settingsOf(s.id)!['time.turnSeconds']).toBe(12);
    const after = (await s.server.audit.list({ action: 'nastaveni.zmena' }))[0]!;
    expect(after.actorId).toBe(s.admin);
    expect(after.targetId).toBe(s.id);
    // změna se oznámí systémovou zprávou v chatu stolu
    await new Promise((r) => setTimeout(r, 100));
    const channelId = (await s.server.chat.channelIdByKey('table:' + s.id))!;
    const msgs = await s.server.chat.history(s.admin, channelId);
    expect(msgs.some((m) => m.system && m.body.includes('Nastavení stolu se změnilo'))).toBe(true);
  });

  it('konzistence se kontroluje při změně; cizí a nepovolené klíče se odmítnou', async () => {
    const s = await table();
    expect(await err(s.server.tables.updateSettings(s.owner, s.id, { 'table.smallBlind': 500 }))).toBe('INVALID');
    expect(await err(s.server.tables.updateSettings(s.owner, s.id, { 'system.rateLimitBurst': 1000 }))).toBe('INVALID');
    expect(await err(s.server.tables.updateSettings(s.owner, 'nic', { 'time.turnSeconds': 10 }))).toBe('NOT_FOUND');
  });

  it('parametry „jen mezi handami“ se uprostřed handy odloží a použijí po jejím skončení', async () => {
    const s = await table();
    const [a, b] = [await s.user(), await s.user()];
    const t = s.server.tables.get(s.id)!;
    t.join(a, 'A', 0, 500);
    t.join(b, 'B', 1, 500);
    s.clock.advance(3100);
    expect(t.handInProgress()).toBe(true);
    const r = await s.server.tables.updateSettings(s.owner, s.id, { 'table.bigBlind': 20, 'table.smallBlind': 10 });
    expect(r.pending.sort()).toEqual(['table.bigBlind', 'table.smallBlind']);
    expect(s.server.tables.settingsOf(s.id)!['table.bigBlind']).toBe(10);
    expect(s.server.tables.pendingChanges(s.id)['table.bigBlind']).toBe(20);
    const v = t.viewFor(a);
    t.act(v.seats.find((x) => x.seat === v.actingSeat)!.playerId, { type: 'fold' });
    await new Promise((r2) => setTimeout(r2, 50));
    expect(s.server.tables.settingsOf(s.id)!['table.bigBlind']).toBe(20);
    expect(s.server.tables.pendingChanges(s.id)).toEqual({});
    s.clock.advance(3100);
    expect(t.viewFor(a).info.bigBlind).toBe(20);
  });

  it('parametry „jen před startem“ po prvním rozdání nelze měnit', async () => {
    const s = await table();
    expect(await err(s.server.tables.updateSettings(s.owner, s.id, { 'table.seats': 6 }))).toBe('OK');
    const [a, b] = [await s.user(), await s.user()];
    const t = s.server.tables.get(s.id)!;
    t.join(a, 'A', 0, 500);
    t.join(b, 'B', 1, 500);
    s.clock.advance(3100);
    expect(await err(s.server.tables.updateSettings(s.owner, s.id, { 'table.seats': 8 }))).toBe('DENIED');
    expect(s.server.tables.settingsOf(s.id)!['table.seats']).toBe(6);
  });

  it('zrušení stolu: zakladatel nebo správce; hráčům se vrátí žetony, stůl zmizí z přehledu i po restartu', async () => {
    const s = await table();
    const other = await s.user();
    const p = await s.user();
    s.server.tables.get(s.id)!.join(p, 'P', 3, 700);
    expect(await err(s.server.tables.closeTable(other, s.id))).toBe('FORBIDDEN');
    expect(await err(s.server.tables.closeTable(s.owner, s.id))).toBe('OK');
    expect(s.server.ledger.balance(accounts.wallet(p))).toBe(10_000);
    expect(s.server.ledger.balance(accounts.table(s.id))).toBe(0);
    expect(await s.server.tables.lobby()).toHaveLength(0);
    expect(await err(s.server.tables.closeTable(s.owner, s.id))).toBe('NOT_FOUND');
    const { id } = await s.server.tables.createTable(s.owner, { name: 'Další stůl', templateId: 'cash-klasika' });
    expect(await err(s.server.tables.closeTable(s.admin, id))).toBe('OK');
  });
});
