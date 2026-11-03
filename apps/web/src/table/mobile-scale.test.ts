import { describe, expect, it } from 'vitest';
import { autoShrinkFor, mobileScale } from './mobile';

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
