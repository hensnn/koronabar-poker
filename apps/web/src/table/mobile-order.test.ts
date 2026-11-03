import { describe, expect, it } from 'vitest';
import { moveItem, parseMobileOrder, serializeOrder } from './mobile-order';

describe('pořadí widgetů na telefonu', () => {
  it('bez uložené hodnoty platí výchozí pořadí (Můj stůl, O hře, ostatní; chat tam není)', () => {
    const o = parseMobileOrder('');
    expect(o.info.slice(0, 2)).toEqual(['table', 'info']);
    expect(o.info).not.toContain('chat');
    expect(o.mid).toEqual(['timer', 'best', 'sounds', 'events']);
  });
  it('uložené pořadí se použije, neznámé položky se zahodí a chybějící doplní', () => {
    const o = parseMobileOrder(JSON.stringify({ info: ['players', 'nic', 'info'], mid: ['events', 'timer'] }));
    expect(o.info.slice(0, 2)).toEqual(['players', 'info']);
    expect(o.info).toContain('table');
    expect(new Set(o.info).size).toBe(o.info.length);
    expect(o.mid).toEqual(['events', 'timer', 'best', 'sounds']);
  });
  it('rozbitá hodnota vrátí výchozí pořadí', () => {
    expect(parseMobileOrder('{rozbité').mid).toEqual(['timer', 'best', 'sounds', 'events']);
  });
  it('posun o místo a zpětné načtení', () => {
    expect(moveItem(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    const o = parseMobileOrder('');
    expect(parseMobileOrder(serializeOrder({ ...o, mid: moveItem(o.mid, 'events', -1) })).mid).toEqual(['timer', 'best', 'events', 'sounds']);
  });
});
