import { describe, expect, it } from 'vitest';
import { defaultOrder, MOBILE_WIDGETS, moveItem, moveToZone, parseMobileOrder, serializeOrder, zoneOf } from './mobile-order';

const everywhereOnce = (o: ReturnType<typeof parseMobileOrder>) => {
  const all = [...o.mid, ...o.info, ...o.hidden];
  expect([...all].sort()).toEqual([...MOBILE_WIDGETS].sort());
};

describe('rozmístění widgetů na telefonu', () => {
  it('výchozí: pod stolem pruh času, kombinace a události, O hře a ostatní v informacích', () => {
    const o = parseMobileOrder('');
    expect(o.mid).toEqual(['timer', 'best', 'events']);
    expect(o.info[0]).toBe('table');
    expect(o.info).toContain('info');
    expect(o.info).not.toContain('best');
    everywhereOnce(o);
  });
  it('starší zaškrtávátka určí výchozí rozmístění', () => {
    const o = defaultOrder({ 'ui.mobileBest': false, 'ui.mobileSounds': true, 'ui.mobileTimerBar': false });
    expect(o.mid).toEqual(['sounds', 'events']);
    expect(o.hidden).toEqual(['timer']);
    expect(o.info).toContain('best');
  });
  it('uložené rozmístění se použije, nepřípustné a duplicitní položky se zahodí, chybějící doplní', () => {
    const raw = JSON.stringify({ v: 2, mid: ['players', 'info', 'nic', 'players', 'timer'], info: ['timer', 'best'], hidden: ['events'] });
    const o = parseMobileOrder(raw);
    expect(o.mid).toEqual(['players', 'timer']);
    expect(o.info.slice(0, 1)).toEqual(['best']);
    expect(o.info).toContain('info');
    expect(o.hidden).toContain('events');
    everywhereOnce(o);
  });
  it('rozbitá nebo stará hodnota vrátí výchozí rozmístění', () => {
    expect(parseMobileOrder('{rozbité').mid).toEqual(['timer', 'best', 'events']);
    expect(parseMobileOrder(JSON.stringify({ mid: ['sounds'] })).mid).toEqual(['timer', 'best', 'events']);
  });
  it('přesun mezi místy: O hře a pruh času mají omezení', () => {
    const o = parseMobileOrder('');
    const moved = moveToZone(o, 'players', 'mid');
    expect(zoneOf(moved, 'players')).toBe('mid');
    expect(moved.mid[moved.mid.length - 1]).toBe('players');
    everywhereOnce(moved);
    expect(moveToZone(o, 'info', 'hidden')).toBe(o);
    expect(moveToZone(o, 'timer', 'info')).toBe(o);
    expect(zoneOf(moveToZone(o, 'best', 'hidden'), 'best')).toBe('hidden');
  });
  it('posun o místo a zpětné načtení', () => {
    expect(moveItem(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    const o = parseMobileOrder('');
    const next = { ...o, mid: moveItem(o.mid, 'events', -1) };
    expect(parseMobileOrder(serializeOrder(next)).mid).toEqual(['timer', 'events', 'best']);
  });
});
