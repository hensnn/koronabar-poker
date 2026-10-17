import { describe, expect, it } from 'vitest';
import { DEFAULT_POLL_CONFIG, resolveTie, tally, validateAnswer, validateConfig, weightOf, type Answer, type Ballot, type PollConfig, type Voter } from './engine.js';

const voters = (n: number, weight = 1): Voter[] => Array.from({ length: n }, (_, i) => ({ userId: `u${i + 1}`, weight }));
const cfg = (over: Partial<PollConfig>): PollConfig => ({ ...DEFAULT_POLL_CONFIG, ...over });
const yn = (userId: string, value: 'yes' | 'no' | 'abstain'): Ballot => ({ userId, answer: { type: 'yesno', value } });
const opts = (...ids: string[]) => ids.map((id) => ({ id, label: id.toUpperCase() }));

describe('ano / ne', () => {
  it('prostá většina, abstence se nepočítá, remíza', () => {
    const c = cfg({});
    const r = tally(c, voters(5), [yn('u1', 'yes'), yn('u2', 'yes'), yn('u3', 'no'), yn('u4', 'abstain'), yn('u5', 'no')], true);
    expect(r).toMatchObject({ outcome: 'tie', final: true, tied: ['yes', 'no'] });
    const r2 = tally(c, voters(5), [yn('u1', 'yes'), yn('u2', 'yes'), yn('u3', 'no'), yn('u4', 'abstain')], true);
    expect(r2).toMatchObject({ outcome: 'passed', winners: ['yes'], voted: 4, participationPercent: 80 });
  });

  it('potřebná většina: nadpoloviční ze všech, 2/3, 3/4, jednomyslnost, vlastní procento', () => {
    const six = voters(6);
    const votes = (y: number, n: number) => [...Array.from({ length: y }, (_, i) => yn(`u${i + 1}`, 'yes')), ...Array.from({ length: n }, (_, i) => yn(`u${y + i + 1}`, 'no'))];
    expect(tally(cfg({ threshold: { kind: 'majorityOfAll' } }), six, votes(3, 0), true).outcome).toBe('rejected'); // 3 z 6 není nadpoloviční
    expect(tally(cfg({ threshold: { kind: 'majorityOfAll' } }), six, votes(4, 0), true).outcome).toBe('passed');
    expect(tally(cfg({ threshold: { kind: 'twoThirds' } }), six, votes(4, 2), true).outcome).toBe('passed');
    expect(tally(cfg({ threshold: { kind: 'twoThirds' } }), six, votes(3, 2), true).outcome).toBe('rejected');
    expect(tally(cfg({ threshold: { kind: 'threeQuarters' } }), six, votes(3, 1), true).outcome).toBe('passed');
    expect(tally(cfg({ threshold: { kind: 'threeQuarters' } }), six, votes(2, 1), true).outcome).toBe('rejected');
    expect(tally(cfg({ threshold: { kind: 'unanimous' } }), six, votes(5, 0), true).outcome).toBe('passed');
    expect(tally(cfg({ threshold: { kind: 'unanimous' } }), six, votes(5, 1), true).outcome).toBe('rejected');
    expect(tally(cfg({ threshold: { kind: 'percent', percent: 60 } }), six, votes(3, 2), true).outcome).toBe('passed');
    expect(tally(cfg({ threshold: { kind: 'percent', percent: 70 } }), six, votes(3, 2), true).outcome).toBe('rejected');
  });

  it('nehlasující se počítají podle nastavení', () => {
    const b = [yn('u1', 'yes'), yn('u2', 'yes')];
    expect(tally(cfg({ nonVoters: 'ignore' }), voters(5), b, true).outcome).toBe('passed');
    expect(tally(cfg({ nonVoters: 'no' }), voters(5), b, true).outcome).toBe('rejected');
    expect(tally(cfg({ nonVoters: 'yes' }), voters(5), [yn('u1', 'no')], true).outcome).toBe('passed');
  });

  it('kvórum: počtem i procentem, bez kvóra je výsledek neplatný', () => {
    const b = [yn('u1', 'yes'), yn('u2', 'yes')];
    expect(tally(cfg({ quorum: { kind: 'count', value: 3 } }), voters(10), b, true).outcome).toBe('no_quorum');
    expect(tally(cfg({ quorum: { kind: 'count', value: 2 } }), voters(10), b, true).outcome).toBe('passed');
    expect(tally(cfg({ quorum: { kind: 'percent', value: 30 } }), voters(10), b, true).outcome).toBe('no_quorum');
    expect(tally(cfg({ quorum: { kind: 'percent', value: 20 } }), voters(10), b, true).outcome).toBe('passed');
  });

  it('váhy hlasů mění výsledek; hlasy neoprávněných se nepočítají', () => {
    const vs: Voter[] = [{ userId: 'a', weight: 3 }, { userId: 'b', weight: 1 }, { userId: 'c', weight: 1 }];
    const r = tally(cfg({}), vs, [yn('a', 'yes'), yn('b', 'no'), yn('c', 'no'), yn('cizi', 'no')], true);
    expect(r.outcome).toBe('passed'); // 3 proti 2
    expect(r.voted).toBe(3);
  });

  it('předčasné ukončení: když výsledek nejde zvrátit nebo hlasovali všichni; jinak běží dál', () => {
    const c = cfg({});
    const open = tally(c, voters(5), [yn('u1', 'yes'), yn('u2', 'yes')], false);
    expect(open).toMatchObject({ final: false, outcome: 'open' });
    const decided = tally(c, voters(5), [yn('u1', 'yes'), yn('u2', 'yes'), yn('u3', 'yes')], false);
    expect(decided).toMatchObject({ final: true, outcome: 'passed' });
    const rejected = tally(c, voters(5), [yn('u1', 'no'), yn('u2', 'no'), yn('u3', 'no')], false);
    expect(rejected).toMatchObject({ final: true, outcome: 'rejected' });
    const all = tally(c, voters(2), [yn('u1', 'yes'), yn('u2', 'no')], false);
    expect(all).toMatchObject({ final: true, outcome: 'tie' });
    const off = tally(cfg({ earlyClose: false }), voters(5), [yn('u1', 'yes'), yn('u2', 'yes'), yn('u3', 'yes')], false);
    expect(off.final).toBe(false);
    // 2/3 s nehlasujícími jako „ne“: tři hlasy ano z pěti ještě nestačí a může se to otočit
    const strict = tally(cfg({ threshold: { kind: 'twoThirds' }, nonVoters: 'no' }), voters(6), [yn('u1', 'yes'), yn('u2', 'yes'), yn('u3', 'yes')], false);
    expect(strict.final).toBe(false);
  });
});

describe('výběr z možností', () => {
  const base = cfg({ type: 'single', options: opts('a', 'b', 'c') });
  const pick = (userId: string, option: string): Ballot => ({ userId, answer: { type: 'single', option } });

  it('vyhrává nejvíc hlasů, váhy se počítají, remíza se hlásí', () => {
    const r = tally(base, voters(5), [pick('u1', 'a'), pick('u2', 'a'), pick('u3', 'b'), pick('u4', 'c')], true);
    expect(r).toMatchObject({ outcome: 'passed', winners: ['a'] });
    expect(r.options[0]).toMatchObject({ id: 'a', score: 2, voters: 2 });
    const tie = tally(base, voters(4), [pick('u1', 'a'), pick('u2', 'b')], true);
    expect(tie).toMatchObject({ outcome: 'tie', tied: ['a', 'b'] });
    const weighted = tally(base, [{ userId: 'x', weight: 5 }, { userId: 'y', weight: 1 }, { userId: 'z', weight: 1 }], [pick('x', 'c'), pick('y', 'a'), pick('z', 'a')], true);
    expect(weighted.winners).toEqual(['c']);
  });

  it('potřebná většina platí i pro volbu možnosti', () => {
    const b = [pick('u1', 'a'), pick('u2', 'a'), pick('u3', 'b'), pick('u4', 'c'), pick('u5', 'c')];
    expect(tally(cfg({ ...base, threshold: { kind: 'percent', percent: 60 } }), voters(5), b, true).outcome).toBe('tie'); // a a c mají po dvou
    const b2 = [pick('u1', 'a'), pick('u2', 'a'), pick('u3', 'a'), pick('u4', 'c'), pick('u5', 'b')];
    expect(tally(cfg({ ...base, threshold: { kind: 'twoThirds' } }), voters(5), b2, true).outcome).toBe('rejected'); // 3/5 nestačí
    expect(tally(cfg({ ...base, threshold: { kind: 'majorityOfAll' } }), voters(5), b2, true).outcome).toBe('passed');
  });

  it('jedna volba se předčasně uzavře, když náskok nelze dohnat', () => {
    const r = tally(base, voters(5), [pick('u1', 'a'), pick('u2', 'a'), pick('u3', 'a')], false);
    expect(r).toMatchObject({ final: true, outcome: 'passed', winners: ['a'] });
    expect(tally(base, voters(5), [pick('u1', 'a'), pick('u2', 'b')], false).final).toBe(false);
  });

  it('více voleb: schválení každé možnosti, kontrola minima a maxima', () => {
    const c = cfg({ type: 'multi', options: opts('a', 'b', 'c'), minChoices: 1, maxChoices: 2 });
    const m = (userId: string, options: string[]): Ballot => ({ userId, answer: { type: 'multi', options } });
    const r = tally(c, voters(3), [m('u1', ['a', 'b']), m('u2', ['a']), m('u3', ['b', 'a'])], true);
    expect(r).toMatchObject({ outcome: 'passed', winners: ['a'] });
    expect(r.options.map((o) => [o.id, o.score])).toEqual([['a', 3], ['b', 2], ['c', 0]]);
    expect(validateAnswer(c, { type: 'multi', options: ['a', 'b', 'c'] })).toBe('count');
    expect(validateAnswer(c, { type: 'multi', options: [] })).toBe('count');
    expect(validateAnswer(c, { type: 'multi', options: ['a', 'a'] })).toBe('option');
  });
});

describe('pořadí preferencí', () => {
  const c = cfg({ type: 'ranked', options: opts('a', 'b', 'c') });
  const r = (userId: string, order: string[]): Ballot => ({ userId, answer: { type: 'ranked', order } });

  it('okamžitý rozstřel: poslední vypadne a jeho hlasy se přesunou', () => {
    const res = tally(c, voters(5), [r('u1', ['a', 'b', 'c']), r('u2', ['a', 'c', 'b']), r('u3', ['b', 'c', 'a']), r('u4', ['c', 'b', 'a']), r('u5', ['c', 'b', 'a'])], true);
    expect(res.rounds![0]!.eliminated).toBe('b');
    expect(res).toMatchObject({ outcome: 'passed', winners: ['c'] });
  });

  it('většina hned v prvním kole a prázdné hlasování', () => {
    const win = tally(c, voters(3), [r('u1', ['a']), r('u2', ['a', 'b']), r('u3', ['b'])], true);
    expect(win.winners).toEqual(['a']);
    expect(win.rounds).toHaveLength(1);
    expect(tally(c, voters(3), [], true).outcome).toBe('rejected');
  });

  it('stejně silné možnosti vedou na remízu', () => {
    const res = tally(c, voters(2), [r('u1', ['a']), r('u2', ['b'])], true);
    expect(res.outcome).toBe('tie');
    expect(res.tied.sort()).toEqual(['a', 'b']);
  });
});

describe('hodnocení a termíny', () => {
  it('hodnocení: vyhrává nejvyšší vážený průměr', () => {
    const c = cfg({ type: 'rating', options: opts('a', 'b'), ratingMax: 5 });
    const rt = (userId: string, scores: Record<string, number>): Ballot => ({ userId, answer: { type: 'rating', scores } });
    const res = tally(c, voters(3), [rt('u1', { a: 5, b: 3 }), rt('u2', { a: 4, b: 5 }), rt('u3', { a: 5 })], true);
    expect(res.winners).toEqual(['a']);
    expect(res.options[0]!.extra!.average).toBeCloseTo(4.67, 1);
    expect(validateAnswer(c, { type: 'rating', scores: { a: 6 } })).toBe('score');
    expect(validateAnswer(c, { type: 'rating', scores: { x: 3 } })).toBe('score');
  });

  it('výběr termínu: „můžu“ váží víc než „když musím“, „nemůžu“ nepočítá', () => {
    const c = cfg({ type: 'schedule', options: opts('pa', 'so', 'ne') });
    const s = (userId: string, slots: Record<string, 'yes' | 'maybe' | 'no'>): Ballot => ({ userId, answer: { type: 'schedule', slots } });
    const res = tally(c, voters(4), [s('u1', { pa: 'yes', so: 'yes', ne: 'no' }), s('u2', { pa: 'maybe', so: 'yes', ne: 'no' }), s('u3', { pa: 'yes', so: 'maybe', ne: 'maybe' }), s('u4', { pa: 'no', so: 'yes', ne: 'no' })], true);
    expect(res.winners).toEqual(['so']);
    expect(res.options[0]).toMatchObject({ id: 'so', score: 3.5 });
    expect(res.options[0]!.extra!.available).toBe(4);
    expect(validateAnswer(c, { type: 'schedule', slots: { pa: 'ano' as never } })).toBe('slot');
  });

  it('volná odpověď: tajná anketa texty neprozradí autora', () => {
    const t = (userId: string, text: string): Ballot => ({ userId, answer: { type: 'text', text } });
    const pub = tally(cfg({ type: 'text' }), voters(2), [t('u1', 'nápad'), t('u2', 'jiný')], true);
    expect(pub.texts).toEqual([{ userId: 'u1', text: 'nápad' }, { userId: 'u2', text: 'jiný' }]);
    const anon = tally(cfg({ type: 'text', anonymity: 'anonymous' }), voters(2), [t('u1', 'nápad')], true);
    expect(anon.texts).toEqual([{ userId: null, text: 'nápad' }]);
    expect(validateAnswer(cfg({ type: 'text' }), { type: 'text', text: '  ' })).toBe('text');
  });
});

describe('remíza a váhy', () => {
  const c = cfg({ type: 'single', options: opts('a', 'b'), tie: 'role' });
  const vs: Voter[] = [{ userId: 'n', weight: 1, power: 10 }, { userId: 'm', weight: 1, power: 50 }];
  const ballots: Ballot[] = [{ userId: 'n', answer: { type: 'single', option: 'a' } }, { userId: 'm', answer: { type: 'single', option: 'b' } }];

  it('rozhodne nejvýše postavená role, los, nebo zakladatel / prodloužení', () => {
    expect(resolveTie(c, ['a', 'b'], vs, ballots, () => 0)).toEqual({ winner: 'b' });
    expect(resolveTie({ ...c, tie: 'random' }, ['a', 'b'], vs, ballots, () => 0.99)).toEqual({ winner: 'b' });
    expect(resolveTie({ ...c, tie: 'random' }, ['a', 'b'], vs, ballots, () => 0)).toEqual({ winner: 'a' });
    expect(resolveTie({ ...c, tie: 'founder' }, ['a', 'b'], vs, ballots, () => 0)).toEqual({ needs: 'founder' });
    expect(resolveTie({ ...c, tie: 'extend' }, ['a', 'b'], vs, ballots, () => 0)).toEqual({ needs: 'extend' });
  });

  it('váha hráče podle role, levelu, ratingu a stacku, se stropem', () => {
    expect(weightOf({ mode: 'equal' }, { level: 9, rating: 1800, stack: 100 })).toBe(1);
    expect(weightOf({ mode: 'byRole', table: { admin: 3 } }, { roleKey: 'admin', level: 1, rating: null, stack: null })).toBe(3);
    expect(weightOf({ mode: 'byRole', table: { admin: 3 } }, { roleKey: 'hrac', level: 1, rating: null, stack: null })).toBe(1);
    expect(weightOf({ mode: 'byLevel', step: 5 }, { level: 12, rating: null, stack: null })).toBe(3);
    expect(weightOf({ mode: 'byRating' }, { level: 1, rating: 3000, stack: null })).toBe(2);
    expect(weightOf({ mode: 'byRating' }, { level: 1, rating: null, stack: null })).toBe(1);
    expect(weightOf({ mode: 'byStack', cap: 500 }, { level: 1, rating: null, stack: 2500 })).toBe(500);
  });
});

describe('kontrola nastavení', () => {
  it('odmítne nesmyslné konfigurace', () => {
    expect(validateConfig(cfg({}))).toBeNull();
    expect(validateConfig(cfg({ type: 'single', options: opts('a') }))).toBe('options');
    expect(validateConfig(cfg({ type: 'single', options: opts('a', 'a') }))).toBe('options');
    expect(validateConfig(cfg({ type: 'multi', options: opts('a', 'b'), minChoices: 3 }))).toBe('choices');
    expect(validateConfig(cfg({ type: 'rating', options: opts('a', 'b') }))).toBe('rating');
    expect(validateConfig(cfg({ type: 'rating', options: opts('a', 'b'), ratingMax: 5 }))).toBeNull();
    expect(validateConfig(cfg({ type: 'schedule', options: opts('a') }))).toBeNull();
    expect(validateConfig(cfg({ threshold: { kind: 'percent' } }))).toBe('threshold');
    expect(validateConfig(cfg({ quorum: { kind: 'percent', value: 150 } }))).toBe('quorum');
    expect(validateConfig(cfg({ weights: { mode: 'byLevel' } }))).toBe('weights');
  });

  it('odpověď jiného druhu se odmítne', () => {
    const a: Answer = { type: 'single', option: 'a' };
    expect(validateAnswer(cfg({ type: 'yesno' }), a)).toBe('type');
    expect(validateAnswer(cfg({ type: 'ranked', options: opts('a', 'b') }), { type: 'ranked', order: ['a', 'a'] })).toBe('order');
  });
});
