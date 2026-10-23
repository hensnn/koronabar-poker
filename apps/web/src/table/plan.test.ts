import { describe, expect, it } from 'vitest';
import type { LegalActions } from '@kb/game-core';
import { resolvePlan } from './plan';

const legal = (over: Partial<LegalActions> = {}): LegalActions => ({ canFold: true, canCheck: false, callAmount: 0, canBet: false, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0, ...over });

describe('plánovaný tah', () => {
  it('check/fold: checkne, když to jde, jinak foldne', () => {
    expect(resolvePlan('checkFold', legal({ canCheck: true }))).toEqual({ type: 'check' });
    expect(resolvePlan('checkFold', legal({ callAmount: 20 }))).toEqual({ type: 'fold' });
  });
  it('check jen když je zadarmo; call i když je to zadarmo (check), jinak dorovná', () => {
    expect(resolvePlan('check', legal({ callAmount: 20 }))).toBeNull();
    expect(resolvePlan('check', legal({ canCheck: true }))).toEqual({ type: 'check' });
    expect(resolvePlan('call', legal({ callAmount: 20 }))).toEqual({ type: 'call' });
    expect(resolvePlan('call', legal({ canCheck: true }))).toEqual({ type: 'check' });
  });
  it('all-in jen když je co sázet nebo dorovnat', () => {
    expect(resolvePlan('allIn', legal({ canRaise: true }))).toEqual({ type: 'allIn' });
    expect(resolvePlan('allIn', legal({ callAmount: 20 }))).toEqual({ type: 'allIn' });
    expect(resolvePlan('allIn', legal())).toBeNull();
  });
  it('fold vždy, pokud je dovolený', () => {
    expect(resolvePlan('fold', legal())).toEqual({ type: 'fold' });
    expect(resolvePlan('fold', legal({ canFold: false }))).toBeNull();
  });
});
