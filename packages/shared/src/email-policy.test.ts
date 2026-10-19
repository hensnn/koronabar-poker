import { describe, expect, it } from 'vitest';
import { addressMatches, emailDecision, parseList } from './email-policy.js';

const base = { key: 'vecer_souhrn', security: false, address: 'jan@firma.cz', verified: true, roleKeys: ['hrac'] };

describe('pravidla e-mailů: čistá funkce', () => {
  it('seznam z textu s čárkami, středníky a řádky', () => {
    expect(parseList(' A@x.cz, b@x.cz;\n@Firma.cz ,, ')).toEqual(['a@x.cz', 'b@x.cz', '@firma.cz']);
    expect(parseList(undefined)).toEqual([]);
  });
  it('adresa vyhovuje přesné adrese, doméně i poddoméně', () => {
    expect(addressMatches('jan@firma.cz', 'jan@firma.cz')).toBe(true);
    expect(addressMatches('jan@firma.cz', '@firma.cz')).toBe(true);
    expect(addressMatches('jan@pobocka.firma.cz', 'firma.cz')).toBe(true);
    expect(addressMatches('jan@jinafirma.cz', 'firma.cz')).toBe(false);
    expect(addressMatches('eva@firma.cz', 'jan@firma.cz')).toBe(false);
  });
  it('výchozí nastavení posílá vše', () => {
    expect(emailDecision({ ...base, settings: {} })).toEqual({ send: true });
  });
  it('hlavní vypínač zastaví i bezpečnostní zprávy', () => {
    expect(emailDecision({ ...base, security: true, settings: { 'email.enabled': false } })).toEqual({ send: false, reason: 'disabled' });
  });
  it('bezpečnostní zprávy obejdou druhy a příjemce, ne blokaci', () => {
    const settings = { 'email.disabledKinds': 'vecer_souhrn', 'email.recipientMode': 'roles', 'email.recipientRoles': 'nikdo', 'email.blockList': 'zly@firma.cz' };
    expect(emailDecision({ ...base, security: true, settings })).toEqual({ send: true });
    expect(emailDecision({ ...base, security: true, address: 'zly@firma.cz', settings })).toEqual({ send: false, reason: 'blocked' });
    expect(emailDecision({ ...base, settings })).toEqual({ send: false, reason: 'kind' });
  });
  it('osobní vypnutí', () => {
    expect(emailDecision({ ...base, userOptedOut: true, settings: {} })).toEqual({ send: false, reason: 'userOptOut' });
    expect(emailDecision({ ...base, userOptedOut: true, settings: { 'email.allowUserOptOut': false } })).toEqual({ send: true });
  });
});
