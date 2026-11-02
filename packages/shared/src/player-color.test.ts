import { describe, expect, it } from 'vitest';
import { PLAYER_COLOR_COUNT, assignPlayerColors, playerColorVar } from './player-color.js';

describe('barvy hráčů', () => {
  it('ručně přidělená barva platí a ostatním se dají volné barvy podle pořadí registrace', () => {
    const m = assignPlayerColors([
      { id: 'a', chartColor: null, order: 1 },
      { id: 'b', chartColor: 1, order: 2 },
      { id: 'c', chartColor: null, order: 3 },
    ]);
    expect(m.get('b')).toBe(1);
    expect(m.get('a')).toBe(2);
    expect(m.get('c')).toBe(3);
  });
  it('barvy se neopakují, dokud je hráčů nejvýš tolik jako barev; neplatná hodnota se bere jako automatická', () => {
    const users = Array.from({ length: PLAYER_COLOR_COUNT }, (_, i) => ({ id: `u${i}`, chartColor: i === 3 ? 99 : null, order: i }));
    expect(new Set(assignPlayerColors(users).values()).size).toBe(PLAYER_COLOR_COUNT);
  });
  it('hodnota odkazuje na design token', () => {
    expect(playerColorVar(3)).toBe('var(--tk-color-series3)');
    expect(playerColorVar(PLAYER_COLOR_COUNT + 1)).toBe('var(--tk-color-series1)');
  });
});
