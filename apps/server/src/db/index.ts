import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.js';

export { schema };
/** Společný typ pro oba ovladače (PostgreSQL ve výrobě, PGlite v testech a vývoji). */
export type Db = PgDatabase<any, typeof schema>;

export interface Database {
  db: Db;
  close(): Promise<void>;
}

/** Složka s SQL migracemi: ve zdrojích `apps/server/drizzle`, v sestaveném balíčku `dist/drizzle`. */
function findMigrationsFolder(): string {
  const toPath = (u: URL) => decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1');
  const candidates = [process.env.MIGRATIONS_DIR, toPath(new URL('./drizzle', import.meta.url)), toPath(new URL('../../drizzle', import.meta.url)), toPath(new URL('../drizzle', import.meta.url))].filter(
    (c): c is string => !!c,
  );
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`Nenalezena složka s migracemi (zkoušeno: ${candidates.join(', ')})`);
  return found;
}
const migrationsFolder = findMigrationsFolder();

/** PostgreSQL přes `pg` (výchozí způsob provozu, `DATABASE_URL`). */
export async function openPostgres(url: string): Promise<Database> {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzlePg(pool, { schema });
  await migratePg(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => pool.end() };
}

/** PGlite = skutečný PostgreSQL v procesu. Bez `dataDir` jen v paměti (testy). */
export async function openPglite(dataDir?: string): Promise<Database> {
  if (dataDir) mkdirSync(dirname(dataDir), { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}
