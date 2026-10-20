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

import { createElement } from 'react';
import { cellValue, compareCells, sortTableRows, textOf } from './sort';

describe('řazení DataTable podle textu buněk', () => {
  it('hodnoty buněk: čísla s mezerami a jednotkami, procenta, záporná, data a text', () => {
    expect(cellValue('1 250 Koron')).toEqual({ kind: 'number', n: 1250 });
    expect(cellValue('+300 Koron')).toEqual({ kind: 'number', n: 300 });
    expect(cellValue('-120')).toEqual({ kind: 'number', n: -120 });
    expect(cellValue('35 %')).toEqual({ kind: 'number', n: 35 });
    expect(cellValue('3,5')).toEqual({ kind: 'number', n: 3.5 });
    expect(cellValue('20. 10. 2026 11:21')).toEqual({ kind: 'number', n: new Date(2026, 9, 20, 11, 21).getTime() });
    expect(cellValue('Karel')).toEqual({ kind: 'text', s: 'Karel' });
    expect(cellValue('2× 110')).toEqual({ kind: 'number', n: 2 }); // počet před částkou
  });
  it('porovnání: čísla číselně, text česky, prázdné vždy nejmenší', () => {
    expect(compareCells(cellValue('20'), cellValue('5'))).toBeGreaterThan(0);
    expect(compareCells(cellValue('Čeněk'), cellValue('Dana'))).toBeLessThan(0);
    expect(compareCells(cellValue(''), cellValue('a'))).toBeLessThan(0);
  });
  it('textOf spojí text v zanořených prvcích a tlačítka bez textu jsou prázdná', () => {
    expect(textOf(createElement('span', null, 'a', createElement('b', null, 5)))).toBe('a5');
    expect(textOf(createElement('button', null))).toBe('');
  });
  it('sortTableRows seřadí <tr> podle sloupce, stabilně a obousměrně; jiné děti vrátí null', () => {
    const row = (k: string, a: string, b: string) => createElement('tr', { key: k }, createElement('td', null, a), createElement('td', null, b));
    const rows = [row('1', 'Bob', '5 Koron'), row('2', 'Ada', '20 Koron'), row('3', 'Cyril', '3 Koron')];
    const keys = (els: { key: unknown }[] | null) => els!.map((e) => String(e.key).slice(2));
    expect(keys(sortTableRows(rows, 0, 'asc'))).toEqual(['2', '1', '3']);
    expect(keys(sortTableRows(rows, 1, 'desc'))).toEqual(['2', '1', '3']);
    expect(keys(sortTableRows(rows, 1, 'asc'))).toEqual(['3', '1', '2']);
    expect(sortTableRows([createElement('div', { key: 'x' })], 0, 'asc')).toBeNull();
  });
});
