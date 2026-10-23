import { describe, expect, it } from 'vitest';
import { defaultLayout, LEFT_DEFAULT, moveToSide, parseLayout, reorder, RIGHT_DEFAULT, sideOf, toggleCollapsed, toggleHidden, toggleSide, WIDGET_IDS } from './layout';

const all = (l: ReturnType<typeof parseLayout>) => [...l.left, ...l.right].sort();

describe('rozložení widgetů: načtení', () => {
  it('prázdné nastavení dá výchozí rozložení (levý a pravý panel)', () => {
    const l = parseLayout('');
    expect(l.left).toEqual([...LEFT_DEFAULT]);
    expect(l.right).toEqual([...RIGHT_DEFAULT]);
    expect(l).toEqual(defaultLayout());
    expect(l.hiddenSides).toEqual([]);
  });
  it('akce hráče jsou součástí widgetu „O hře“, ne samostatné widgety', () => {
    for (const gone of ['plan', 'actions', 'deal', 'tools', 'reveal', 'hand']) expect(WIDGET_IDS as readonly string[]).not.toContain(gone);
  });
  it('rozbitý JSON nespadne', () => {
    expect(parseLayout('{nesmysl').left).toEqual([...LEFT_DEFAULT]);
  });
  it('uložené rozložení se zachová, i když je widget z pravého panelu v levém; zaniklé widgety se zahodí', () => {
    const l = parseLayout(JSON.stringify({ left: ['info', 'plan', 'players'], right: ['table', 'tools', 'bounties'], hidden: ['deal', 'sounds'], collapsed: ['plan', 'best'] }));
    expect(l.left.slice(0, 2)).toEqual(['info', 'players']);
    expect(l.right.slice(0, 2)).toEqual(['table', 'bounties']);
    expect(l.hidden).toEqual(['sounds']);
    expect(l.collapsed).toEqual(['best']);
    expect(all(l)).toEqual([...WIDGET_IDS].sort());
  });
  it('widget nikdy není ve dvou panelech a neznámé widgety se zahodí', () => {
    const l = parseLayout(JSON.stringify({ left: ['best', 'nic', 'info'], right: ['info', 'best'] }));
    expect(l.left).toContain('best');
    expect(l.right).not.toContain('best');
    expect(l.right).not.toContain('info');
    expect(all(l)).toEqual([...WIDGET_IDS].sort());
  });
  it('chybějící widget z novější verze se přidá do svého výchozího panelu za předchozí', () => {
    const l = parseLayout(JSON.stringify({ left: ['table', 'players', 'chat', 'sounds'], right: ['info', 'bounties'] }));
    expect(l.left.indexOf('best')).toBe(l.left.indexOf('table') + 1);
  });
  it('převezme dřívější nastavení levého a pravého panelu, dokud není uložené nové', () => {
    const left = JSON.stringify({ order: ['clock', 'players', 'best'], hidden: ['sounds', 'clock'], collapsed: ['best'] });
    const right = JSON.stringify({ order: ['tools', 'info'], hidden: ['deal'], collapsed: ['info'] });
    const l = parseLayout('', left, right);
    expect(l.left.indexOf('players')).toBeLessThan(l.left.indexOf('best'));
    expect(l.left).not.toContain('clock' as never);
    expect(l.right[0]).toBe('info');
    expect([...l.hidden].sort()).toEqual(['sounds']);
    expect([...l.collapsed].sort()).toEqual(['best', 'info']);
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
    expect(reorder(l, 'best', -1).left.slice(0, 2)).toEqual(['best', 'table']);
    expect(reorder(l, 'table', -1)).toBe(l);
    const skipped = reorder(l, 'table', 1, (id) => id === 'best');
    expect(skipped.left.slice(0, 3)).toEqual(['players', 'best', 'table']);
  });
  it('skrytí a sbalení se přepínají', () => {
    const l = toggleCollapsed(toggleHidden(defaultLayout(), 'info'), 'best');
    expect(l.hidden).toEqual(['info']);
    expect(l.collapsed).toEqual(['best']);
    expect(toggleHidden(l, 'info').hidden).toEqual([]);
  });
});

describe('vypnutí levého nebo pravého panelu', () => {
  it('panel jde vypnout i zapnout a uloží se s rozložením', () => {
    let l = toggleSide(defaultLayout(), 'right');
    expect(l.hiddenSides).toEqual(['right']);
    l = toggleSide(l, 'left');
    expect([...l.hiddenSides].sort()).toEqual(['left', 'right']);
    const back = parseLayout(JSON.stringify(l));
    expect([...back.hiddenSides].sort()).toEqual(['left', 'right']);
    expect(toggleSide(toggleSide(defaultLayout(), 'left'), 'left').hiddenSides).toEqual([]);
  });
  it('neplatné hodnoty se zahodí a vypnutí panelu nemění pořadí widgetů', () => {
    const l = parseLayout(JSON.stringify({ left: [...LEFT_DEFAULT], right: [...RIGHT_DEFAULT], hiddenSides: ['left', 'dole', 5] }));
    expect(l.hiddenSides).toEqual(['left']);
    expect(l.left).toEqual([...LEFT_DEFAULT]);
  });
});
