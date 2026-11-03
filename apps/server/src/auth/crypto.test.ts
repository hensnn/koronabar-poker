import { describe, expect, it } from 'vitest';
import { INVITE_ALPHABET, inviteCode, randomToken, safeEqual } from './crypto.js';

describe('kryptografické pomůcky', () => {
  it('pozvánkový kód má požadovanou délku, jen znaky z abecedy bez zaměnitelných znaků a používá všechny znaky rovnoměrně', () => {
    expect(inviteCode()).toHaveLength(10);
    expect(inviteCode(6)).toHaveLength(6);
    const seen = new Map<string, number>();
    for (let i = 0; i < 2000; i++) for (const ch of inviteCode(10)) seen.set(ch, (seen.get(ch) ?? 0) + 1);
    for (const ch of seen.keys()) expect(INVITE_ALPHABET).toContain(ch);
    for (const bad of ['0', 'O', '1', 'I', 'L']) expect(seen.has(bad)).toBe(false);
    // 20 000 znaků na 31 symbolů = asi 645 na znak; každý znak padl a žádný není výrazně vychýlený (zbytek po dělení by některé zvýhodnil)
    expect(seen.size).toBe(INVITE_ALPHABET.length);
    for (const n of seen.values()) expect(n).toBeGreaterThan(450);
    expect(new Set(Array.from({ length: 50 }, () => inviteCode())).size).toBe(50);
  });

  it('náhodný token je URL-safe a dost dlouhý; safeEqual porovnává bez výjimky i různé délky', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(43);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
