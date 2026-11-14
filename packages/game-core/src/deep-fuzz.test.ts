// Deep fuzz: random combinations of special features with rules beyond "chips are neither created nor lost"
// (nobody sees cards they must not see, the table never gets stuck, offered actions and hand records make sense).
// DEEP_N and DEEP_FROM widen the hunt: DEEP_N=500 DEEP_FROM=1000 npx vitest run packages/game-core/src/deep-fuzz.test.ts
import { describe, expect, it } from 'vitest';
import { deepCombo, deepRun, type Finding } from './deep-fuzz-harness.js';

// The regular run is small on purpose (it is part of every test run); the hunt for new bugs uses the variables above.
const N = Number(process.env.DEEP_N ?? 6);
const FROM = Number(process.env.DEEP_FROM ?? 1);
const STEPS = Number(process.env.DEEP_STEPS ?? 700);

describe('deep fuzz of a cash table', { timeout: 3_600_000 }, () => {
  it(`${N} random combinations of settings from seed ${FROM}: every rule holds`, () => {
    const all: Finding[] = [];
    for (let seed = FROM; seed < FROM + N; seed++) all.push(...deepRun(seed, deepCombo(seed), STEPS));
    const byRule = new Map<string, Finding[]>();
    for (const f of all) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
    const summary = [...byRule].map(([rule, list]) => `${rule} ×${list.length} (seeds ${list.slice(0, 8).map((f) => f.seed).join(', ')}): ${list[0]!.detail}`);
    if (summary.length) console.log('DEEP FINDINGS\n' + summary.join('\n'));
    expect(summary).toEqual([]);
  });
});
