import { describe, expect, it } from 'vitest';
import { dayKey, DEFAULT_RANKS, levelFor, levelTable, parseRanks, rankFor, weekKey, xpForLevel, xpToNext } from './progress.js';

const curve = { base: 100, exponentPercent: 150 };

describe('křivka levelů', () => {
  it('potřebné XP roste podle vzorce základ × level^exponent', () => {
    expect(xpToNext(1, curve)).toBe(100);
    expect(xpToNext(4, curve)).toBe(800); // 100 × 4^1,5
    expect(xpToNext(1, { base: 50, exponentPercent: 100 })).toBe(50);
    expect(xpToNext(10, { base: 50, exponentPercent: 100 })).toBe(500);
  });

  it('level z XP a zpět je konzistentní', () => {
    expect(levelFor(0, curve)).toEqual({ level: 1, into: 0, need: 100 });
    expect(levelFor(99, curve).level).toBe(1);
    expect(levelFor(100, curve)).toMatchObject({ level: 2, into: 0 });
    for (const lvl of [2, 5, 12, 40]) {
      const need = xpForLevel(lvl, curve);
      expect(levelFor(need, curve)).toMatchObject({ level: lvl, into: 0 });
      expect(levelFor(need - 1, curve).level).toBe(lvl - 1);
    }
  });

  it('tabulka levelů má rostoucí součty', () => {
    const t = levelTable(10, curve);
    expect(t).toHaveLength(10);
    expect(t[0]).toEqual({ level: 1, need: 100, total: 0 });
    expect(t[9]!.total).toBe(xpForLevel(10, curve));
  });
});

describe('hodnosti', () => {
  it('výchozí hodnosti se načtou a hodnost se vybere podle levelu', () => {
    const p = parseRanks(DEFAULT_RANKS);
    expect(p.errors).toEqual([]);
    expect(p.ranks.map((r) => r.name)).toContain('Legenda');
    expect(rankFor(1, DEFAULT_RANKS).name).toBe('Nováček');
    expect(rankFor(9, DEFAULT_RANKS).name).toBe('Štamgast');
    expect(rankFor(10, DEFAULT_RANKS).name).toBe('Karbaník');
    expect(rankFor(500, DEFAULT_RANKS).name).toBe('Legenda');
  });

  it('neplatné řádky se hlásí a nevhodný text spadne na výchozí hodnosti', () => {
    const p = parseRanks('Nováček|🌱|muted|1\nŠpatně|🙂|duha|5\nBez levelu|x|info|');
    expect(p.ranks).toHaveLength(1);
    expect(p.errors).toHaveLength(2);
    expect(parseRanks('Jen druhý|🙂|info|3').errors).toContain('První hodnost musí začínat na levelu 1');
    expect(rankFor(3, 'nesmysl').name).toBe('Nováček');
  });
});

describe('den a týden', () => {
  it('den se počítá v pásmu Europe/Prague, týden začíná pondělím', () => {
    // 2026-03-01 23:30 UTC je v Praze už 2. března (00:30)
    expect(dayKey(Date.UTC(2026, 2, 1, 23, 30))).toBe('2026-03-02');
    expect(dayKey(Date.UTC(2026, 2, 1, 12, 0))).toBe('2026-03-01');
    expect(weekKey(Date.UTC(2026, 2, 4, 12, 0))).toBe('2026-03-02'); // středa → pondělí 2. 3.
    expect(weekKey(Date.UTC(2026, 2, 8, 12, 0))).toBe('2026-03-02'); // neděle
    expect(weekKey(Date.UTC(2026, 2, 9, 12, 0))).toBe('2026-03-09');
  });
});
