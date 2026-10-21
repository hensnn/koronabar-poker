import { describe, expect, it } from 'vitest';
import { BOARD_COLUMNS, boardName, defaultBoardConfig, effectiveColumns, sanitizeBoardConfig } from './public-board.js';

describe('veřejný přehled: nastavení', () => {
  it('nesmyslné hodnoty nahradí výchozími a drží meze', () => {
    const c = sanitizeBoardConfig({ columns: ['xp', 'nic', 'profit'], sort: 'x', limit: 9999, periodDays: -4, refreshSeconds: 'abc', nameMode: 'x', hiddenUserIds: ['a', '11111111-1111-1111-1111-111111111111'] });
    expect(c.columns).toEqual(['profit', 'xp']); // pevné pořadí, jen známé sloupce
    expect(c.sort).toBe('profit');
    expect(c.limit).toBe(500);
    expect(c.periodDays).toBe(0);
    expect(c.refreshSeconds).toBe(defaultBoardConfig().refreshSeconds);
    expect(c.nameMode).toBe('full');
    expect(c.hiddenUserIds).toEqual(['11111111-1111-1111-1111-111111111111']);
    expect(sanitizeBoardConfig(null)).toEqual(defaultBoardConfig());
  });
  it('sloupce: peníze a vypnuté funkce se nezobrazí', () => {
    const c = { ...defaultBoardConfig(), columns: [...BOARD_COLUMNS], showMoney: false };
    const cols = effectiveColumns(c, { xp: false, rating: false });
    expect(cols).toEqual(['games', 'wins', 'itm', 'avgPlace', 'cashHands']);
    expect(effectiveColumns({ ...c, showMoney: true }, { xp: true, rating: true })).toEqual([...BOARD_COLUMNS]);
  });
  it('přezdívka: jen první písmeno', () => {
    expect(boardName('karel', 'full')).toBe('karel');
    expect(boardName('karel', 'initial')).toBe('K•••');
    expect(boardName('', 'initial')).toBe('?•••');
  });
});

import { defaultAppearance, sanitizeAppearance } from './public-board.js';

describe('vzhled veřejného přehledu', () => {
  it('výchozí vzhled a převzetí platných hodnot, mezí a neplatných voleb', () => {
    expect(sanitizeAppearance(undefined)).toEqual(defaultAppearance());
    const a = sanitizeAppearance({ background: 'gradient', tone: 'info', colorMode: 'dark', width: 'full', density: 'compact', logoSizePercent: 9999, bgOverlayPercent: -1, highlightTop: 99, logo: false, medals: false, footerText: '  Pokerová liga  ', header: 'nesmysl' });
    expect(a).toMatchObject({ background: 'gradient', tone: 'info', colorMode: 'dark', width: 'full', density: 'compact', logoSizePercent: 400, bgOverlayPercent: 0, highlightTop: 10, logo: false, medals: false, footerText: 'Pokerová liga', header: 'card' });
  });
  it('vzhled je součástí nastavení přehledu a starý přehled bez vzhledu dostane výchozí', () => {
    expect(sanitizeBoardConfig({ columns: ['profit'] }).appearance).toEqual(defaultAppearance());
    expect(sanitizeBoardConfig({ appearance: { width: 'wide' } }).appearance.width).toBe('wide');
  });
});
