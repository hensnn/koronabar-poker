import { describe, expect, it } from 'vitest';
import { chipColumns } from './Chips';

const total = (cols: { cls: string; count: number }[]) => cols.reduce((n, c) => n + c.count, 0);

describe('žetony na stole: rozklad částky', () => {
  it('malý a velký blind jsou jeden a dva žetony základní jednotky', () => {
    expect(chipColumns(5, 5)).toEqual([{ cls: 'bg-chip-white', count: 1 }]);
    expect(chipColumns(10, 5)).toEqual([{ cls: 'bg-chip-white', count: 2 }]);
  });
  it('vyšší částky se skládají z vyšších hodnot (červený 5×, zelený 25×, modrý 100×)', () => {
    expect(chipColumns(25, 5)).toEqual([{ cls: 'bg-chip-red', count: 1 }]);
    expect(chipColumns(135, 5)).toEqual([{ cls: 'bg-chip-green', count: 1 }, { cls: 'bg-chip-white', count: 2 }]);
    expect(chipColumns(500, 5)[0]).toEqual({ cls: 'bg-chip-blue', count: 1 });
  });
  it('hromádka je omezená a částka pod jednotkou dá aspoň jeden žeton; nulová nic', () => {
    expect(total(chipColumns(10_000_000, 5, 14))).toBeLessThanOrEqual(14);
    expect(chipColumns(3, 5)).toEqual([{ cls: 'bg-chip-white', count: 1 }]);
    expect(chipColumns(0, 5)).toEqual([]);
  });
});
