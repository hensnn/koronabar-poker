import { describe, expect, it } from 'vitest';
import { scaledTokenCss, scaleFor, scaleMediaText, type ScaleInput } from './scale-lock';

const base: ScaleInput = { w: 1920, h: 1080, refW: 1920, refH: 1080, mode: 'height', minPercent: 40, maxPercent: 150 };

describe('měřítko okna', () => {
  it('na celé obrazovce je měřítko 1', () => {
    expect(scaleFor(base)).toBe(1);
  });

  it('podle výšky: okno vedle Discordu je nižší i užší, ale řídí se jen výškou', () => {
    expect(scaleFor({ ...base, w: 1500, h: 870 })).toBe(0.81);
    expect(scaleFor({ ...base, w: 960, h: 1080 })).toBe(1);
  });

  it('vždy celé vzorové rozložení: řídí se užším rozměrem', () => {
    expect(scaleFor({ ...base, mode: 'fit', w: 960, h: 1080 })).toBe(0.5);
    expect(scaleFor({ ...base, mode: 'fit', w: 1500, h: 870 })).toBe(0.78);
  });

  it('drží se mezí a bez vzorové velikosti nic nemění', () => {
    expect(scaleFor({ ...base, h: 200 })).toBe(0.4);
    expect(scaleFor({ ...base, h: 4000 })).toBe(1.5);
    expect(scaleFor({ ...base, refH: 0 })).toBe(1);
    expect(scaleFor({ ...base, w: 0 })).toBe(1);
  });

  it('podmínky šířky a výšky v media query se přepočítají, ostatní zůstanou', () => {
    expect(scaleMediaText('(min-width: 64rem)', 0.5)).toBe('(min-width: 32rem)');
    expect(scaleMediaText('(width >= 40rem)', 0.8)).toBe('(width >= 32rem)');
    expect(scaleMediaText('(max-width: 63.99rem)', 0.5)).toBe('(max-width: 31.995rem)');
    expect(scaleMediaText('(max-height: 30rem) and (orientation: landscape) and (pointer: coarse)', 0.5)).toBe('(max-height: 15rem) and (orientation: landscape) and (pointer: coarse)');
    expect(scaleMediaText('(min-aspect-ratio: 1/1)', 0.5)).toBe('(min-aspect-ratio: 1/1)');
    expect(scaleMediaText('(prefers-reduced-motion: reduce)', 0.5)).toBe('(prefers-reduced-motion: reduce)');
    expect(scaleMediaText('(min-width: 64rem)', 1)).toBe('(min-width: 64rem)');
  });

  it('rozměry v pixelech z motivu se násobí měřítkem, písmo a tenké čáry ne', () => {
    const css = scaledTokenCss({ 'space.unit': '4px', 'size.cardWidth': '56px', 'size.textBase': '16px', 'shape.borderWidth': '1px', 'color.bg': '#000', 'size.fontScale': '1.2rem' }, 0.5);
    expect(css).toBe(':root:root:root{--tk-space-unit:2px;--tk-size-cardWidth:28px;}');
    expect(scaledTokenCss({ 'color.bg': '#000' }, 0.5)).toBe('');
  });
});
