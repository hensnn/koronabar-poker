import { describe, expect, it } from 'vitest';
import { fitShift } from './keep-in-view';

describe('nabídka mimo okno', () => {
  it('nabídka uvnitř okna se neposouvá', () => {
    expect(fitShift(20, 200, 375)).toBe(0);
  });
  it('nabídka přečnívající vlevo se posune doprava na okraj', () => {
    expect(fitShift(-31, 161, 375)).toBe(39);
  });
  it('nabídka přečnívající vpravo se posune doleva na okraj', () => {
    expect(fitShift(300, 420, 375)).toBe(-53);
  });
  it('nabídka širší než okno se zarovná k levému okraji', () => {
    expect(fitShift(-50, 500, 375)).toBe(58);
  });
});
