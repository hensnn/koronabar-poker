import { describe, expect, it } from 'vitest';
import { walletGroupOf } from './wallet-groups';

describe('skupiny pohybů v peněžence', () => {
  it('řadí druhy pohybů do skupin', () => {
    expect(walletGroupOf('cash_buyin')).toBe('cash');
    expect(walletGroupOf('jackpot_payout')).toBe('cash');
    expect(walletGroupOf('turnaj_vyplata')).toBe('tournament');
    expect(walletGroupOf('bounty')).toBe('tournament');
    expect(walletGroupOf('bet_stake')).toBe('bets');
    expect(walletGroupOf('head_bounty_payout')).toBe('bets');
    expect(walletGroupOf('mint')).toBe('topup');
    expect(walletGroupOf('credit_draw')).toBe('credit');
    expect(walletGroupOf('transfer_out')).toBe('transfer');
    expect(walletGroupOf('shop_purchase')).toBe('shop');
    expect(walletGroupOf('neco_noveho')).toBe('other');
  });
});
