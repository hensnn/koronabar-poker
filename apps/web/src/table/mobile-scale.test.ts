import { describe, expect, it } from 'vitest';
import { autoShrinkFor, mobileScale, tableHeightFactor } from './mobile';

describe('měřítko prvků na stole na telefonu', () => {
  it('automatické zmenšení podle počtu sedadel', () => {
    expect([2, 6, 7, 8, 9, 10].map(autoShrinkFor)).toEqual([1, 1, 1, 0.92, 0.85, 0.8]);
  });
  it('volba hráče se násobí s automatikou a drží se v rozsahu', () => {
    expect(mobileScale({}, 6)).toBe(1);
    expect(mobileScale({}, 9)).toBe(0.85);
    expect(mobileScale({ 'ui.mobileTableScale': 80 }, 9)).toBe(0.68);
    expect(mobileScale({ 'ui.mobileTableScale': 80, 'ui.mobileAutoShrink': false }, 10)).toBe(0.8);
    expect(mobileScale({ 'ui.mobileTableScale': 10, 'ui.mobileAutoShrink': true }, 10)).toBe(0.5);
    expect(mobileScale({ 'ui.mobileTableScale': 500 }, 6)).toBe(1.1);
  });
});


describe('výška stolu na telefonu', () => {
  it('výchozí a nižší hodnota projdou, vyšší se omezí tak, aby zbylo místo nad ovládacím panelem', () => {
    expect(tableHeightFactor(1, 375, 812, 0.85)).toBe(1);
    expect(tableHeightFactor(0.8, 375, 812, 0.85)).toBe(0.8);
    const k = tableHeightFactor(1.3, 375, 812, 0.7);
    expect(k).toBeLessThan(1.3);
    expect(k).toBeGreaterThanOrEqual(0.6);
  });
});
