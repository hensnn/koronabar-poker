import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const serverDir = resolve(here, '..');
const migrationsDir = join(serverDir, 'drizzle');
const schemaPath = join(serverDir, 'src', 'db', 'schema.ts');

/** `drizzle-kit` je vývojová závislost serveru; bez ní se test přeskočí (např. produkční obraz). */
function drizzleKitBin(): string | null {
  try {
    return createRequire(join(serverDir, 'package.json')).resolve('drizzle-kit/bin.cjs');
  } catch {
    return null;
  }
}

/**
 * Snímky schématu (`drizzle/meta/*_snapshot.json`) musí odpovídat SQL migracím a `schema.ts`. Když někdo změní
 * schéma bez `drizzle-kit generate`, nebo přidá migraci bez snímku, další `generate` by vytvořil migraci
 * s duplicitními příkazy a server by při startu spadl. Test spustí `generate` do kopie složky a hlídá, že nevznikne nový SQL soubor.
 */
describe('migrace databáze', () => {
  it('drizzle-kit generate nad aktuálním schématem nevytvoří žádnou novou migraci (snímky odpovídají schema.ts)', () => {
    const bin = drizzleKitBin();
    if (!bin) {
      console.warn('drizzle-kit není nainstalovaný, test driftu migrací se přeskakuje');
      return;
    }
    const journal = join(migrationsDir, 'meta', '_journal.json');
    expect(existsSync(journal)).toBe(true);
    const sqlFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const snapshots = (dir: string) => readdirSync(join(dir, 'meta')).filter((f) => f.endsWith('_snapshot.json')).sort();
    // Každá migrace má svůj snímek (0000 … N) a naopak.
    const before = sqlFiles(migrationsDir);
    expect(snapshots(migrationsDir).map((f) => f.slice(0, 4))).toEqual(before.map((f) => f.slice(0, 4)));

    const tmp = mkdtempSync(join(tmpdir(), 'kb-drizzle-'));
    try {
      cpSync(migrationsDir, tmp, { recursive: true });
      const out = execFileSync(process.execPath, [bin, 'generate', '--dialect=postgresql', `--schema=${schemaPath}`, `--out=${tmp}`], { cwd: serverDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
      const after = sqlFiles(tmp);
      expect(after, `drizzle-kit vytvořil novou migraci:\n${out}`).toEqual(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
