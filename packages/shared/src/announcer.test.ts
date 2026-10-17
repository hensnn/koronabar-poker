import { describe, expect, it } from 'vitest';
import { ANNOUNCE_EVENTS, cleanTemplates, defaultVariants, parseCountdown, pickVariant, renderTemplate, variantsOf } from './announcer.js';

describe('hlasatel: šablony', () => {
  it('dosadí proměnné a chybějící nechá prázdné', () => {
    expect(renderTemplate('Blindy {sb} a {bb}.', { sb: 100, bb: 200 })).toBe('Blindy 100 a 200.');
    expect(renderTemplate('Ahoj {nick}!', {})).toBe('Ahoj !');
    expect(renderTemplate('  dvě   mezery ', {})).toBe('dvě mezery');
  });

  it('každá událost má výchozí varianty a ty používají jen povolené proměnné', () => {
    for (const e of ANNOUNCE_EVENTS) {
      const v = defaultVariants(e.key);
      expect(v).toHaveLength(e.defaults);
      for (const text of v) {
        expect(text).not.toBe('');
        for (const m of text.matchAll(/\{(\w+)\}/g)) expect(e.vars).toContain(m[1]);
      }
    }
  });

  it('vlastní varianty přebijí výchozí, prázdné se ignorují', () => {
    expect(variantsOf('bubble', { bubble: { enabled: true, variants: ['Bublina!'] } })).toEqual(['Bublina!']);
    expect(variantsOf('bubble', { bubble: { enabled: true, variants: ['  '] } })).toEqual(defaultVariants('bubble'));
  });

  it('varianta se neopakuje za sebou', () => {
    let last: number | undefined;
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i++) {
      const next = pickVariant(3, last, rnd);
      expect(next).not.toBe(last);
      expect(next).toBeLessThan(3);
      last = next;
    }
    expect(pickVariant(1, 0, rnd)).toBe(0);
  });

  it('ověření šablon z GUI', () => {
    expect(cleanTemplates({ allIn: { enabled: true, variants: ['{nick} jde all-in'] } }).ok).toBe(true);
    expect(cleanTemplates({ allIn: { enabled: true, variants: ['{killer}'] } }).ok).toBe(false);
    expect(cleanTemplates({ nesmysl: { enabled: true, variants: [] } }).ok).toBe(false);
    expect(cleanTemplates({ allIn: { enabled: true, variants: Array(9).fill('x') } }).ok).toBe(false);
    expect(cleanTemplates({ allIn: { enabled: true, variants: ['x'.repeat(201)] } }).ok).toBe(false);
    expect(cleanTemplates([]).ok).toBe(false);
  });

  it('odpočet: čísla sestupně bez duplicit', () => {
    expect(parseCountdown('10, 60;30 60 abc -5 0')).toEqual([60, 30, 10]);
    expect(parseCountdown('')).toEqual([]);
  });
});
