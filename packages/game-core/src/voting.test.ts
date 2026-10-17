import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { VoteError, Voting, type VoteState } from './voting.js';

function make() {
  const clock = new FakeClock();
  const done: VoteState[] = [];
  const changes: string[] = [];
  const voting = new Voting({ clock, handlers: { test: (s) => done.push(s) }, onChange: (s) => changes.push(s.status) });
  return { clock, voting, done, changes };
}

describe('hlasovací engine', () => {
  it('jednomyslné hlasování: přijmou všichni, navrhovatel souhlasí sám', () => {
    const { voting, done } = make();
    const v = voting.propose({ kind: 'test', proposer: 'a', voters: ['a', 'b', 'c'], timeoutMs: 60_000, payload: { x: 1 } });
    expect(v.votes).toEqual({ a: true });
    voting.vote(v.id, 'b', true);
    expect(done).toHaveLength(0);
    voting.vote(v.id, 'c', true);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ status: 'passed', payload: { x: 1 } });
  });

  it('jediné ne zamítne jednomyslné hlasování hned (už nejde dosáhnout)', () => {
    const { voting, done } = make();
    const v = voting.propose({ kind: 'test', proposer: 'a', voters: ['a', 'b', 'c'], timeoutMs: 60_000 });
    voting.vote(v.id, 'b', false);
    expect(done[0]!.status).toBe('rejected');
    expect(() => voting.vote(v.id, 'c', true)).toThrowError(expect.objectContaining({ code: 'CLOSED' }));
  });

  it('bez odpovědi do limitu = nesouhlas', () => {
    const { voting, done, clock } = make();
    const v = voting.propose({ kind: 'test', proposer: 'a', voters: ['a', 'b'], timeoutMs: 30_000 });
    clock.advance(29_999);
    expect(done).toHaveLength(0);
    clock.advance(2);
    expect(done[0]).toMatchObject({ status: 'expired', id: v.id });
  });

  it('většina a procentní práh, váhy hlasů', () => {
    const a = make();
    const m = a.voting.propose({ kind: 'test', proposer: 'a', voters: ['a', 'b', 'c', 'd', 'e'], threshold: { type: 'majority' }, timeoutMs: 1000 });
    a.voting.vote(m.id, 'b', true);
    expect(a.done).toHaveLength(0);
    a.voting.vote(m.id, 'c', true);
    expect(a.done[0]!.status).toBe('passed');

    const b = make();
    const p = b.voting.propose({ kind: 'test', proposer: 'a', voters: ['a', 'b', 'c', 'd'], threshold: { type: 'percent', percent: 75 }, timeoutMs: 1000 });
    b.voting.vote(p.id, 'b', true);
    expect(b.done).toHaveLength(0);
    b.voting.vote(p.id, 'c', true);
    expect(b.done[0]!.status).toBe('passed');

    const w = make();
    const x = w.voting.propose({ kind: 'test', proposer: 'a', voters: ['a', 'b', 'c'], weights: { a: 3, b: 1, c: 1 }, threshold: { type: 'majority' }, timeoutMs: 1000 });
    // a váží 3 ze 5: samo o sobě tvoří většinu
    expect(w.done[0]).toMatchObject({ status: 'passed', id: x.id });
  });

  it('tajné hlasování neukazuje cizí hlasy ani součty, dokud běží', () => {
    const { voting } = make();
    const v = voting.propose({ kind: 'test', proposer: 'a', voters: ['a', 'b', 'c'], secret: true, timeoutMs: 1000 });
    voting.vote(v.id, 'b', true);
    const view = voting.view(v.id, 'c')!;
    expect(view.tally).toEqual({ yes: null, no: null, voted: 2, total: 3 });
    expect(view.voters.find((x) => x.userId === 'a')).toMatchObject({ voted: true, vote: null });
    expect(view.myVote).toBeNull();
    expect(view.canVote).toBe(true);
    expect(voting.view(v.id, 'b')!.myVote).toBe(true);
    voting.vote(v.id, 'c', true);
    const after = voting.view(v.id, 'c')!;
    expect(after.status).toBe('passed');
    expect(after.tally.yes).toBe(3);
  });

  it('nehlasující nemůže hlasovat; neexistující hlasování; zrušení', () => {
    const { voting, done } = make();
    const v = voting.propose({ kind: 'test', proposer: 'a', voters: ['a', 'b'], timeoutMs: 1000 });
    expect(() => voting.vote(v.id, 'z', true)).toThrowError(expect.objectContaining({ code: 'NOT_VOTER' }));
    expect(() => voting.vote('nic', 'a', true)).toThrow(VoteError);
    voting.cancel(v.id);
    expect(done[0]!.status).toBe('cancelled');
    expect(voting.active()).toBeUndefined();
  });

  it('odchod hlasujícího přepočítá hlasování a obnova po restartu dotáhne časovač', () => {
    const { voting } = make();
    const v = voting.propose({ kind: 'test', proposer: 'a', voters: ['a', 'b', 'c'], timeoutMs: 1000 });
    voting.vote(v.id, 'b', true);
    voting.removeVoter(v.id, 'c');
    expect(voting.get(v.id)!.status).toBe('passed');

    const clock = new FakeClock();
    const done: VoteState[] = [];
    const first = new Voting({ clock, handlers: {} });
    const open = first.propose({ kind: 'test', proposer: 'a', voters: ['a', 'b'], timeoutMs: 10_000 });
    const saved = first.all();
    first.stop();
    const second = new Voting({ clock, handlers: { test: (s) => done.push(s) } });
    second.restore(saved);
    expect(second.active()?.id).toBe(open.id);
    clock.advance(10_001);
    expect(done[0]!.status).toBe('expired');
    // nové hlasování po obnově nedostane už použité číslo
    expect(second.propose({ kind: 'test', proposer: 'a', voters: ['a', 'b'], timeoutMs: 1000 }).id).not.toBe(open.id);
  });
});

describe('shoda se společným enginem anket', () => {
  /** Původní vzorec herního hlasování (před převodem na společný engine), použitý jako reference. */
  const legacy = (threshold: VoteState['threshold'], weights: number[], votes: (boolean | null)[], timeUp: boolean): 'open' | 'passed' | 'rejected' | 'expired' => {
    const total = weights.reduce((a, b) => a + b, 0);
    const yes = weights.reduce((n, w, i) => n + (votes[i] === true ? w : 0), 0);
    const no = weights.reduce((n, w, i) => n + (votes[i] === false ? w : 0), 0);
    const needed = threshold.type === 'unanimous' ? total : threshold.type === 'majority' ? Math.floor(total / 2) + 1 : Math.ceil((total * threshold.percent) / 100);
    if (yes >= needed) return 'passed';
    if (yes + (total - yes - no) < needed) return 'rejected';
    return timeUp ? 'expired' : 'open';
  };

  it('všechna pravidla dávají stejný výsledek jako původní vzorec (náhodné průběhy)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const thresholds: VoteState['threshold'][] = [{ type: 'unanimous' }, { type: 'majority' }, { type: 'percent', percent: 60 }, { type: 'percent', percent: 75 }, { type: 'percent', percent: 100 }];
    for (let round = 0; round < 400; round++) {
      const n = 2 + Math.floor(rnd() * 5);
      const weights = Array.from({ length: n }, () => 1 + Math.floor(rnd() * 3));
      const threshold = thresholds[Math.floor(rnd() * thresholds.length)]!;
      const { clock, voting } = make();
      const ids = weights.map((_, i) => `u${i}`);
      const weightMap = Object.fromEntries(ids.map((u, i) => [u, weights[i]!]));
      const v = voting.propose({ kind: 'test', proposer: null, voters: ids, weights: weightMap, threshold, timeoutMs: 1000 });
      const votes: (boolean | null)[] = ids.map(() => null);
      for (const i of [...ids.keys()].sort(() => rnd() - 0.5)) {
        if (rnd() < 0.3) continue;
        if (voting.get(v.id)!.status !== 'open') break;
        votes[i] = rnd() < 0.6;
        voting.vote(v.id, ids[i]!, votes[i]!);
        const expected = legacy(threshold, weights, votes, false);
        expect(voting.get(v.id)!.status, `${JSON.stringify({ threshold, weights, votes })}`).toBe(expected === 'open' ? 'open' : expected);
      }
      if (voting.get(v.id)!.status === 'open') {
        clock.advance(1500);
        expect(voting.get(v.id)!.status).toBe(legacy(threshold, weights, votes, true));
      }
    }
  });
});
