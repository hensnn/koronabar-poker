import { describe, expect, it } from 'vitest';
import { sharedCardCount } from './hand-replay';

describe('přehrávač handy: běhy run it twice', () => {
  it('společné karty jsou ty, které leží na stole ve všech bězích od začátku', () => {
    expect(sharedCardCount([['As', 'Kd', '7c', '2h', '9s'], ['As', 'Kd', '7c', 'Qh', 'Js']])).toBe(3);
    expect(sharedCardCount([['As', 'Kd', '7c', '2h', '9s'], ['Qs', 'Jd', 'Tc', '8h', '3s']])).toBe(0);
    expect(sharedCardCount([['As', 'Kd', '7c', '2h', '9s'], ['As', 'Kd', '7c', '2h', '9s']])).toBe(5);
    expect(sharedCardCount([['As', 'Kd', '7c', '2h', '9s'], ['As', 'Kd', '7c', 'Qh', 'Js'], ['As', 'Kd', '4c', '5h', '6s']])).toBe(2);
    expect(sharedCardCount([])).toBe(0);
  });
});
