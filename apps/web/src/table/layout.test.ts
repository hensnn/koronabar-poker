import { describe, expect, it } from 'vitest';
import { defaultLayout, forMobile, LEFT_DEFAULT, moveToSide, parseLayout, reorder, RIGHT_DEFAULT, sideOf, toggleCollapsed, toggleHidden, WIDGET_IDS } from './layout';

const all = (l: ReturnType<typeof parseLayout>) => [...l.left, ...l.right].sort();

describe('rozložení widgetů: načtení', () => {
  it('prázdné nastavení dá výchozí rozložení (levý a pravý panel)', () => {
    const l = parseLayout('');
    expect(l.left).toEqual([...LEFT_DEFAULT]);
    expect(l.right).toEqual([...RIGHT_DEFAULT]);
    expect(l).toEqual(defaultLayout());
  });
  it('rozbitý JSON nespadne', () => {
    expect(parseLayout('{nesmysl').left).toEqual([...LEFT_DEFAULT]);
  });
  it('uložené rozložení se zachová, i když je widget z pravého panelu v levém', () => {
    const l = parseLayout(JSON.stringify({ left: ['info', 'plan'], right: ['table', 'tools'], hidden: ['deal'], collapsed: ['plan'] }));
    expect(l.left.slice(0, 2)).toEqual(['info', 'plan']);
    expect(l.right.slice(0, 2)).toEqual(['table', 'tools']);
    expect(l.right).toContain('bounties');
    expect(l.hidden).toEqual(['deal']);
    expect(l.collapsed).toEqual(['plan']);
    expect(all(l)).toEqual([...WIDGET_IDS].sort());
  });
  it('widget nikdy není ve dvou panelech a neznámé widgety se zahodí', () => {
    const l = parseLayout(JSON.stringify({ left: ['plan', 'nic', 'info'], right: ['info', 'plan', 'deal'] }));
    expect(l.left).toContain('plan');
    expect(l.right).not.toContain('plan');
    expect(l.right).not.toContain('info');
    expect(all(l)).toEqual([...WIDGET_IDS].sort());
  });
  it('chybějící widget z novější verze se přidá do svého výchozího panelu za předchozí', () => {
    const l = parseLayout(JSON.stringify({ left: ['table', 'plan', 'hand', 'actions', 'players', 'chat', 'sounds'], right: ['info', 'bounties', 'deal', 'tools'] }));
    expect(l.left.indexOf('best')).toBe(l.left.indexOf('hand') + 1);
  });
  it('převezme dřívější nastavení levého a pravého panelu, dokud není uložené nové', () => {
    const left = JSON.stringify({ order: ['clock', 'players', 'plan'], hidden: ['sounds', 'clock'], collapsed: ['hand'] });
    const right = JSON.stringify({ order: ['tools', 'info'], hidden: ['deal'], collapsed: ['info'] });
    const l = parseLayout('', left, right);
    expect(l.left.indexOf('players')).toBeLessThan(l.left.indexOf('plan'));
    expect(l.left).not.toContain('clock' as never);
    expect(l.right.slice(0, 2)).toEqual(['tools', 'info']);
    expect([...l.hidden].sort()).toEqual(['deal', 'sounds']);
    expect([...l.collapsed].sort()).toEqual(['hand', 'info']);
    expect(all(l)).toEqual([...WIDGET_IDS].sort());
  });
});

describe('rozložení widgetů: změny', () => {
  it('přesun do druhého panelu', () => {
    const l = moveToSide(defaultLayout(), 'players', 'right');
    expect(sideOf(l, 'players')).toBe('right');
    expect(l.right[l.right.length - 1]).toBe('players');
    expect(l.left).not.toContain('players');
    expect(moveToSide(l, 'players', 'left', 0).left[0]).toBe('players');
  });
  it('změna pořadí přeskakuje nezobrazené widgety a nepřeleze okraj', () => {
    const l = defaultLayout();
    expect(reorder(l, 'plan', -1).left.slice(0, 2)).toEqual(['plan', 'table']);
    expect(reorder(l, 'table', -1)).toBe(l);
    const skipped = reorder(l, 'table', 1, (id) => id === 'plan');
    expect(skipped.left.slice(0, 3)).toEqual(['hand', 'plan', 'table']);
  });
  it('skrytí a sbalení se přepínají', () => {
    const l = toggleCollapsed(toggleHidden(defaultLayout(), 'info'), 'plan');
    expect(l.hidden).toEqual(['info']);
    expect(l.collapsed).toEqual(['plan']);
    expect(toggleHidden(l, 'info').hidden).toEqual([]);
  });
  it('na telefonu zůstanou akce u stolu vždy v pravém sloupci', () => {
    const l = moveToSide(defaultLayout(), 'tools', 'left');
    expect(forMobile(l).right[0]).toBe('tools');
    expect(forMobile(l).left).not.toContain('tools');
    expect(forMobile(defaultLayout())).toEqual(defaultLayout());
  });
});
