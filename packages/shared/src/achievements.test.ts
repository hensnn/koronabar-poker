import { describe, expect, it } from 'vitest';
import { BUILTIN_ACHIEVEMENTS, handRankAtLeast, longestStreak, validateCondition } from './achievements.js';

describe('úspěchy', () => {
  it('vestavěný katalog má jedinečné klíče a platné podmínky', () => {
    const keys = BUILTIN_ACHIEVEMENTS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of BUILTIN_ACHIEVEMENTS) {
      expect(validateCondition(a.condition).ok, a.key).toBe(true);
      expect(a.xp).toBeGreaterThanOrEqual(0);
    }
  });

  it('podmínky od správce se kontrolují', () => {
    expect(validateCondition({ type: 'knockouts', value: 25 })).toEqual({ ok: true, condition: { type: 'knockouts', value: 25 } });
    expect(validateCondition({ type: 'nesmysl', value: 1 })).toEqual({ ok: false, field: 'type' });
    expect(validateCondition({ type: 'knockouts', value: 0 })).toEqual({ ok: false, field: 'value' });
    expect(validateCondition({ type: 'knockouts', value: 1.5 })).toEqual({ ok: false, field: 'value' });
    expect(validateCondition({ type: 'handRank', rank: 'nic' })).toEqual({ ok: false, field: 'rank' });
    expect(validateCondition({ type: 'handRank', rank: 'quads' })).toEqual({ ok: true, condition: { type: 'handRank', value: 1, rank: 'quads' } });
    expect(validateCondition(null)).toEqual({ ok: false, field: 'type' });
  });

  it('řada dní po sobě', () => {
    expect(longestStreak([])).toBe(0);
    expect(longestStreak(['2026-03-01'])).toBe(1);
    expect(longestStreak(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-03'])).toBe(3);
    expect(longestStreak(['2026-03-03', '2026-03-01', '2026-03-01'])).toBe(1);
  });

  it('kombinace aspoň zadané', () => {
    expect(handRankAtLeast('hand.royalFlush', 'quads')).toBe(true);
    expect(handRankAtLeast('hand.quads', 'quads')).toBe(true);
    expect(handRankAtLeast('hand.fullHouse', 'quads')).toBe(false);
    expect(handRankAtLeast('hand.pair', 'straight')).toBe(false);
    expect(handRankAtLeast(null, 'straight')).toBe(false);
  });
});
