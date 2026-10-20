import { afterEach, describe, expect, it } from 'vitest';
import { accounts } from '@kb/ledger';
import { FakeClock } from '@kb/game-core';
import { buildServer } from './app.js';
import { schema } from './db/index.js';
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

  it('nový start účetní knihy: historie pryč, každý má počáteční zůstatek, kniha zůstává vyrovnaná', async () => {
    const s = await start();
    await s.server.wallet.topUp(s.admin, s.player, 777, 'test');
    const { id } = await s.server.tables.createTable(s.admin, { name: 'Blokuje', templateId: 'cash-klasika' });
    await expect(s.server.maintenance.resetLedger(s.admin)).rejects.toThrow('INVALID');
    await s.server.tables.closeTable(s.admin, id);
    await expect(s.server.maintenance.resetLedger(s.player)).rejects.toThrow('FORBIDDEN');
    const r = await s.server.maintenance.resetLedger(s.admin);
    expect(r.transactionsDeleted).toBeGreaterThan(0);
    expect(s.server.ledger.balance(accounts.wallet(s.player))).toBe(10_000);
    expect(s.server.ledger.balance(accounts.wallet(s.admin))).toBe(10_000);
    expect(s.server.ledger.balance(accounts.house())).toBe(0);
    expect(s.server.ledger.transactions().length).toBe(r.users);
    // zápis do DB odpovídá paměti
    const rows = await s.server.db.select().from(schema.ledgerTransactions);
    expect(rows.length).toBe(r.users);
    expect(s.server.ledger.totalIsZero([accounts.mint(), accounts.house(), accounts.wallet(s.player), accounts.wallet(s.admin)])).toBe(true);
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

describe('údržba: příprava na ostrý provoz', () => {
  it('smaže chat, upozornění, historii a peněženky nastaví na nulu; uživatelé a nastavení zůstanou', async () => {
    const s = await start();
    await s.server.wallet.topUp(s.admin, s.player, 777, 'test');
    // chat: zprávy v hlavním kanálu (i systémová) a reakce
    const main = await s.server.chat.ensureMainChannel();
    const m1 = await s.server.chat.send(s.player, main, 'ahoj z testu');
    await s.server.chat.send(s.admin, main, 'druhá zpráva');
    await s.server.chat.system(main, 'systémová zpráva');
    expect(m1).toBeTruthy();
    // upozornění
    await s.server.db.insert(schema.notifications).values([{ userId: s.player, kind: 'tournamentOpen', params: { name: 'T', time: '', minutes: 0 }, link: null }]);
    // zkušební stůl: hotový (zavřený) i s handami z historie
    const { id } = await s.server.tables.createTable(s.admin, { name: 'Zkušební', templateId: 'cash-klasika' });
    await s.server.tables.closeTable(s.admin, id);
    const before = await s.server.maintenance.counts(s.admin);
    expect(before.chatMessages).toBeGreaterThanOrEqual(3);
    expect(before.notifications).toBe(1);
    expect(before.historyItems).toBeGreaterThanOrEqual(1);
    expect(before.walletsNonZero).toBeGreaterThan(0);

    await expect(s.server.maintenance.prepareLaunch(s.player, { chat: true })).rejects.toBeInstanceOf(MaintenanceError);
    await expect(s.server.maintenance.prepareLaunch(s.admin, {})).rejects.toBeInstanceOf(MaintenanceError);

    const done = await s.server.maintenance.prepareLaunch(s.admin, { games: true, progress: true, history: true, chat: true, notifications: true, wallets: true });
    expect(done.chatMessages).toBeGreaterThanOrEqual(3);
    expect(done.notifications).toBe(1);
    expect(done.wallets).toBe(2);

    const after = await s.server.maintenance.counts(s.admin);
    expect(after).toMatchObject({ chatMessages: 0, chatImages: 0, notifications: 0, historyItems: 0, walletsNonZero: 0, walletsTotal: 0 });
    // peněženky jsou na nule a kniha je vyrovnaná
    expect(s.server.ledger.balance(accounts.wallet(s.player))).toBe(0);
    expect(s.server.ledger.balance(accounts.wallet(s.admin))).toBe(0);
    // uživatelé zůstali, hlavní kanál chatu také (jen prázdný)
    const users = await s.server.db.select({ id: schema.users.id }).from(schema.users);
    expect(users.map((u) => u.id).sort()).toEqual([s.admin, s.player].sort());
    expect(await s.server.chat.history(s.player, main, {})).toEqual([]);
    // šablony a nastavení zůstaly
    expect(s.server.templates.list('cash').length).toBeGreaterThan(0);
  });

  it('každou oblast jde spustit zvlášť: jen chat nechá peněženky být', async () => {
    const s = await start();
    await s.server.wallet.topUp(s.admin, s.player, 500, 'test');
    const main = await s.server.chat.ensureMainChannel();
    await s.server.chat.send(s.player, main, 'zpráva');
    const bal = s.server.ledger.balance(accounts.wallet(s.player));
    await s.server.maintenance.prepareLaunch(s.admin, { chat: true });
    expect(s.server.ledger.balance(accounts.wallet(s.player))).toBe(bal);
    expect((await s.server.maintenance.counts(s.admin)).chatMessages).toBe(0);
  });
});

describe('údržba: mazání uživatelů a úplný reset', () => {
  it('smaže vybrané uživatele, zůstatek vrátí do mint, správce a sedící přeskočí', async () => {
    const s = await start();
    const mk = async (nick: string) => {
      const inv = await s.server.accounts.createInvite(s.admin, {});
      return (await s.server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick.toLowerCase()}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true })).userId;
    };
    const b = await mk('Smazat1');
    const c = await mk('Sedi');
    await s.server.wallet.topUp(s.admin, b, 500, 'test');
    const { id } = await s.server.tables.createTable(s.admin, { name: 'Obsazený', templateId: 'cash-klasika' });
    const actor = s.server.tables.actors.get(id)!;
    const info = actor.viewFor(null).info;
    actor.join(c, 'Sedi', 0, Math.ceil(info.minBuyIn / info.chipsPerCurrencyUnit));
    const total = () => ['mint', 'house'].reduce((n, k) => n + s.server.ledger.balance(k === 'mint' ? accounts.mint() : accounts.house()), 0);
    const mintBefore = s.server.ledger.balance(accounts.mint());

    await expect(s.server.maintenance.deleteUsers(s.player, [b])).rejects.toBeInstanceOf(MaintenanceError);
    const r = await s.server.maintenance.deleteUsers(s.admin, [b, c, s.admin, '00000000-0000-4000-8000-000000000000']);
    expect(r.deleted).toEqual([b]);
    expect(r.skipped.map((x) => `${x.nickname}:${x.reason}`).sort()).toEqual([':notFound', 'Admin:admin', 'Sedi:seated']);
    // zůstatek smazaného se vrátil do mint, kniha je vyrovnaná
    expect(s.server.ledger.balance(accounts.mint())).toBe(mintBefore + 500 + 10_000);
    expect(total()).toBeLessThan(0);
    const users = await s.server.db.select({ id: schema.users.id }).from(schema.users);
    expect(users.map((u) => u.id)).not.toContain(b);
    expect(users.map((u) => u.id)).toContain(c);
  });

  it('úplný reset: všechny tabulky prázdné, požádá o restart; smí jen hlavní správce', async () => {
    let restarted = 0;
    const server = await buildServer({
      clock: new FakeClock(),
      emailWorker: false,
      masterKey: { key: Buffer.alloc(32, 3), version: 1 },
      settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 10_000 },
      bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
      defaultTable: false,
      onRestartRequested: () => void restarted++,
    });
    servers.push(server);
    const [admin] = server.perms.mainAdminIds();
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId: player } = await server.accounts.register({ inviteCode: inv, nickname: 'Hrac', email: 'hrac@example.cz', password: 'heslo-hrace-123', acceptTerms: true });
    await expect(server.maintenance.factoryReset(player)).rejects.toBeInstanceOf(MaintenanceError);
    const main = await server.chat.ensureMainChannel();
    await server.chat.send(player, main, 'ahoj');
    const r = await server.maintenance.factoryReset(admin!);
    expect(r.tables).toBeGreaterThan(30);
    expect(restarted).toBe(1);
    expect((await server.db.select({ id: schema.users.id }).from(schema.users)).length).toBe(0);
    expect((await server.db.select({ id: schema.chatMessages.id }).from(schema.chatMessages)).length).toBe(0);
    expect(server.ledger.balance(accounts.wallet(player))).toBe(0);
  });
});
