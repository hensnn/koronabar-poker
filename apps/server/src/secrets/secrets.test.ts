import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openPglite, schema, type Database } from '../db/index.js';
import { AuditService } from '../auth/audit.js';
import { PermissionService } from '../auth/permissions.js';
import { seedRoles } from '../auth/seed.js';
import { decryptSecret, encryptSecret, loadMasterKey, SecretError, SecretStore } from './store.js';

let database: Database | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await database?.close();
  database = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(keyFile?: string) {
  database = await openPglite();
  const { db } = database;
  const audit = new AuditService(db);
  const perms = new PermissionService(db, audit);
  await seedRoles(db, perms);
  const mk = async (nick: string, role: string) => {
    const [u] = await db.insert(schema.users).values({ nickname: nick, nicknameLower: nick.toLowerCase(), passwordHash: 'x' }).returning({ id: schema.users.id });
    await perms.grantUnchecked(u!.id, perms.roleByKey(role)!.id);
    return u!.id;
  };
  const main = await mk('Main', 'main_admin');
  const hrac = await mk('Hrac', 'hrac');
  const admin = await mk('Admin', 'admin');
  const master = { key: randomBytes(32), version: 1 };
  const store = new SecretStore(db, audit, perms, master, keyFile);
  return { db, audit, perms, store, main, hrac, admin, master };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof SecretError ? e.code : String(e);
  }
};

describe('šifrování tajných údajů', () => {
  it('AES-256-GCM: šifrovaná hodnota neobsahuje otevřený text, každé šifrování má jiný nonce', () => {
    const key = randomBytes(32);
    const a = encryptSecret(key, 'smtp.password', 'super-tajne-heslo');
    const b = encryptSecret(key, 'smtp.password', 'super-tajne-heslo');
    expect(a.ciphertext).not.toContain('super');
    expect(Buffer.from(a.ciphertext, 'base64').toString('utf8')).not.toContain('tajne');
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptSecret(key, 'smtp.password', a)).toBe('super-tajne-heslo');
  });

  it('špatný klíč, podstrčení pod jiný název nebo změněná data dešifrování odmítnou', () => {
    const key = randomBytes(32);
    const enc = encryptSecret(key, 'smtp.password', 'hodnota');
    expect(() => decryptSecret(randomBytes(32), 'smtp.password', enc)).toThrow();
    expect(() => decryptSecret(key, 'ai.gemini.apiKey', enc)).toThrow();
    const tampered = { ...enc, ciphertext: Buffer.from(Buffer.from(enc.ciphertext, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64') };
    expect(() => decryptSecret(key, 'smtp.password', tampered)).toThrow();
  });
});

describe('hlavní klíč', () => {
  it('z proměnné prostředí, jinak ze souboru; chybí-li, vygeneruje se a uloží do souboru s návodem', () => {
    const hex = randomBytes(32).toString('hex');
    expect(loadMasterKey({ envKey: hex, envVersion: 3 })).toMatchObject({ version: 3 });
    expect(() => loadMasterKey({ envKey: 'kratky' })).toThrow(/64/);
    const dir = mkdtempSync(join(tmpdir(), 'kb-key-'));
    dirs.push(dir);
    const file = join(dir, 'sub', 'master.key');
    const logs: string[] = [];
    const a = loadMasterKey({ keyFile: file, log: (m) => logs.push(m) });
    expect(existsSync(file)).toBe(true);
    expect(logs.join(' ')).toMatch(/zálohuj ZVLÁŠŤ/);
    const b = loadMasterKey({ keyFile: file });
    expect(b.key.equals(a.key)).toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(/^1:[0-9a-f]{64}\s*$/);
  });
});

describe('úložiště tajných údajů', () => {
  it('v DB je jen šifrovaná hodnota a poslední 4 znaky; stav nikdy neprozradí celou hodnotu', async () => {
    const s = await setup();
    await s.store.set(s.main, 'ai.gemini.apiKey', 'AIzaSyD-tajny-klic-abcd');
    const [row] = await s.db.select().from(schema.secrets);
    expect(JSON.stringify(row)).not.toContain('AIzaSy');
    expect(row!.last4).toBe('abcd');
    expect(row!.keyVersion).toBe(1);
    const status = await s.store.status();
    const gem = status.find((x) => x.key === 'ai.gemini.apiKey')!;
    expect(gem).toMatchObject({ set: true, last4: 'abcd' });
    expect(JSON.stringify(status)).not.toContain('AIzaSy');
    expect(status.find((x) => x.key === 'smtp.password')!.set).toBe(false);
    expect(await s.store.reveal('ai.gemini.apiKey')).toBe('AIzaSyD-tajny-klic-abcd');
    expect(await s.store.reveal('smtp.password')).toBeUndefined();
  });

  it('změna a smazání vyžadují oprávnění, neznámý klíč a prázdná hodnota se odmítnou', async () => {
    const s = await setup();
    expect(await code(s.store.set(s.hrac, 'smtp.password', 'x'))).toBe('FORBIDDEN');
    // Administrátor má SMTP až na úrovni hlavního admina; systémové tajné údaje nemá
    expect(await code(s.store.set(s.admin, 'ai.gemini.apiKey', 'klic1234'))).toBe('FORBIDDEN');
    expect(await code(s.store.set(s.main, 'neznamy.klic', 'x'))).toBe('UNKNOWN_SECRET');
    expect(await code(s.store.set(s.main, 'smtp.password', '   '))).toBe('EMPTY');
    expect(await code(s.store.set(s.main, 'smtp.password', 'heslo-aplikace'))).toBe('OK');
    expect(await code(s.store.delete(s.hrac, 'smtp.password'))).toBe('FORBIDDEN');
    expect(await code(s.store.delete(s.main, 'smtp.password'))).toBe('OK');
    expect(await s.store.reveal('smtp.password')).toBeUndefined();
  });

  it('audit eviduje změnu, ale nikdy hodnotu', async () => {
    const s = await setup();
    await s.store.set(s.main, 'smtp.password', 'uplne-tajne-heslo');
    await s.store.delete(s.main, 'smtp.password');
    const log = await s.audit.list({});
    const actions = log.map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['tajny_udaj.zmenen', 'tajny_udaj.smazan']));
    expect(JSON.stringify(log)).not.toContain('uplne-tajne');
    expect(log.find((l) => l.action === 'tajny_udaj.zmenen')!.targetId).toBe('smtp.password');
  });

  it('rotace klíče přešifruje všechny údaje; starý klíč pak nic nedešifruje', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-key-'));
    dirs.push(dir);
    const file = join(dir, 'master.key');
    const s = await setup(file);
    await s.store.set(s.main, 'smtp.password', 'heslo-1111');
    await s.store.set(s.main, 'ai.gemini.apiKey', 'klic-2222');
    const oldKey = s.master.key;
    expect(await code(s.store.rotate(s.hrac))).toBe('FORBIDDEN');
    const r = await s.store.rotate(s.main);
    expect(r.version).toBe(2);
    expect(r.savedToFile).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(`2:${r.newKeyHex}\n`);
    expect(await s.store.reveal('smtp.password')).toBe('heslo-1111');
    expect(await s.store.reveal('ai.gemini.apiKey')).toBe('klic-2222');
    const rows = await s.db.select().from(schema.secrets);
    expect(rows.every((x) => x.keyVersion === 2)).toBe(true);
    expect(() => decryptSecret(oldKey, 'smtp.password', rows.find((x) => x.key === 'smtp.password')!)).toThrow();
    const reopened = new SecretStore(s.db, s.audit, s.perms, loadMasterKey({ keyFile: file }));
    expect(await reopened.reveal('smtp.password')).toBe('heslo-1111');
  });

  it('s nesprávným hlavním klíčem (po ztrátě) se údaje nepodaří přečíst, ostatní data zůstanou', async () => {
    const s = await setup();
    await s.store.set(s.main, 'smtp.password', 'heslo-1111');
    const other = new SecretStore(s.db, s.audit, s.perms, { key: randomBytes(32), version: 1 });
    expect(await code(other.reveal('smtp.password'))).toBe('DECRYPT_FAILED');
    // znovu zadat jde
    await other.set(s.main, 'smtp.password', 'nove-heslo-3333');
    expect(await other.reveal('smtp.password')).toBe('nove-heslo-3333');
  });
});
