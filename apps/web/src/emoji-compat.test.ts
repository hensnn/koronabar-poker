import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules' || n === 'dist') return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/**
 * Novější emoji (Unicode 12 a výš, např. 🪖 🪑 🪙 🩺 🫧) se na starších systémech (starší Windows 10) vykreslí jako prázdný čtvereček.
 * Do kódu a textů proto patří jen emoji, která mají i starší systémy.
 */
const NEWER_EMOJI = /[\u{1FA70}-\u{1FAFF}\u{1F7E0}-\u{1F7EB}\u{1F6D5}-\u{1F6D7}\u{1F6DD}-\u{1F6DF}\u{1F6FA}-\u{1F6FC}\u{1F90C}\u{1F93F}\u{1F972}\u{1F977}\u{1F978}\u{1F9A5}-\u{1F9AA}\u{1F9AE}\u{1F9AF}\u{1F9BA}-\u{1F9BF}\u{1F9C3}-\u{1F9CF}]/u;

describe('emoji: jen ta, která zobrazí i starší systémy', () => {
  it('ve zdrojích není emoji novější než Unicode 11', () => {
    const roots = ['../../server/src', '../../../packages/shared/src', '.'].map((r) => join(__dirname, r));
    const bad: string[] = [];
    for (const root of roots) {
      for (const f of files(root)) {
        if (!/\.(ts|tsx|css)$/.test(f) || f.endsWith('emoji-compat.test.ts')) continue;
        const lines = readFileSync(f, 'utf8').split('\n');
        lines.forEach((l, i) => {
          const m = NEWER_EMOJI.exec(l);
          if (m) bad.push(`${f}:${i + 1} ${m[0]}`);
        });
      }
    }
    expect(bad).toEqual([]);
  });
});
