import { describe, expect, it } from 'vitest';
import type { LegalActions, TableView } from '@kb/game-core';
import { currentCallAmount, planFor, planTarget, resolvePlan, stepPlan, type PlanState } from './plan';

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

const viewOf = (over: Partial<TableView> = {}): TableView =>
  ({ handId: 'h1', winners: null, legal: null, viewerSeat: 0, seats: [{ seat: 0, bet: 20 }, { seat: 1, bet: 60 }], ...over }) as unknown as TableView;
const state = (over: Partial<PlanState> = {}): PlanState => ({ plan: 'call', tableId: 't1', handId: 'h1', callAmount: 40, ...over });

describe('vazba plánu na stůl a handu', () => {
  it('kolik bych teď dorovnal: nejvyšší sázka minus moje', () => {
    expect(currentCallAmount(viewOf())).toBe(40);
    expect(currentCallAmount(viewOf({ seats: [{ seat: 0, bet: 60 }, { seat: 1, bet: 60 }] as never }))).toBe(0);
  });
  it('plán zvolený mezi handami (i při ukázání výsledku) patří příští handě a připne se k ní při rozdání', () => {
    expect(planTarget(viewOf({ handId: null }))).toBeNull();
    expect(planTarget(viewOf({ winners: [] as never }))).toBeNull();
    expect(planTarget(viewOf())).toBe('h1');
    const s = state({ handId: null });
    expect(stepPlan(s, viewOf({ handId: null }), 't1')).toEqual({ kind: 'keep' });
    expect(stepPlan(s, viewOf({ handId: 'h9', winners: [] as never }), 't1')).toEqual({ kind: 'keep' });
    expect(stepPlan(s, viewOf({ handId: 'h9' }), 't1')).toEqual({ kind: 'bind', handId: 'h9' });
  });
  it('u jiného stolu nebo v jiné handě se plán zruší a nic se nepošle', () => {
    expect(stepPlan(state(), viewOf(), 't2')).toEqual({ kind: 'drop' });
    expect(stepPlan(state(), viewOf({ handId: 'h2', legal: legal({ canCheck: true }) }), 't1')).toEqual({ kind: 'drop' });
  });
  it('„Call“ dorovná jen částku, kterou hráč viděl; po navýšení se zruší', () => {
    expect(stepPlan(state(), viewOf({ legal: legal({ callAmount: 40 }) }), 't1')).toEqual({ kind: 'act', action: { type: 'call' } });
    expect(stepPlan(state(), viewOf({ legal: legal({ callAmount: 120 }) }), 't1')).toEqual({ kind: 'drop' });
    expect(stepPlan(state({ plan: 'fold' }), viewOf({ legal: legal({ callAmount: 120 }) }), 't1')).toEqual({ kind: 'act', action: { type: 'fold' } });
  });
  it('mimo tah se čeká', () => {
    expect(stepPlan(state(), viewOf(), 't1')).toEqual({ kind: 'keep' });
    expect(planFor(state(), 't1')).toBe('call');
    expect(planFor(state(), 't2')).toBeNull();
    expect(planFor(null, 't1')).toBeNull();
  });
});
