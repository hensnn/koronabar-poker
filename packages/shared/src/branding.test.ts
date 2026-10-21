import { describe, expect, it } from 'vitest';
import { LOGIN_DEFAULTS, loginLayoutOf } from './branding.js';

describe('vzhled přihlašovací stránky', () => {
  it('bez nastavení platí výchozí hodnoty', () => {
    expect(loginLayoutOf({})).toEqual(LOGIN_DEFAULTS);
  });
  it('platné hodnoty se převezmou, meze se hlídají a neplatné se nahradí výchozími', () => {
    const l = loginLayoutOf({ 'login.logoSizePercent': 9999, 'login.logoPlacement': 'side', 'branding.loginBackground': 'suits', 'login.bgOverlayPercent': -5, 'login.bgBlur': '7', 'login.cardPosition': 'nesmysl', 'login.cardWidth': 'wide', 'login.showName': false, 'login.tagline': '  Pokerový večer u Karla  ' });
    expect(l).toMatchObject({ logoSizePercent: 400, logoPlacement: 'side', background: 'suits', bgOverlayPercent: 0, bgBlur: 7, cardPosition: 'center', cardWidth: 'wide', showName: false, tagline: 'Pokerový večer u Karla' });
  });
  it('uvítací text se ořízne na 120 znaků', () => {
    expect(loginLayoutOf({ 'login.tagline': 'x'.repeat(300) }).tagline).toHaveLength(120);
  });
});
