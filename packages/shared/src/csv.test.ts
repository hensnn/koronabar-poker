import { describe, expect, it } from 'vitest';
import { csvCell, tournamentCsv } from './csv.js';

describe('CSV', () => {
  it('buňky: uvozovky se zdvojí a text začínající znakem vzorce dostane apostrof, čísla zůstanou', () => {
    expect(csvCell('Jan "Pán"')).toBe('"Jan ""Pán"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell(-100)).toBe('"-100"');
  });
  it('výsledky turnaje: BOM, hlavička, řádky hráčů a celkem', () => {
    const csv = tournamentCsv('Páteční', [
      { place: 1, name: 'A', entries: 1, entryAmount: 110, rebuys: 1, rebuyAmount: 110, addons: 0, addonAmount: 0, spent: 220, payout: 200, bounty: 50, profit: 30 },
      { place: 2, name: '=cmd', entries: 1, entryAmount: 110, rebuys: 0, rebuyAmount: 0, addons: 0, addonAmount: 0, spent: 110, payout: 80, bounty: 0, profit: -30 },
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('Páteční');
    expect(lines[3]).toContain(`'=cmd`);
    expect(lines[4]).toContain('"330"'); // zaplaceno celkem
    expect(lines[4]!.endsWith('"0"')).toBe(true); // součet zisků
  });
});
