import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { permissionKeys, PRESET_ROLES } from '@kb/shared';
import { openPglite, schema, type Database } from '../db/index.js';
import { AuditService } from './audit.js';
import { PermissionError, PermissionService } from './permissions.js';
import { seedRoles } from './seed.js';

let database: Database | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});

async function setup(now: () => Date = () => new Date()) {
  database = await openPglite();
  const { db } = database;
  const audit = new AuditService(db);
  const perms = new PermissionService(db, audit, now);
  await seedRoles(db, perms);
  let n = 0;
  const user = async (nick: string, roleKey?: string, status = 'active') => {
    const [u] = await db.insert(schema.users).values({ nickname: nick, nicknameLower: `${nick.toLowerCase()}${n++}`, passwordHash: 'x', status }).returning({ id: schema.users.id });
    if (roleKey) await perms.grantUnchecked(u!.id, perms.roleByKey(roleKey)!.id);
    else await perms.reload();
    return u!.id;
  };
  const role = (key: string) => perms.roleByKey(key)!;
  return { db, audit, perms, user, role };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof PermissionError) return e.code;
    throw e;
  }
};

describe('katalog a předpřipravené role', () => {
  it('seed vytvoří všechny role a hlavní administrátor má všechna oprávnění', async () => {
    const s = await setup();
    expect(s.perms.listRoles().map((r) => r.key).sort()).toEqual(PRESET_ROLES.map((r) => r.key).sort());
    const admin = await s.user('Hlavni', 'main_admin');
    for (const key of permissionKeys()) expect(s.perms.can(admin, key).allowed, key).toBe(true);
    expect(s.perms.can(admin, 'mena.dobit').limits).toBeUndefined();
    expect(s.perms.isMainAdmin(admin)).toBe(true);
  });

  it('seed je idempotentní a nepřepíše úpravy v GUI', async () => {
    const s = await setup();
    await s.db.update(schema.roles).set({ name: 'Můj název' }).where(eq(schema.roles.key, 'hrac'));
    await seedRoles(s.db, s.perms);
    expect(s.perms.roleByKey('hrac')!.name).toBe('Můj název');
    expect(s.perms.listRoles()).toHaveLength(PRESET_ROLES.length);
  });

  it('hráč smí hrát a psát, ale ne spravovat; host jen sleduje; zablokovaný nic', async () => {
    const s = await setup();
    const hrac = await s.user('Hrac', 'hrac');
    const host = await s.user('Host', 'host');
    const zablok = await s.user('Zablok', 'zablokovany');
    expect(s.perms.can(hrac, 'stul.hrat').allowed).toBe(true);
    expect(s.perms.can(hrac, 'uzivatel.pozvat').allowed).toBe(false);
    expect(s.perms.can(host, 'stul.hrat').allowed).toBe(false);
    expect(s.perms.can(host, 'stul.zobrazit').allowed).toBe(true);
    expect(s.perms.can(zablok, 'stul.zobrazit').allowed).toBe(false);
    expect(s.perms.can(null, 'stul.zobrazit').reasonKey).toBe('permission.notLoggedIn');
    expect(s.perms.can(hrac, 'neexistuje').reasonKey).toBe('permission.unknown');
  });
});

describe('vyhodnocení oprávnění', () => {
  it('více rolí = sjednocení, výslovný zákaz má přednost', async () => {
    const s = await setup();
    const u = await s.user('U', 'host');
    await s.perms.grantUnchecked(u, s.role('moderator').id);
    expect(s.perms.can(u, 'chat.mazat_zpravy').allowed).toBe(true);
    expect(s.perms.can(u, 'stul.hrat').allowed).toBe(true);
    const main = await s.user('Main', 'main_admin');
    const denyId = await s.perms.createRole(main, { key: 'bez_chatu', name: 'Bez chatu', power: 3, permissions: [{ key: 'chat.psat', effect: 'deny' }] });
    await s.perms.assignRole(main, u, denyId);
    expect(s.perms.can(u, 'chat.psat').allowed).toBe(false);
    expect(s.perms.can(u, 'chat.mazat_zpravy').allowed).toBe(true);
  });

  it('rozsah: role pro konkrétní kanál platí jen tam', async () => {
    const s = await setup();
    const main = await s.user('Main', 'main_admin');
    const u = await s.user('U', 'hrac');
    await s.perms.assignRole(main, u, s.role('moderator').id, { scopeType: 'channel', scopeId: 'hospoda' });
    expect(s.perms.can(u, 'chat.mazat_zpravy', { scopeType: 'channel', scopeId: 'hospoda' }).allowed).toBe(true);
    expect(s.perms.can(u, 'chat.mazat_zpravy', { scopeType: 'channel', scopeId: 'jine' }).allowed).toBe(false);
    expect(s.perms.can(u, 'chat.mazat_zpravy').allowed).toBe(false);
    await expect(s.perms.assignRole(main, u, s.role('moderator').id, { scopeType: 'channel' })).rejects.toThrow();
  });

  it('časově omezená role platí jen v daném období', async () => {
    let t = new Date('2026-01-10T12:00:00Z');
    const s = await setup(() => t);
    const main = await s.user('Main', 'main_admin');
    const u = await s.user('U', 'hrac');
    await s.perms.assignRole(main, u, s.role('pokladnik').id, { validFrom: new Date('2026-01-11T00:00:00Z'), validTo: new Date('2026-01-12T00:00:00Z') });
    expect(s.perms.can(u, 'mena.dobit').allowed).toBe(false);
    t = new Date('2026-01-11T12:00:00Z');
    expect(s.perms.can(u, 'mena.dobit').allowed).toBe(true);
    t = new Date('2026-01-12T00:00:01Z');
    expect(s.perms.can(u, 'mena.dobit').allowed).toBe(false);
    await expect(s.perms.assignRole(main, u, s.role('pokladnik').id, { validFrom: new Date('2026-02-02'), validTo: new Date('2026-02-01') })).rejects.toThrow();
  });

  it('limity: za operaci, nejvolnější z rolí, neomezené když jedna role limit nemá', async () => {
    const s = await setup();
    const main = await s.user('Main', 'main_admin');
    const pok = await s.user('Pok', 'pokladnik');
    expect(s.perms.can(pok, 'mena.dobit', { amount: 10000 }).allowed).toBe(true);
    const over = s.perms.can(pok, 'mena.dobit', { amount: 10001 });
    expect(over.allowed).toBe(false);
    expect(over.reasonKey).toBe('permission.limitExceeded');
    const bohaty = await s.perms.createRole(main, { key: 'bohaty', name: 'Bohatý', power: 20, permissions: [{ key: 'mena.dobit', limits: { maxPerOperation: 50000 } }] });
    await s.perms.assignRole(main, pok, bohaty);
    expect(s.perms.can(pok, 'mena.dobit', { amount: 50000 }).allowed).toBe(true);
    const neomezeny = await s.perms.createRole(main, { key: 'neomezeny', name: 'Neomezený', power: 21, permissions: [{ key: 'mena.dobit' }] });
    await s.perms.assignRole(main, pok, neomezeny);
    expect(s.perms.can(pok, 'mena.dobit', { amount: 10_000_000 }).allowed).toBe(true);
    expect(s.perms.can(pok, 'mena.dobit').limits).toBeUndefined();
  });

  it('denní limit se počítá za posledních 24 hodin', async () => {
    let t = new Date('2026-03-01T10:00:00Z');
    const s = await setup(() => t);
    const pok = await s.user('Pok', 'pokladnik');
    await s.perms.consumeDaily(pok, 'mena.dobit', 10000);
    await s.perms.consumeDaily(pok, 'mena.dobit', 10000);
    // záznamy mají čas z databáze (skutečný), proto posuneme „teď“ jen v rámci dne
    await s.perms.consumeDaily(pok, 'mena.dobit', 10000);
    await s.perms.consumeDaily(pok, 'mena.dobit', 10000);
    await s.perms.consumeDaily(pok, 'mena.dobit', 10000);
    expect(await code(s.perms.consumeDaily(pok, 'mena.dobit', 1))).toBe('LIMIT_EXCEEDED');
    expect(await code(s.perms.consumeDaily(pok, 'mena.dobit', 20000))).toBe('LIMIT_EXCEEDED');
    t = new Date(t.getTime() + 48 * 3600 * 1000);
    await s.perms.consumeDaily(pok, 'mena.dobit', 10000);
  });

  it('vyžadování schválení platí jen když ho vyžadují všechny role, které oprávnění dávají', async () => {
    const s = await setup();
    const main = await s.user('Main', 'main_admin');
    const pok = await s.user('Pok', 'pokladnik');
    expect(s.perms.can(pok, 'mena.upravit_knihu').needsApproval).toBe(true);
    const bez = await s.perms.createRole(main, { key: 'bez_schvaleni', name: 'Bez schválení', power: 20, permissions: [{ key: 'mena.upravit_knihu' }] });
    await s.perms.assignRole(main, pok, bez);
    expect(s.perms.can(pok, 'mena.upravit_knihu').needsApproval).toBeUndefined();
    expect(s.perms.can(main, 'mena.upravit_knihu').needsApproval).toBeUndefined();
  });

  it('zablokovaný uživatel nemá žádná oprávnění, dočasná blokace vyprší', async () => {
    let t = new Date('2026-05-01T10:00:00Z');
    const s = await setup(() => t);
    const u = await s.user('U', 'hrac');
    expect(s.perms.can(u, 'stul.hrat').allowed).toBe(true);
    await s.db.update(schema.users).set({ status: 'blocked', blockedUntil: new Date('2026-05-02T10:00:00Z') }).where(eq(schema.users.id, u));
    await s.perms.reload();
    expect(s.perms.can(u, 'stul.hrat')).toMatchObject({ allowed: false, reasonKey: 'permission.blocked' });
    t = new Date('2026-05-02T10:00:01Z');
    expect(s.perms.can(u, 'stul.hrat').allowed).toBe(true);
  });
});

describe('hierarchie síly', () => {
  it('administrátor přidělí hráči roli s nižší silou, ne stejnou ani vyšší', async () => {
    const s = await setup();
    const admin = await s.user('Admin', 'admin');
    const novy = await s.user('Novy', 'novacek');
    expect(await code(s.perms.assignRole(admin, novy, s.role('hrac').id))).toBe('OK');
    expect(await code(s.perms.assignRole(admin, novy, s.role('moderator').id))).toBe('OK');
    expect(await code(s.perms.assignRole(admin, novy, s.role('admin').id))).toBe('HIERARCHY');
    expect(await code(s.perms.assignRole(admin, novy, s.role('main_admin').id))).toBe('LOCKED_ROLE');
    expect(await code(s.perms.assignRole(admin, novy, s.role('pokladnik').id))).toBe('EXCEEDS_OWN_PERMISSIONS');
  });

  it('nelze spravovat uživatele se stejnou nebo vyšší silou ani sebe', async () => {
    const s = await setup();
    const admin = await s.user('Admin', 'admin');
    const admin2 = await s.user('Admin2', 'admin');
    const main = await s.user('Main', 'main_admin');
    const hrac = await s.user('Hrac', 'hrac');
    expect(await code(s.perms.assignRole(admin, admin2, s.role('hrac').id))).toBe('HIERARCHY');
    expect(await code(s.perms.assignRole(admin, main, s.role('hrac').id))).toBe('HIERARCHY');
    expect(await code(s.perms.assignRole(admin, admin, s.role('hrac').id))).toBe('HIERARCHY');
    expect(await code(s.perms.assignRole(admin, hrac, s.role('statistik').id))).toBe('OK');
    expect(() => s.perms.assertCanManageUser(admin, admin2)).toThrow(PermissionError);
    expect(() => s.perms.assertCanManageUser(admin, hrac)).not.toThrow();
    expect(() => s.perms.assertCanManageUser(main, admin)).not.toThrow();
  });

  it('bez oprávnění role.prirazovat nelze nic přidělit', async () => {
    const s = await setup();
    const hrac = await s.user('Hrac', 'hrac');
    const nov = await s.user('Nov', 'novacek');
    expect(await code(s.perms.assignRole(hrac, nov, s.role('host').id))).toBe('FORBIDDEN');
  });

  it('nikdo nezvýší sílu vlastní role: roli s vlastní nebo vyšší silou nelze upravit', async () => {
    const s = await setup();
    const admin = await s.user('Admin', 'admin');
    expect(await code(s.perms.updateRole(admin, s.role('admin').id, { power: 99 }))).toBe('HIERARCHY');
    expect(await code(s.perms.updateRole(admin, s.role('main_admin').id, { name: 'x' }))).toBe('LOCKED_ROLE');
    expect(await code(s.perms.updateRole(admin, s.role('hrac').id, { power: 80 }))).toBe('HIERARCHY');
    expect(await code(s.perms.updateRole(admin, s.role('hrac').id, { power: 12 }))).toBe('OK');
    expect(s.perms.roleByKey('hrac')!.power).toBe(12);
  });

  it('nelze vytvořit roli silnější než já ani s oprávněním, které nemám', async () => {
    const s = await setup();
    const admin = await s.user('Admin', 'admin');
    const ok = { key: 'nova', name: 'Nová', power: 30, permissions: [{ key: 'stul.hrat' }] };
    expect(await code(s.perms.createRole(admin, { ...ok, power: 80 }))).toBe('HIERARCHY');
    expect(await code(s.perms.createRole(admin, { ...ok, key: 'n2', permissions: [{ key: 'system.zalohy' }] }))).toBe('EXCEEDS_OWN_PERMISSIONS');
    expect(await code(s.perms.createRole(admin, ok))).toBe('OK');
    expect(await code(s.perms.createRole(admin, ok))).toBe('DUPLICATE_KEY');
    expect(await code(s.perms.createRole(admin, { ...ok, key: 'Spatny Klic' }))).toBe('INVALID');
    expect(await code(s.perms.createRole(admin, { ...ok, key: 'n3', permissions: [{ key: 'neexistuje' }] }))).toBe('INVALID');
  });

  it('limit nové role nesmí být volnější než můj, a neomezený nelze předat', async () => {
    const s = await setup();
    const main = await s.user('Main', 'main_admin');
    const pok = await s.user('Pok', 'pokladnik');
    await s.perms.assignRole(main, pok, await s.perms.createRole(main, { key: 'tvurce_roli', name: 'Tvůrce rolí', power: 58, permissions: [{ key: 'role.vytvorit' }] }));
    const mk = (limits?: Record<string, number>) => ({ key: `r${Math.random().toString(36).slice(2, 8)}`, name: 'R', power: 20, permissions: [{ key: 'mena.dobit', limits }] });
    expect(await code(s.perms.createRole(pok, mk({ maxPerOperation: 99999, maxPerDay: 1 })))).toBe('EXCEEDS_OWN_PERMISSIONS');
    expect(await code(s.perms.createRole(pok, mk()))).toBe('EXCEEDS_OWN_PERMISSIONS');
    expect(await code(s.perms.createRole(pok, mk({ maxPerOperation: 100, maxPerDay: 1000 })))).toBe('OK');
  });

  it('roli, kterou někdo používá, nelze smazat; smazat lze nepoužitou', async () => {
    const s = await setup();
    const main = await s.user('Main', 'main_admin');
    const u = await s.user('U', 'hrac');
    const id = await s.perms.createRole(main, { key: 'tmp', name: 'Tmp', power: 4, permissions: [] });
    await s.perms.assignRole(main, u, id);
    expect(await code(s.perms.deleteRole(main, id))).toBe('ROLE_IN_USE');
    const a = s.perms.assignmentsOf(u).find((x) => x.roleId === id)!;
    await s.perms.revokeAssignment(main, a.id);
    expect(await code(s.perms.deleteRole(main, id))).toBe('OK');
    expect(await code(s.perms.deleteRole(main, s.role('main_admin').id))).toBe('LOCKED_ROLE');
  });
});

describe('hlavní administrátor', () => {
  it('poslední hlavní administrátor nejde odebrat ani zablokovat, další ano', async () => {
    const s = await setup();
    const main1 = await s.user('Main1', 'main_admin');
    const a1 = s.perms.assignmentsOf(main1).find((a) => a.role?.isLocked)!;
    expect(await code(s.perms.revokeAssignment(main1, a1.id))).toBe('LAST_MAIN_ADMIN');
    expect(() => s.perms.assertNotLastMainAdmin(main1)).toThrow(PermissionError);
    const main2 = await s.user('Main2');
    expect(await code(s.perms.assignRole(main1, main2, s.role('main_admin').id))).toBe('OK');
    expect(s.perms.mainAdminIds().sort()).toEqual([main1, main2].sort());
    expect(await code(s.perms.revokeAssignment(main2, a1.id))).toBe('OK');
    expect(() => s.perms.assertNotLastMainAdmin(main2)).toThrow(PermissionError);
  });

  it('jen hlavní administrátor smí odebrat nebo přidělit zamčenou roli', async () => {
    const s = await setup();
    const main = await s.user('Main', 'main_admin');
    const admin = await s.user('Admin', 'admin');
    const a = s.perms.assignmentsOf(main).find((x) => x.role?.isLocked)!;
    expect(await code(s.perms.revokeAssignment(admin, a.id))).toBe('LOCKED_ROLE');
  });
});

describe('audit', () => {
  it('změny rolí a přidělení se zapisují s aktérem, cílem a hodnotami před/po', async () => {
    const s = await setup();
    const main = await s.user('Main', 'main_admin');
    const u = await s.user('U', 'host');
    await s.perms.assignRole(main, u, s.role('hrac').id, {}, { ip: '10.0.0.5', reason: 'povýšení', source: 'ui' });
    const id = await s.perms.createRole(main, { key: 'rr', name: 'RR', power: 5, permissions: [] });
    await s.perms.updateRole(main, id, { name: 'RR2' });
    const log = await s.audit.list({ actorId: main });
    const actions = log.map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['role.prirazeni', 'role.vytvorit', 'role.upravit']));
    const assign = log.find((l) => l.action === 'role.prirazeni')!;
    expect(assign.targetId).toBe(u);
    expect(assign.ip).toBe('10.0.0.5');
    expect(assign.reason).toBe('povýšení');
    const upd = log.find((l) => l.action === 'role.upravit')!;
    expect((upd.before as { name: string }).name).toBe('RR');
    expect((upd.after as { name: string }).name).toBe('RR2');
  });

  it('tajné hodnoty se do audit logu nezapisují', async () => {
    const s = await setup();
    await s.audit.log({ action: 'x', after: { password: 'tajne', nested: { apiKey: 'abc', ok: 1 }, list: [{ token: 't' }] } });
    const [row] = await s.audit.list({ action: 'x' });
    const json = JSON.stringify(row!.after);
    expect(json).not.toContain('tajne');
    expect(json).not.toContain('abc');
    expect(json).toContain('"ok":1');
  });
});
