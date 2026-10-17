// Sestavení serveru do jednoho souboru (dist/index.js a dist/cli.js). Interní balíčky @kb/* se zabalí,
// externí závislosti zůstanou v node_modules (nativní moduly a WASM nelze bezpečně zabalit).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys({ ...pkg.dependencies }).filter((d) => !d.startsWith('@kb/'));

rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });
mkdirSync(new URL('./dist', import.meta.url), { recursive: true });

await build({
  entryPoints: ['src/index.ts', 'src/cli.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external,
  // balíčky v ESM potřebují require pro některé závislosti
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

// SQL migrace jdou vedle sestaveného serveru.
cpSync(new URL('./drizzle', import.meta.url), new URL('./dist/drizzle', import.meta.url), { recursive: true });
