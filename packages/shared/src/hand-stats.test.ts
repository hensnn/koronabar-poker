import { describe, expect, it } from 'vitest';
import { analyzeHand, type RecordedAction } from './hand-stats.js';

const act = (userId: string, street: string, action: string, amount = 0, facing = 0): RecordedAction => ({ userId, street, action, amount, facing });
const pl = (userId: string, o: Partial<{ invested: number; won: number; status: string; revealed: boolean }> = {}) => ({ userId, invested: 20, won: 0, status: 'active', revealed: false, ...o });

describe('statistiky handy', () => {
  it('VPIP, PFR a 3-bet: open, 3-bet a call', () => {
    const f = analyzeHand(
      [act('a', 'PREFLOP', 'raise', 60, 20), act('b', 'PREFLOP', 'raise', 180, 60), act('c', 'PREFLOP', 'fold'), act('a', 'PREFLOP', 'call', 120, 180)],
      [pl('a'), pl('b'), pl('c', { invested: 0, status: 'folded' })],
      0,
    );
    expect(f.get('a')).toMatchObject({ vpip: true, pfr: true, threeBetChance: false, threeBet: false });
    expect(f.get('b')).toMatchObject({ vpip: true, pfr: true, threeBetChance: true, threeBet: true });
    expect(f.get('c')).toMatchObject({ vpip: false, pfr: false, threeBetChance: false, threeBet: false });
  });

  it('check velkého blindu není dobrovolný vklad, limp ano', () => {
    const f = analyzeHand([act('sb', 'PREFLOP', 'call', 10, 20), act('bb', 'PREFLOP', 'check')], [pl('sb'), pl('bb')], 3);
    expect(f.get('sb')!.vpip).toBe(true);
    expect(f.get('sb')!.pfr).toBe(false);
    expect(f.get('bb')!.vpip).toBe(false);
    expect(f.get('bb')!.sawFlop).toBe(true);
  });

  it('all-in pod aktuální sázkou je call, nad ní zvýšení', () => {
    const f = analyzeHand([act('a', 'PREFLOP', 'raise', 60, 20), act('b', 'PREFLOP', 'allIn', 50, 60), act('c', 'PREFLOP', 'allIn', 400, 60)], [pl('a'), pl('b'), pl('c')], 5);
    expect(f.get('b')).toMatchObject({ vpip: true, pfr: false });
    expect(f.get('c')).toMatchObject({ vpip: true, pfr: true, threeBet: true });
  });

  it('flop vidí jen ten, kdo nesložil předtím; showdown a jeho výhra', () => {
    const f = analyzeHand(
      [act('a', 'PREFLOP', 'call', 20, 20), act('b', 'PREFLOP', 'fold'), act('a', 'FLOP', 'bet', 40), act('c', 'FLOP', 'call', 40, 40)],
      [pl('a', { won: 100, revealed: true }), pl('b', { invested: 0, status: 'folded' }), pl('c', { revealed: true })],
      5,
    );
    expect(f.get('a')).toMatchObject({ sawFlop: true, showdown: true, wonShowdown: true, aggressive: 1 });
    expect(f.get('b')!.sawFlop).toBe(false);
    expect(f.get('c')).toMatchObject({ showdown: true, wonShowdown: false, calls: 1 });
  });
});
