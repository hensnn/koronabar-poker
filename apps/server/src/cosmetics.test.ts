import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@kb/game-core';
import { accounts } from '@kb/ledger';
import { buildServer } from './app.js';
import { CosmeticError } from './cosmetics.js';
import { schema } from './db/index.js';
import { PassthroughProcessor } from './audio.js';

type Server = Awaited<ReturnType<typeof buildServer>>;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function start(settings: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const server = await buildServer({
    clock,
    scheduler: false,
    emailWorker: false,
    masterKey: { key: Buffer.alloc(32, 29), version: 1 },
    settingsOverride: { 'system.emailVerificationRequired': false, 'system.publicUrl': 'http://localhost', 'economy.startingBalance': 2000, ...settings },
    bootstrapAdmin: { nickname: 'Admin', password: 'admin-heslo-123' },
    defaultTable: false,
    audioProcessor: new PassthroughProcessor(1500),
  });
  servers.push(server);
  const [admin] = server.perms.mainAdminIds();
  let n = 0;
  const user = async (role?: string) => {
    const nick = `K${n++}x`;
    const inv = await server.accounts.createInvite(admin!, {});
    const { userId } = await server.accounts.register({ inviteCode: inv, nickname: nick, email: `${nick}@example.cz`, password: 'heslo-hrace-123', acceptTerms: true });
    if (role) await server.perms.assignRole(admin!, userId, server.perms.roleByKey(role)!.id);
    return userId;
  };
  return { server, clock, admin: admin!, user };
}

type Ctx = Awaited<ReturnType<typeof start>>;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof CosmeticError) return e.code;
    throw e;
  }
};
const wallet = (c: Ctx, u: string) => c.server.ledger.balance(accounts.wallet(u));
const item = async (c: Ctx, u: string, key: string) => (await c.server.cosmetics.catalog(u)).items.find((i) => i.key === key)!;

describe('kosmetika a obchod', { timeout: 90_000 }, () => {
  it('vestavěný katalog existuje a koupě je jedna transakce peněženka → dům, jen jednou', async () => {
    const c = await start();
    const u = await c.user();
    const cat = await c.server.cosmetics.catalog(u);
    expect(cat.items.length).toBeGreaterThanOrEqual(20);
    expect(cat.canManage).toBe(false);
    const house0 = c.server.ledger.balance(accounts.house());
    const w0 = wallet(c, u);
    await c.server.cosmetics.buy(u, 'frame_gold');
    expect(wallet(c, u)).toBe(w0 - 400);
    expect(c.server.ledger.balance(accounts.house())).toBe(house0 + 400);
    expect((await item(c, u, 'frame_gold')).owned).toBe(true);
    expect(await code(c.server.cosmetics.buy(u, 'frame_gold'))).toBe('OWNED');
    expect(wallet(c, u)).toBe(w0 - 400);
    // předmět, který se neprodává, a neexistující
    expect(await code(c.server.cosmetics.buy(u, 'frame_royal'))).toBe('NOT_FOR_SALE');
    expect(await code(c.server.cosmetics.buy(u, 'nope'))).toBe('NOT_FOUND');
    // nedostatek peněz nic nestrhne
    await c.server.cosmetics.buy(u, 'back_stripes');
    await c.server.cosmetics.buy(u, 'slots_plus5');
    const left = wallet(c, u);
    expect(await code(c.server.cosmetics.buy(u, 'slots_plus10'))).toBe('INSUFFICIENT_FUNDS');
    expect(wallet(c, u)).toBe(left);
  });

  it('sleva, vypnutý obchod a časové okno', async () => {
    const c = await start({ 'cosmetics.discountPercent': 50 });
    const u = await c.user();
    const curator = await c.user('kurator');
    expect((await item(c, u, 'frame_gold')).price).toBe(200);
    const w0 = wallet(c, u);
    await c.server.cosmetics.buy(u, 'frame_gold');
    expect(wallet(c, u)).toBe(w0 - 200);

    const key = await c.server.cosmetics.create(curator, { kind: 'title', name: 'Letní titul', look: { color: 'info' }, acquire: {}, price: 10, availableFrom: c.clock.now() + 60_000, availableUntil: c.clock.now() + 120_000 });
    expect(await code(c.server.cosmetics.buy(u, key))).toBe('NOT_AVAILABLE');
    c.clock.advance(70_000);
    await c.server.cosmetics.buy(u, key);
    const key2 = await c.server.cosmetics.create(curator, { kind: 'title', name: 'Krátká akce', look: { color: 'info' }, acquire: {}, price: 10, availableUntil: c.clock.now() + 1000 });
    c.clock.advance(2000);
    expect(await code(c.server.cosmetics.buy(u, key2))).toBe('NOT_AVAILABLE');

    await c.server.settings.set(c.admin, 'global', '', 'cosmetics.shopEnabled', false);
    expect(await code(c.server.cosmetics.buy(u, 'name_gold'))).toBe('DISABLED');
  });

  it('předměty za úspěch a level se udělí samy, ostatní ne; za sezónu jen uzavřená', async () => {
    const c = await start({ 'xp.levelBase': 1, 'xp.levelExponentPercent': 100, 'stats.leaderboardMinHands': 0 });
    const u = await c.user();
    const other = await c.user();
    expect((await item(c, u, 'trophy_royal')).owned).toBe(false);
    await c.server.db.insert(schema.playerAchievements).values({ userId: u, key: 'royal_flush' });
    expect(await c.server.cosmetics.sync(u)).toEqual(expect.arrayContaining(['frame_royal', 'trophy_royal']));
    expect((await item(c, u, 'trophy_royal')).source).toBe('achievement');
    expect((await item(c, other, 'trophy_royal')).owned).toBe(false);
    expect(await c.server.cosmetics.sync(u)).toEqual([]); // podruhé nic

    c.server.progress.grant(u, 'test', 200_000);
    await c.server.progress.idle();
    await c.server.cosmetics.sync(u); // postup na level ho udělil sám, ruční kontrola už nic nového nenajde
    await c.server.cosmetics.idle();
    const owned = (await c.server.cosmetics.catalog(u)).items.filter((i) => i.owned).map((i) => i.key);
    expect(owned).toEqual(expect.arrayContaining(['frame_bronze', 'frame_silver', 'fx_pulse', 'name_green', 'title_regular']));
    expect(owned).not.toContain('frame_gold');

    // sezóna: dokud neskončí, trofej není; po skončení ji dostane vítěz, druhý stříbro
    const now = c.clock.now();
    await c.server.stats.createSeason(c.admin, { name: 'Podzim', startsAt: now - 20_000, endsAt: now + 60_000 });
    const at = new Date(now - 10_000);
    await c.server.db.insert(schema.hands).values({ id: 'sz-1', tableId: 'tx', kind: 'cash', handNumber: 1, playedAt: at, pot: 400, blinds: { sb: 5, bb: 10, ante: 0 }, chipsPerUnit: 1 });
    await c.server.db.insert(schema.handPlayers).values([
      { handId: 'sz-1', userId: u, seat: 0, kind: 'cash', playedAt: at, startStack: 1000, invested: 200, won: 400 },
      { handId: 'sz-1', userId: other, seat: 1, kind: 'cash', playedAt: at, startStack: 1000, invested: 200, won: 0 },
    ]);
    await c.server.cosmetics.syncAll();
    expect((await item(c, u, 'trophy_season_gold')).owned).toBe(false);
    c.clock.advance(61_000);
    await c.server.cosmetics.syncAll();
    expect((await item(c, u, 'trophy_season_gold')).source).toBe('season');
    expect((await item(c, other, 'trophy_season_gold')).owned).toBe(false);
    expect((await item(c, other, 'trophy_season_silver')).owned).toBe(true);
  });

  it('nošení: z každého druhu jeden, trofejí do limitu, jen vlastněné; ostatní vidí veřejný vzhled', async () => {
    const c = await start({ 'cosmetics.maxTrophies': 1 });
    const u = await c.user();
    const viewer = await c.user();
    expect(await code(c.server.cosmetics.equip(u, 'frame_gold', true))).toBe('NOT_OWNED');
    await c.server.cosmetics.buy(u, 'frame_gold');
    await c.server.cosmetics.buy(u, 'frame_winner');
    await c.server.cosmetics.buy(u, 'name_gold');
    await c.server.cosmetics.buy(u, 'trophy_hundred');
    await c.server.db.insert(schema.playerCosmetics).values({ userId: u, itemKey: 'trophy_royal', source: 'grant' });
    await c.server.cosmetics.equip(u, 'frame_gold', true);
    await c.server.cosmetics.equip(u, 'frame_winner', true); // vymění předchozí
    await c.server.cosmetics.equip(u, 'name_gold', true);
    await c.server.cosmetics.equip(u, 'trophy_hundred', true);
    expect(await code(c.server.cosmetics.equip(u, 'trophy_royal', true))).toBe('LIMIT');
    expect(await code(c.server.cosmetics.equip(u, 'slots_plus5', true))).toBe('INVALID');

    const [look] = await c.server.cosmetics.looks([u]);
    expect(look).toMatchObject({ frame: { color: 'success', style: 'dashed' }, nameColor: 'warning', title: null });
    expect(look!.trophies.map((t) => t.key)).toEqual(['trophy_hundred']);
    expect((await item(c, u, 'frame_gold')).equipped).toBe(false);
    expect((await c.server.cosmetics.looks([viewer]))[0]).toMatchObject({ frame: null, nameColor: null, trophies: [] });

    await c.server.cosmetics.equip(u, 'frame_winner', false);
    expect((await c.server.cosmetics.looks([u]))[0]!.frame).toBeNull();

    // rub karet a plsť vidí jen majitel
    await c.server.cosmetics.buy(u, 'back_dots');
    await c.server.cosmetics.buy(u, 'felt_sea');
    await c.server.cosmetics.equip(u, 'back_dots', true);
    await c.server.cosmetics.equip(u, 'felt_sea', true);
    expect(await c.server.cosmetics.mineTable(u)).toEqual({ cardBack: { color: 'accent', style: 'dots' }, felt: 'info' });
    expect(await c.server.cosmetics.mineTable(viewer)).toEqual({ cardBack: null, felt: null });

    // vypnuté předměty se u nikoho nezobrazují
    await c.server.settings.set(c.admin, 'global', '', 'cosmetics.enabled', false);
    expect((await c.server.cosmetics.looks([u]))[0]!.nameColor).toBeNull();
  });

  it('slot navíc zvedne limit zvuků', async () => {
    const c = await start({ 'sounds.maxPerUser': 1 });
    const u = await c.user();
    expect(await c.server.cosmetics.extraSoundSlots(u)).toBe(0);
    await c.server.cosmetics.buy(u, 'slots_plus5');
    expect(await c.server.cosmetics.extraSoundSlots(u)).toBe(5);
  });

  it('katalog spravuje jen kurátor; vlastněný předmět se jen stáhne, nevlastněný smaže; přidělení', async () => {
    const c = await start();
    const u = await c.user();
    const curator = await c.user('kurator');
    const input = { kind: 'frame' as const, name: 'Vlastní rámeček', look: { color: 'primary' as const, style: 'solid' }, acquire: {}, price: 50 };
    expect(await code(c.server.cosmetics.create(u, input))).toBe('FORBIDDEN');
    expect(await code(c.server.cosmetics.create(curator, { ...input, look: { color: 'primary', style: 'nic' } }))).toBe('INVALID');
    expect(await code(c.server.cosmetics.create(curator, { ...input, name: 'x' }))).toBe('INVALID');
    const key = await c.server.cosmetics.create(curator, input);
    expect((await c.server.cosmetics.catalog(u)).items.some((i) => i.key === key)).toBe(true);
    expect(await code(c.server.cosmetics.update(curator, key, { kind: 'title' }))).toBe('INVALID');
    await c.server.cosmetics.update(curator, key, { price: 80 });
    expect((await item(c, u, key)).price).toBe(80);

    await c.server.cosmetics.buy(u, key);
    expect(await c.server.cosmetics.remove(curator, key)).toEqual({ deleted: false });
    const cat = await c.server.cosmetics.catalog(u);
    expect(cat.items.find((i) => i.key === key)).toMatchObject({ owned: true, enabled: false });
    expect((await c.server.cosmetics.catalog(await c.user())).items.some((i) => i.key === key)).toBe(false);

    const key2 = await c.server.cosmetics.create(curator, input);
    expect(await c.server.cosmetics.remove(curator, key2)).toEqual({ deleted: true });

    await c.server.cosmetics.grant(curator, u, 'frame_royal');
    expect(await code(c.server.cosmetics.grant(curator, u, 'frame_royal'))).toBe('OWNED');
    expect(await code(c.server.cosmetics.grant(u, u, 'frame_bronze'))).toBe('FORBIDDEN');
  });

  it('celkový součet knihy se po nákupech nezmění', async () => {
    const c = await start();
    const [a, b] = [await c.user(), await c.user()];
    const total = () => c.server.ledger.balance(accounts.wallet(a)) + c.server.ledger.balance(accounts.wallet(b)) + c.server.ledger.balance(accounts.house());
    const before = total();
    await c.server.cosmetics.buy(a, 'frame_gold');
    await c.server.cosmetics.buy(b, 'name_gold');
    await Promise.all([c.server.cosmetics.buy(a, 'felt_sea'), c.server.cosmetics.buy(a, 'felt_sea').catch(() => undefined)]);
    expect(total()).toBe(before);
  });
});
