import { describe, expect, it } from 'vitest';
import { monthIndex, parseYearFields, pickYearFields, serializeYearFields, yearBounds, YEAR_DEFAULTS, type YearStats } from './year-stats.js';

describe('roční statistika: pomocné funkce', () => {
  it('hranice roku v české zóně (zima +1 h) a měsíc okamžiku', () => {
    const b = yearBounds(2026, 'Europe/Prague');
    expect(b.from).toBe(Date.UTC(2025, 11, 31, 23));
    expect(b.to).toBe(Date.UTC(2026, 11, 31, 23));
    expect(monthIndex(Date.UTC(2026, 0, 31, 23, 30), 'Europe/Prague')).toBe(1); // už únor místního času
    expect(monthIndex(Date.UTC(2026, 5, 15), 'Europe/Prague')).toBe(5);
  });
  it('výběr údajů: pevné pořadí, neznámé se zahodí, prázdné nic, samé neznámé výchozí', () => {
    expect(parseYearFields('topUps, net ,nic', 'web')).toEqual(['net', 'topUps']);
    expect(parseYearFields('', 'api')).toEqual([]);
    expect(parseYearFields('nic,jine', 'email')).toEqual(YEAR_DEFAULTS.email);
    expect(serializeYearFields(['topUps', 'net'])).toBe('net,topUps');
  });
  it('pickYearFields vrací rok a jen vybrané údaje', () => {
    const s = { year: 2026, net: 5, topUps: 9 } as unknown as YearStats;
    expect(pickYearFields(s, ['net'])).toEqual({ year: 2026, net: 5 });
  });
});
