import { describe, it, expect } from 'vitest';
import { MILITARY_DIVISIONS } from '@kb/shared';

/**
 * Novější emoji (Unicode 12 a výš, např. 🪖) se na starších systémech (starší Windows 10) vykreslí jako prázdný čtvereček.
 * Ikony divizí ratingu se ukazují v žebříčku všem hráčům, proto musí být ze starších emoji.
 */
const NEWER_EMOJI = /[\u{1FA70}-\u{1FAFF}\u{1F7E0}-\u{1F7EB}\u{1F6D5}-\u{1F6D7}\u{1F6DD}-\u{1F6DF}\u{1F6FA}-\u{1F6FC}\u{1F90C}\u{1F93F}\u{1F972}\u{1F977}\u{1F978}\u{1F9A5}-\u{1F9AA}\u{1F9AE}\u{1F9AF}\u{1F9BA}-\u{1F9BF}\u{1F9C3}-\u{1F9CF}]/u;

describe('ikony divizí: jen emoji, která zobrazí i starší systémy', () => {
  it('vojenské hodnosti nemají emoji novější než Unicode 11', () => {
    const icons = MILITARY_DIVISIONS.split(';').map((d) => d.split('|')[1]!);
    expect(icons).toHaveLength(5);
    expect(icons.filter((i) => NEWER_EMOJI.test(i))).toEqual([]);
  });
});
