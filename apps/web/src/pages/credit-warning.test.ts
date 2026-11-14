import { describe, expect, it } from 'vitest';
import { creditWarning } from './credit-warning';

describe('creditWarning', () => {
  it('shows nothing while the player owes nothing', () => {
    expect(creditWarning(null)).toBeNull();
    expect(creditWarning(undefined)).toBeNull();
    expect(creditWarning({ enabled: true, limit: 1000, debt: 0, available: 1000 })).toBeNull();
    expect(creditWarning({ enabled: false, limit: 0, debt: 0, available: 0 })).toBeNull();
  });
  it('warns about the debt and says how much is left within the limit', () => {
    expect(creditWarning({ enabled: true, limit: 1000, debt: 251, available: 749 })).toEqual({ debt: 251, state: 'left', limit: 1000, available: 749, autoRepay: true });
  });
  it('a used-up or exceeded limit leaves nothing to draw', () => {
    expect(creditWarning({ enabled: true, limit: 1000, debt: 1000, available: 0 })).toMatchObject({ debt: 1000, state: 'exhausted', available: 0 });
    // the admin lowered the limit below what is already drawn
    expect(creditWarning({ enabled: true, limit: 100, debt: 300, available: 0 })).toMatchObject({ debt: 300, state: 'exhausted', available: 0 });
  });
  it('the debt stays visible after the overdraft is switched off', () => {
    expect(creditWarning({ enabled: false, limit: 0, debt: 80, available: 0 })).toMatchObject({ debt: 80, state: 'off' });
  });
  it('knows when the player has to repay by hand', () => {
    expect(creditWarning({ enabled: true, autoRepay: false, limit: 500, debt: 50, available: 450 })).toMatchObject({ autoRepay: false });
  });
});
