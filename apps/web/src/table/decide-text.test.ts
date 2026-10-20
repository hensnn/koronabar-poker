import { describe, expect, it } from 'vitest';
import { decideText, decideTitle } from './decide-text';

describe('text rozhodnutí po vypadnutí podle dostupných možností', () => {
  it('bez nového vstupu se nezmiňuje a naopak', () => {
    expect(decideText({ canRebuy: true, canReenter: false }, '30 s')).not.toMatch(/nový vstup/i);
    expect(decideText({ canRebuy: true, canReenter: false }, '30 s')).toMatch(/rebuy/);
    expect(decideText({ canRebuy: false, canReenter: true }, '30 s')).not.toMatch(/rebuy/i);
    expect(decideText({ canRebuy: false, canReenter: true }, '30 s')).toMatch(/nový vstup/);
    const both = decideText({ canRebuy: true, canReenter: true }, '30 s');
    expect(both).toMatch(/rebuy/);
    expect(both).toMatch(/nový vstup/);
    expect(decideText({}, '30 s')).not.toMatch(/rebuy|nový vstup/i);
  });
  it('nadpis okna odpovídá možnostem', () => {
    expect(decideTitle({ canRebuy: true, canReenter: false })).toBe('Rebuy');
    expect(decideTitle({ canRebuy: false, canReenter: true })).toBe('Vstoupit znovu');
    expect(decideTitle({ canRebuy: true, canReenter: true })).toBe('Rebuy nebo nový vstup');
  });
});
