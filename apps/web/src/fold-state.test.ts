import { describe, expect, it } from 'vitest';
import { foldScope, isFoldOpen, withFolds } from './fold-state';

describe('paměť zabalených karet', () => {
  it('bez uložené volby platí výchozí stav', () => {
    expect(isFoldOpen('', 'a', true)).toBe(true);
    expect(isFoldOpen('', 'a', false)).toBe(false);
    expect(isFoldOpen('rozbitý json', 'a', true)).toBe(true);
  });
  it('ukládá jen odchylky od výchozího stavu', () => {
    const raw = withFolds('', [{ id: 'a', open: false, def: true }, { id: 'b', open: true, def: true }]);
    expect(JSON.parse(raw)).toEqual({ a: 0 });
    expect(isFoldOpen(raw, 'a', true)).toBe(false);
    expect(isFoldOpen(raw, 'b', true)).toBe(true);
    // návrat na výchozí stav záznam smaže
    expect(withFolds(raw, [{ id: 'a', open: true, def: true }])).toBe('');
  });
  it('při přetečení zapomene nejstarší záznamy', () => {
    let raw = '';
    for (let i = 0; i < 400; i++) raw = withFolds(raw, [{ id: `stranka|dlouhy nazev karty cislo ${i}`, open: false, def: true }]);
    expect(raw.length).toBeLessThanOrEqual(3800);
    expect(isFoldOpen(raw, 'stranka|dlouhy nazev karty cislo 399', true)).toBe(false);
    expect(isFoldOpen(raw, 'stranka|dlouhy nazev karty cislo 0', true)).toBe(true);
  });
  it('karty se pamatují podle stránky, ne podle položky', () => {
    expect(foldScope('/penezenka')).toBe('penezenka');
    expect(foldScope('/ankety/abc')).toBe('ankety');
    expect(foldScope('/admin/tables')).toBe('admin/tables');
    expect(foldScope('/')).toBe('domu');
  });
});
