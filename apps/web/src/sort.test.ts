import { describe, expect, it } from 'vitest';
import { sortRows } from './sort';

describe('řazení tabulek', () => {
  const rows = [{ n: 'Čeněk', v: 5 }, { n: 'Adam', v: 20 }, { n: 'Božena', v: 3 }];
  it('čísla číselně (20 je větší než 5), texty česky, směr se obrací', () => {
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.v)).toEqual([20, 5, 3]);
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.v)).toEqual([3, 5, 20]);
    expect(sortRows(rows, (r) => r.n, 'asc').map((r) => r.n)).toEqual(['Adam', 'Božena', 'Čeněk']);
  });
  it('původní pole se nemění', () => {
    const copy = [...rows];
    sortRows(rows, (r) => r.v, 'asc');
    expect(rows).toEqual(copy);
  });
});
