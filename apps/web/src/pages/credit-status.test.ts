import { describe, expect, it } from 'vitest';
import { creditStatus } from './credit-status';

describe('creditStatus', () => {
  it('shows nothing without data, or when the overdraft is off for everybody and nothing is owed', () => {
    expect(creditStatus(null)).toBeNull();
    expect(creditStatus(undefined)).toBeNull();
    expect(creditStatus({ enabled: false, limit: 0, debt: 0, available: 0 })).toBeNull();
  });
  it('a player who draws nothing still sees the limit', () => {
    expect(creditStatus({ enabled: true, limit: 1000, debt: 0, available: 1000 })).toEqual({ debt: 0, state: 'unused', limit: 1000, available: 1000, autoRepay: true });
  });
  it('a player with a zero limit is told there is no overdraft for them', () => {
    expect(creditStatus({ enabled: true, limit: 0, debt: 0, available: 0 })).toMatchObject({ debt: 0, state: 'none', limit: 0 });
  });
  it('warns about the debt and says how much is left within the limit', () => {
    expect(creditStatus({ enabled: true, limit: 1000, debt: 251, available: 749 })).toEqual({ debt: 251, state: 'left', limit: 1000, available: 749, autoRepay: true });
  });
  it('a used-up or exceeded limit leaves nothing to draw', () => {
    expect(creditStatus({ enabled: true, limit: 1000, debt: 1000, available: 0 })).toMatchObject({ debt: 1000, state: 'exhausted', available: 0 });
    // the admin lowered the limit below what is already drawn
    expect(creditStatus({ enabled: true, limit: 100, debt: 300, available: 0 })).toMatchObject({ debt: 300, state: 'exhausted', available: 0 });
  });
  it('the debt stays visible after the overdraft is switched off', () => {
    expect(creditStatus({ enabled: false, limit: 0, debt: 80, available: 0 })).toMatchObject({ debt: 80, state: 'off' });
  });
  it('knows when the player has to repay by hand', () => {
    expect(creditStatus({ enabled: true, autoRepay: false, limit: 500, debt: 50, available: 450 })).toMatchObject({ autoRepay: false });
  });
});
