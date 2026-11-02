import { describe, expect, it } from 'vitest';
import { PLAYER_COLOR_COUNT, PLAYER_HUES, assignPlayerColors, playerColorCode, playerColorParts, playerColorVar } from './player-color.js';

describe('barvy hráčů', () => {
  it('kód se skládá z odstínu a tónu a jde zpět rozložit', () => {
    expect(playerColorParts(playerColorCode(4, 2))).toEqual({ hue: 4, shade: 2 });
    expect(playerColorParts(PLAYER_COLOR_COUNT)).toEqual({ hue: PLAYER_HUES, shade: 5 });
  });
  it('ručně přidělená barva platí a ostatním se dají volné barvy podle pořadí registrace', () => {
    const first = playerColorCode(1, 3);
    const m = assignPlayerColors([
      { id: 'a', chartColor: null, order: 1 },
      { id: 'b', chartColor: first, order: 2 },
      { id: 'c', chartColor: null, order: 3 },
    ]);
    expect(m.get('b')).toBe(first);
    expect(m.get('a')).toBe(playerColorCode(2, 3));
    expect(m.get('c')).toBe(playerColorCode(3, 3));
  });
  it('barvy se neopakují, dokud je hráčů nejvýš tolik jako barev; neplatná hodnota se bere jako automatická', () => {
    const users = Array.from({ length: PLAYER_COLOR_COUNT }, (_, i) => ({ id: `u${i}`, chartColor: i === 3 ? 999 : null, order: i }));
    expect(new Set(assignPlayerColors(users).values()).size).toBe(PLAYER_COLOR_COUNT);
  });
  it('základní tón je přímo token, ostatní se z něj míchají', () => {
    expect(playerColorVar(playerColorCode(3, 3))).toBe('var(--tk-color-series3)');
    expect(playerColorVar(playerColorCode(3, 1))).toContain('white');
    expect(playerColorVar(playerColorCode(3, 5))).toContain('black');
  });
});
