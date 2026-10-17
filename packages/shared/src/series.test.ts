import { describe, expect, it } from 'vitest';
import { DEFAULT_SERIES, pointsFor, seriesStandings, validateSeriesConfig, type SeriesConfig, type SeriesTournament } from './series.js';

const t = (id: string, order: string[], at = 1): SeriesTournament => ({ id, name: id, finishedAt: at, results: order.map((userId, i) => ({ userId, place: i + 1 })) });

describe('série a ligy', () => {
  it('body za místo podle tabulky, za účast a lineárně podle počtu hráčů', () => {
    expect(pointsFor(DEFAULT_SERIES, 1, 6)).toBe(26);
    expect(pointsFor(DEFAULT_SERIES, 3, 6)).toBe(16);
    expect(pointsFor(DEFAULT_SERIES, 20, 30)).toBe(1); // mimo tabulku už jen účast
    const lin: SeriesConfig = { ...DEFAULT_SERIES, mode: 'linear', linearFactor: 10, participation: 0 };
    expect(pointsFor(lin, 1, 5)).toBe(50);
    expect(pointsFor(lin, 5, 5)).toBe(10);
  });

  it('žebříček sčítá body, řadí podle bodů, výher a nejlepšího místa a dělí shodné pořadí', () => {
    const cfg: SeriesConfig = { ...DEFAULT_SERIES, table: [10, 6, 3], participation: 0 };
    const s = seriesStandings(cfg, [t('t1', ['a', 'b', 'c']), t('t2', ['b', 'a', 'c']), t('t3', ['c', 'b', 'a'])]);
    // a: 10+6+3 = 19, b: 6+10+6 = 22, c: 3+3+10 = 16
    expect(s.map((r) => [r.userId, r.total])).toEqual([['b', 22], ['a', 19], ['c', 16]]);
    expect(s[0]!.rank).toBe(1);
    expect(s[1]!.rank).toBe(2);
    expect(s[2]!.rank).toBe(3);
    // shodné body i výhry i místa i počet turnajů = stejné pořadí
    const tie = seriesStandings({ ...DEFAULT_SERIES, table: [5, 5], participation: 0 }, [t('x', ['a', 'b']), t('y', ['b', 'a'])]);
    expect(tie.map((r) => r.rank)).toEqual([1, 1]);
  });

  it('počítá se jen N nejlepších výsledků', () => {
    const cfg: SeriesConfig = { ...DEFAULT_SERIES, table: [10, 5, 1], participation: 0, bestOf: 2 };
    const s = seriesStandings(cfg, [t('t1', ['a', 'b']), t('t2', ['b', 'a']), t('t3', ['a', 'b']), t('t4', ['a', 'b'])]);
    const a = s.find((r) => r.userId === 'a')!;
    expect(a.total).toBe(20); // z 10+5+10+10 se počítají dvě nejlepší
    expect(a.counted).toHaveLength(2);
    expect(a.played).toBe(4);
  });

  it('validace nastavení série', () => {
    expect(validateSeriesConfig(DEFAULT_SERIES)).toBeNull();
    expect(validateSeriesConfig({ ...DEFAULT_SERIES, table: [-1] })).toBe('table');
    expect(validateSeriesConfig({ ...DEFAULT_SERIES, finalTopN: 11 })).toBe('finalTopN');
    expect(validateSeriesConfig({ ...DEFAULT_SERIES, bestOf: 1.5 })).toBe('bestOf');
  });
});
