import { describe, expect, it } from 'vitest';
import { applyTiedPayouts, auditPayouts, correctFinishedState, tieIsShareable } from './tied-payouts.js';

const rows = (payouts: number[]) => payouts.map((payout, i) => ({ userId: `u${i + 1}`, place: i + 1, payout }));
const none = new Set<string>();

describe('tieIsShareable', () => {
  it('allows only neighbouring places of eliminated players', () => {
    expect(tieIsShareable([2, 3])).toBe(true);
    expect(tieIsShareable([4, 3, 5])).toBe(true);
    expect(tieIsShareable([1, 2])).toBe(false); // the winner never shares
    expect(tieIsShareable([1, 4])).toBe(false);
    expect(tieIsShareable([2, 4])).toBe(false); // somebody finished in between
    expect(tieIsShareable([3])).toBe(false);
  });
});

describe('applyTiedPayouts', () => {
  it('splits the payouts of a real tie and keeps the total', () => {
    expect(applyTiedPayouts(rows([150, 90, 60]), [['u2', 'u3']])).toEqual([150, 75, 75]);
    expect(applyTiedPayouts(rows([500, 301, 200, 0]), [['u2', 'u3']])).toEqual([500, 251, 250, 0]);
  });
  it('ignores a stale tie between the winner and a distant place', () => {
    expect(applyTiedPayouts(rows([703, 421, 281, 0, 0, 0]), [['u1', 'u4']])).toEqual([703, 421, 281, 0, 0, 0]);
  });
  it('leaves players with a deal amount alone', () => {
    expect(applyTiedPayouts(rows([300, 200, 100, 0]), [['u2', 'u3']], (id) => id === 'u2')).toEqual([300, 200, 100, 0]);
  });
});

describe('auditPayouts', () => {
  it('finds the reported case: the 1st and the 4th place shared the first prize', () => {
    const a = auditPayouts({ results: rows([352, 421, 281, 351, 0, 0]), amounts: [703, 421, 281, 0, 0, 0], tiedGroups: [['u1', 'u4']], rebought: new Set(['u1', 'u4']) });
    expect(a.verdict).toBe('fixable');
    expect(a.correct).toEqual([703, 421, 281, 0, 0, 0]);
    expect(a.stale).toEqual([['u1', 'u4']]);
  });
  it('accepts correct payouts, with and without a real tie', () => {
    expect(auditPayouts({ results: rows([200, 120, 80, 0]), amounts: [200, 120, 80, 0], tiedGroups: [], rebought: none }).verdict).toBe('ok');
    const tie = auditPayouts({ results: rows([200, 100, 100, 0]), amounts: [200, 120, 80, 0], tiedGroups: [['u2', 'u3']], rebought: none });
    expect(tie.verdict).toBe('ok');
    expect(tie.uncertain).toEqual([]);
  });
  it('marks a neighbouring tie as uncertain when a member bought back in', () => {
    const a = auditPayouts({ results: rows([200, 100, 100, 0]), amounts: [200, 120, 80, 0], tiedGroups: [['u2', 'u3']], rebought: new Set(['u3']) });
    expect(a.verdict).toBe('ok');
    expect(a.uncertain).toEqual([['u2', 'u3']]);
  });
  it('does not offer a fix when the difference has another cause', () => {
    // paid amounts do not follow the payout table at all (e.g. settings changed since): review by hand
    expect(auditPayouts({ results: rows([210, 110, 80, 0]), amounts: [200, 120, 80, 0], tiedGroups: [], rebought: none }).verdict).toBe('mismatch');
    // a stale tie exists, but another place differs too
    expect(auditPayouts({ results: rows([100, 130, 70, 100]), amounts: [200, 120, 80, 0], tiedGroups: [['u1', 'u4']], rebought: none }).verdict).toBe('mismatch');
  });
  it('keeps deal amounts: participants get the agreed money, the winner also the kept part', () => {
    const deal = { amounts: { u1: 150, u2: 150 }, keep: 20 };
    const a = auditPayouts({ results: rows([170, 150, 80, 0]), amounts: [200, 120, 80, 0], deal, tiedGroups: [], rebought: none });
    expect(a.verdict).toBe('ok');
    expect(a.correct).toEqual([170, 150, 80, 0]);
  });
});

describe('correctFinishedState', () => {
  const state = () => ({
    status: 'finished' as const,
    results: rows([352, 421, 281, 351]).map((r) => ({ ...r, name: r.userId })),
    tiedGroups: [['u1', 'u4'], ['u2', 'u3']],
    payoutFix: undefined as { at: number; before: Record<string, number> } | undefined,
  });
  it('stores corrected payouts, remembers the originals and drops the stale tie', () => {
    const st = state();
    correctFinishedState(st, { u1: 703, u4: 0 }, 1234);
    expect(st.results.map((r) => r.payout)).toEqual([703, 421, 281, 0]);
    expect(st.payoutFix).toEqual({ at: 1234, before: { u1: 352, u4: 351 } });
    expect(st.tiedGroups).toEqual([['u2', 'u3']]);
  });
  it('refuses a correction that would change the total or name an unknown player', () => {
    expect(() => correctFinishedState(state(), { u1: 703 }, 1)).toThrow();
    expect(() => correctFinishedState(state(), { u9: 0 }, 1)).toThrow();
    expect(() => correctFinishedState({ ...state(), status: 'running' as never }, { u1: 703, u4: 0 }, 1)).toThrow();
  });
});
