import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openPglite, schema, type Database } from './db/index.js';
import { AccountService } from './auth/accounts.js';
import { AuditService } from './auth/audit.js';
import { PermissionService } from './auth/permissions.js';
import { seedRoles } from './auth/seed.js';
import { SecretStore } from './secrets/store.js';
import { runCli } from './cli.js';
import { createDefaultRegistry, resolveSettings } from '@kb/shared';

let database: Database | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});

describe('CLI: nouzová obnova přístupu', () => {
  it('recover-admin nastaví heslo a přidělí hlavního administrátora, list-admins ho vypíše', async () => {
    database = await openPglite();
    const { db } = database;
    const audit = new AuditService(db);
    const perms = new PermissionService(db, audit);
    await seedRoles(db, perms);
    const settings = () => resolveSettings(createDefaultRegistry(), []).values;
    const accounts = new AccountService({ db, audit, perms, settings });
    await accounts.ensureMainAdmin('Majitel', 'puvodni-heslo-1');
    const [u] = await db.select().from(schema.users).where(eq(schema.users.nicknameLower, 'majitel'));
    // administrátor se zamkne: heslo zapomenuto, role odebrána
    await db.delete(schema.roleAssignments).where(eq(schema.roleAssignments.userId, u!.id));
    const out: string[] = [];
    expect(await runCli(['list-admins'], {}, (s) => out.push(s), database)).toBe(0);
    expect(out).toEqual([]);
    expect(await runCli(['recover-admin', 'Majitel', 'nove-heslo-123'], {}, (s) => out.push(s), database)).toBe(0);
    expect(out.join(' ')).toMatch(/hlavního administrátora/);
    out.length = 0;
    await runCli(['list-admins'], {}, (s) => out.push(s), database);
    expect(out).toEqual([u!.id]);
    const accounts2 = new AccountService({ db, audit, perms, settings });
    await perms.reload();
    expect((await accounts2.login('Majitel', 'nove-heslo-123')).user.nickname).toBe('Majitel');
    expect((await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'system.obnova_admina'))).length).toBe(1);
  });

  it('chybné použití, slabé heslo a neznámý uživatel', async () => {
    database = await openPglite();
    const out: string[] = [];
    expect(await runCli([], {}, (s) => out.push(s), database)).toBe(2);
    expect(await runCli(['recover-admin', 'jen-jmeno'], {}, (s) => out.push(s), database)).toBe(2);
    await expect(runCli(['recover-admin', 'nikdo', 'dlouhe-heslo-123'], {}, () => undefined, database)).rejects.toThrow();
    await expect(runCli(['recover-admin', 'nikdo', 'kratke'], {}, () => undefined, database)).rejects.toThrow();
  });

  it('rotate-key přešifruje tajné údaje a vypíše návod', async () => {
    database = await openPglite();
    const { db } = database;
    const audit = new AuditService(db);
    const perms = new PermissionService(db, audit);
    await seedRoles(db, perms);
    const accounts = new AccountService({ db, audit, perms, settings: () => resolveSettings(createDefaultRegistry(), []).values });
    await accounts.ensureMainAdmin('Majitel', 'puvodni-heslo-1');
    const key = '11'.repeat(32);
    const store = new SecretStore(db, audit, perms, { key: Buffer.from(key, 'hex'), version: 1 });
    const [admin] = perms.mainAdminIds();
    await store.set(admin!, 'smtp.password', 'heslo-aplikace');
    const out: string[] = [];
    expect(await runCli(['rotate-key'], { MASTER_KEY: key }, (s) => out.push(s), database)).toBe(0);
    expect(out.join('\n')).toMatch(/verzi 2/);
    const newKey = out.join('\n').match(/MASTER_KEY=([0-9a-f]{64})/)![1]!;
    const reopened = new SecretStore(db, audit, perms, { key: Buffer.from(newKey, 'hex'), version: 2 });
    expect(await reopened.reveal('smtp.password')).toBe('heslo-aplikace');
  });
});
