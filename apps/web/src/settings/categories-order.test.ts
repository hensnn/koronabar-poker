import { describe, expect, it } from 'vitest';
import { orderCategories } from './SettingsForm';

describe('pořadí karet nastavení', () => {
  it('Chat, Zvukové emotikony, Hlasatel, E-mail za sebou; ostatní karty zůstanou na místě', () => {
    expect(orderCategories(['chat', 'sounds', 'email', 'announcer', 'ui'])).toEqual(['chat', 'sounds', 'announcer', 'email', 'ui']);
    expect(orderCategories(['ui', 'email', 'chat', 'game', 'announcer'])).toEqual(['ui', 'chat', 'announcer', 'game', 'email']);
  });
  it('osobní nastavení: Vzhled a ovládání, E-mail, Chat, Hlasatel, Zvukové emotikony, ostatní za nimi', () => {
    const first = ['ui', 'email', 'chat', 'announcer', 'sounds'];
    expect(orderCategories(['sounds', 'chat', 'live', 'announcer', 'email', 'ui'], first)).toEqual(['ui', 'email', 'chat', 'announcer', 'sounds', 'live']);
    expect(orderCategories(['chat', 'ui'], first)).toEqual(['ui', 'chat']);
  });
  it('chybějící karty nevadí', () => {
    expect(orderCategories(['email', 'chat'])).toEqual(['chat', 'email']);
    expect(orderCategories(['ui'])).toEqual(['ui']);
  });
});
