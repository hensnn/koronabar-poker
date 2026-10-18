import { describe, expect, it } from 'vitest';
import { t } from '@kb/shared';

/** Každý kód chyby, který může stůl (engine i naše pravidla) vrátit hráči, musí mít český text, ne surový klíč. */
const CODES = [
  'BET_TOO_SMALL', 'CANNOT_BET', 'CANNOT_CHECK', 'CANNOT_DEAL', 'CANNOT_RAISE', 'CANNOT_RERAISE', 'INSUFFICIENT_FUNDS', 'INVALID_ACTION', 'INVALID_AMOUNT', 'INVALID_SEAT',
  'NOTHING_TO_CALL', 'NOT_ENOUGH_PLAYERS', 'NOT_SEATED', 'NOT_YOUR_TURN', 'NO_CHIPS', 'PLAYER_NOT_ACTIVE', 'PLAYER_NOT_FOUND', 'RAISE_TOO_SMALL', 'SEAT_OCCUPIED',
  'ALREADY_SEATED', 'BUYIN_TOO_LARGE', 'BUYIN_TOO_SMALL', 'CALL_CLOCK_DISABLED', 'CLOCK_ALREADY_CALLED', 'HIT_AND_RUN', 'NOT_ALLOWED', 'NOT_TOURNAMENT', 'NO_HAND', 'NO_VOTE',
  'STRADDLE_DISABLED', 'TABLE_STOPPED', 'TOPUP_DISABLED', 'TOURNAMENT_TABLE', 'UNKNOWN', 'INTERNAL_ERROR',
];

describe('texty chyb u stolu', () => {
  it.each(CODES)('%s má český text', (code) => {
    expect(t(`error.${code}`)).not.toBe(`error.${code}`);
  });
});
