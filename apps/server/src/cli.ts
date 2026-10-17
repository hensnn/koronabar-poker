/**
 * Příkazy pro správce, které se spouští v kontejneru (nouzová obnova přístupu a údržba).
 *
 *   node dist/cli.js recover-admin <přezdívka> <nové-heslo>   nastaví heslo a přidělí roli hlavního administrátora
 *   node dist/cli.js list-admins                               vypíše hlavní administrátory
 *   node dist/cli.js rotate-key                                přešifruje tajné údaje novým hlavním klíčem
 */
import { join } from 'node:path';
import { createDefaultRegistry, resolveSettings } from '@kb/shared';
import { AccountService } from './auth/accounts.js';
import { AuditService } from './auth/audit.js';
import { PermissionService } from './auth/permissions.js';
import { seedRoles } from './auth/seed.js';
import { openPglite, openPostgres, type Database } from './db/index.js';
import { loadMasterKey, SecretStore } from './secrets/store.js';
import { SettingsStore } from './settings-store.js';

export interface CliEnv {
  DATABASE_URL?: string;
  PGLITE_DIR?: string;
  MASTER_KEY?: string;
  MASTER_KEY_VERSION?: string;
  MASTER_KEY_FILE?: string;
}

export async function runCli(argv: string[], env: CliEnv, out: (s: string) => void, database?: Database): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || !['recover-admin', 'list-admins', 'rotate-key'].includes(cmd)) {
    out('Použití: recover-admin <přezdívka> <nové-heslo> | list-admins | rotate-key');
    return 2;
  }
  const db = database ?? (env.DATABASE_URL ? await openPostgres(env.DATABASE_URL) : await openPglite(env.PGLITE_DIR ?? '.data/pglite'));
  try {
    const registry = createDefaultRegistry();
    const audit = new AuditService(db.db);
    const perms = new PermissionService(db.db, audit);
    await seedRoles(db.db, perms);
    const settings = new SettingsStore(db.db, registry, audit, perms);
    await settings.load();
    if (cmd === 'list-admins') {
      for (const id of perms.mainAdminIds()) out(id);
      return 0;
    }
    if (cmd === 'recover-admin') {
      const [nick, password] = args;
      if (!nick || !password) {
        out('Chybí přezdívka nebo heslo.');
        return 2;
      }
      const accounts = new AccountService({ db: db.db, audit, perms, settings: () => resolveSettings(registry, [{ scope: 'global', values: settings.layer('global') }]).values });
      await accounts.recoverAdmin(nick, password);
      out(`Hotovo: uživatel ${nick} má nové heslo a roli hlavního administrátora.`);
      return 0;
    }
    // rotate-key
    const keyFile = env.MASTER_KEY_FILE ?? (env.PGLITE_DIR ? join(env.PGLITE_DIR, '..', 'master.key') : undefined);
    const master = loadMasterKey({ envKey: env.MASTER_KEY, envVersion: env.MASTER_KEY_VERSION ? Number(env.MASTER_KEY_VERSION) : undefined, keyFile, log: out });
    const store = new SecretStore(db.db, audit, perms, master, keyFile);
    const [admin] = perms.mainAdminIds();
    if (!admin) {
      out('Neexistuje žádný hlavní administrátor.');
      return 1;
    }
    const r = await store.rotate(admin, { source: 'cli' });
    out(`Klíč byl otočen na verzi ${r.version}.`);
    out(r.savedToFile ? 'Nový klíč je uložen v souboru s klíčem.' : `Nový klíč ulož do .env jako MASTER_KEY=${r.newKeyHex} a MASTER_KEY_VERSION=${r.version}. Starý klíč pak můžeš zahodit.`);
    return 0;
  } finally {
    if (!database) await db.close();
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/cli.js')) {
  runCli(process.argv.slice(2), process.env as CliEnv, (s) => console.log(s)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
