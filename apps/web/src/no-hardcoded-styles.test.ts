import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const SRC = join(__dirname);
const sources = files(SRC).filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith('.test.ts'));

describe('vzhled jen přes design tokeny', () => {
  it('žádná barva v hex/rgb/hsl zápisu v komponentách', () => {
    const bad: string[] = [];
    for (const f of sources) {
      const text = readFileSync(f, 'utf8');
      if (/#[0-9a-fA-F]{3,8}\b/.test(text.replace(/&#\d+;/g, '')) || /\b(rgb|hsl)a?\(/.test(text)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });

  it('žádné velikosti v px, inline style s pevnými hodnotami ani výchozí paleta Tailwindu', () => {
    const bad: string[] = [];
    const palette = /\b(?:bg|text|border|ring|fill|stroke)-(?:red|green|blue|gray|slate|zinc|yellow|white|black|amber|emerald)\b/;
    for (const f of sources) {
      const text = readFileSync(f, 'utf8');
      if (f.endsWith('.css')) continue;
      if (/\d\s*px\b/.test(text) || palette.test(text) || /style=\{\{[^}]*\d/.test(text)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});
