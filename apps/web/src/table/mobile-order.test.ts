import { describe, expect, it } from 'vitest';
import { defaultOrder, effectiveOrder, MOBILE_WIDGETS, moveItem, moveToZone, parseMobileOrder, serializeOrder, toggleToolScreen, toolScreens, ZONES, zoneOf } from './mobile-order';

const everywhereOnce = (o: ReturnType<typeof parseMobileOrder>) => {
  const all = ZONES.flatMap((z) => o[z]);
  expect([...all].sort()).toEqual([...MOBILE_WIDGETS].sort());
};

describe('rozmístění widgetů na telefonu', () => {
  it('výchozí: pod stolem pruh času, kombinace a události; informace na obrazovce 2, chat na 3', () => {
    const o = parseMobileOrder('');
    expect(o.screens).toBe(3);
    expect(o.s1).toEqual(['timer', 'best', 'events']);
    expect(o.s2[0]).toBe('table');
    expect(o.s2).toContain('info');
    expect(o.s3).toEqual(['chat']);
    everywhereOnce(o);
  });
  it('starší zaškrtávátka určí výchozí rozmístění', () => {
    const o = defaultOrder({ 'ui.mobileBest': false, 'ui.mobileSounds': true, 'ui.mobileTimerBar': false });
    expect(o.s1).toEqual(['sounds', 'events']);
    expect(o.hidden).toEqual(['timer']);
    expect(o.s2).toContain('best');
  });
  it('uložené rozmístění se použije, nepřípustné a duplicitní položky se zahodí, chybějící doplní', () => {
    const raw = JSON.stringify({ v: 3, screens: 2, s1: ['players', 'info', 'nic', 'players', 'timer', 'chat'], s2: ['timer', 'best'], s3: [], icon: ['events'], hidden: ['info'] });
    const o = parseMobileOrder(raw);
    expect(o.screens).toBe(2);
    expect(o.s1).toEqual(['players', 'timer']);
    expect(o.s2[0]).toBe('best');
    expect(o.icon).toContain('events');
    expect(o.s2).toContain('info');
    everywhereOnce(o);
  });
  it('verze 2 se převede: pod stolem na obrazovku 1, informace na obrazovku 2, chat na 3', () => {
    const o = parseMobileOrder(JSON.stringify({ v: 2, mid: ['events'], info: ['players', 'info'], hidden: ['timer'] }));
    expect(o.s1[0]).toBe('events');
    expect(o.s2.slice(0, 2)).toEqual(['players', 'info']);
    expect(o.s3).toEqual(['chat']);
    everywhereOnce(o);
  });
  it('rozbitá nebo neznámá hodnota vrátí výchozí rozmístění', () => {
    expect(parseMobileOrder('{rozbité').s1).toEqual(['timer', 'best', 'events']);
    expect(parseMobileOrder(JSON.stringify({ mid: ['sounds'] })).s1).toEqual(['timer', 'best', 'events']);
  });
  it('počet obrazovek: nepoužívané se sloučí, při jedné jdou widgety mezi ikony', () => {
    const o = { ...parseMobileOrder(''), s3: ['chat' as const] };
    const two = effectiveOrder({ ...o, screens: 2 });
    expect(two.s3).toEqual([]);
    expect(two.s2).toContain('chat');
    const one = effectiveOrder({ ...o, screens: 1 });
    expect(one.s2).toEqual([]);
    expect(one.icon).toEqual(expect.arrayContaining(['chat', 'info', 'players']));
    everywhereOnce(one);
  });
  it('přesun mezi místy: O hře, chat a pruh času mají omezení', () => {
    const o = parseMobileOrder('');
    const moved = moveToZone(o, 'players', 's3');
    expect(zoneOf(moved, 'players')).toBe('s3');
    expect(moved.s3[moved.s3.length - 1]).toBe('players');
    everywhereOnce(moved);
    expect(moveToZone(o, 'info', 'hidden')).toBe(o);
    expect(moveToZone(o, 'chat', 's1')).toBe(o);
    expect(moveToZone(o, 'timer', 's2')).toBe(o);
    expect(zoneOf(moveToZone(o, 'best', 'icon'), 'best')).toBe('icon');
  });
  it('posun o místo a zpětné načtení', () => {
    expect(moveItem(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    const o = parseMobileOrder('');
    const next = { ...o, s1: moveItem(o.s1, 'events', -1) };
    expect(parseMobileOrder(serializeOrder(next)).s1).toEqual(['timer', 'events', 'best']);
  });
  it('ikony v liště: výchozí jsou historie, pauza, chat a info na všech obrazovkách, ostatní jen v nabídce', () => {
    const o = parseMobileOrder('');
    expect(toolScreens(o, 'history')).toEqual([1, 2, 3]);
    expect(toolScreens(o, 'settlement')).toEqual([]);
    expect(toolScreens(o, 'w:best')).toEqual([1, 2, 3]);
    expect(toolScreens(parseMobileOrder('', { 'ui.mobileAllIcons': true }), 'settlement')).toEqual([1, 2, 3]);
  });
  it('ikona se zapíná po obrazovkách, volba se uloží a načte, při méně obrazovkách se čísla srovnají', () => {
    let o = parseMobileOrder('');
    o = toggleToolScreen(o, 'settlement', 2);
    o = toggleToolScreen(o, 'history', 1);
    const back = parseMobileOrder(serializeOrder(o));
    expect(toolScreens(back, 'settlement')).toEqual([2]);
    expect(toolScreens(back, 'history')).toEqual([2, 3]);
    expect(toolScreens({ ...back, screens: 2 }, 'history')).toEqual([2]);
    expect(toolScreens({ ...back, screens: 1 }, 'history')).toEqual([1]);
  });
  it('verze 3 se načte s výchozími ikonami', () => {
    const o = parseMobileOrder(JSON.stringify({ v: 3, screens: 3, s1: ['timer'], s2: ['info'], s3: ['chat'], icon: [], hidden: [] }));
    expect(toolScreens(o, 'chat')).toEqual([1, 2, 3]);
    expect(o.s1[0]).toBe('timer');
  });
});
