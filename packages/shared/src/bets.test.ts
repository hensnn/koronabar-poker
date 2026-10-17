import { describe, expect, it } from 'vitest';
import { favors, outcomeFor, settlePool, subjectsOf, validateBetParams, type TournamentFacts } from './bets.js';

const done = (order: string[]): TournamentFacts => ({ status: 'finished', results: order.map((userId, i) => ({ userId, place: i + 1 })), firstOut: order[order.length - 1]! });

describe('sázky: vyhodnocení výsledku', () => {
  it('vítěz, umístění a souboj podle konečného pořadí', () => {
    const f = done(['a', 'b', 'c']);
    expect(outcomeFor('winner', { userId: 'a' }, f)).toBe('yes');
    expect(outcomeFor('winner', { userId: 'b' }, f)).toBe('no');
    expect(outcomeFor('place', { userId: 'b', place: 2 }, f)).toBe('yes');
    expect(outcomeFor('place', { userId: 'b', place: 3 }, f)).toBe('no');
    expect(outcomeFor('duel', { a: 'b', b: 'c' }, f)).toBe('yes');
    expect(outcomeFor('duel', { a: 'c', b: 'b' }, f)).toBe('no');
  });

  it('hráč, který se nezúčastnil, a zrušený turnaj znamenají vrácení vkladů', () => {
    const f = done(['a', 'b']);
    expect(outcomeFor('winner', { userId: 'zzz' }, f)).toBe('void');
    expect(outcomeFor('duel', { a: 'a', b: 'zzz' }, f)).toBe('void');
    const cancelled: TournamentFacts = { status: 'cancelled', results: null, firstOut: null };
    for (const s of ['winner', 'firstOut', 'place', 'duel'] as const) expect(outcomeFor(s, { userId: 'a', a: 'a', b: 'b', place: 1 }, cancelled)).toBe('void');
  });

  it('první vyřazený jde určit hned po prvním vyřazení, vlastní tvrzení nikdy samo', () => {
    const running: TournamentFacts = { status: 'running', results: null, firstOut: null };
    expect(outcomeFor('firstOut', { userId: 'a' }, running)).toBeNull();
    expect(outcomeFor('winner', { userId: 'a' }, running)).toBeNull();
    expect(outcomeFor('firstOut', { userId: 'a' }, { ...running, firstOut: 'a' })).toBe('yes');
    expect(outcomeFor('firstOut', { userId: 'a' }, { ...running, firstOut: 'b' })).toBe('no');
    expect(outcomeFor('custom', { text: 'Petr vyhraje se 7-2' }, done(['a']))).toBeNull();
  });
});

describe('sázky: ochrana proti sázení proti sobě', () => {
  it('strana, která škodí dotčenému hráči, je „proti“', () => {
    expect(favors('winner', { userId: 'a' }, 'a', 'yes')).toBe('for');
    expect(favors('winner', { userId: 'a' }, 'a', 'no')).toBe('against');
    expect(favors('firstOut', { userId: 'a' }, 'a', 'yes')).toBe('against');
    expect(favors('firstOut', { userId: 'a' }, 'a', 'no')).toBe('for');
    expect(favors('duel', { a: 'a', b: 'b' }, 'b', 'yes')).toBe('against');
    expect(favors('duel', { a: 'a', b: 'b' }, 'b', 'no')).toBe('for');
    expect(favors('winner', { userId: 'a' }, 'x', 'no')).toBe('neutral');
    expect(subjectsOf('duel', { a: 'a', b: 'b' })).toEqual(['a', 'b']);
    expect(subjectsOf('custom', { text: 'x' })).toEqual([]);
  });
});

describe('sázky: kontrola parametrů', () => {
  it('odmítne chybné vstupy a zahodí cizí pole', () => {
    expect(validateBetParams('winner', {}).ok).toBe(false);
    expect(validateBetParams('winner', { userId: 'a', text: 'x' })).toEqual({ ok: true, params: { userId: 'a' } });
    expect(validateBetParams('duel', { a: 'a', b: 'a' }).ok).toBe(false);
    expect(validateBetParams('place', { userId: 'a', place: 0 }).ok).toBe(false);
    expect(validateBetParams('place', { userId: 'a', place: 2.5 }).ok).toBe(false);
    expect(validateBetParams('custom', { text: 'ab' }).ok).toBe(false);
    expect(validateBetParams('custom', { text: '  Petr vyhraje se 7-2 ' })).toEqual({ ok: true, params: { text: 'Petr vyhraje se 7-2' } });
  });
});

describe('sázky: dělení banku', () => {
  const stakes = [
    { userId: 'a', side: 'yes' as const, amount: 100 },
    { userId: 'b', side: 'yes' as const, amount: 50 },
    { userId: 'c', side: 'no' as const, amount: 200 },
  ];

  it('výherci si rozdělí celý bank poměrně a součet sedí na vklady', () => {
    const r = settlePool(stakes, 'yes', 0);
    expect(r.refunded).toBe(false);
    expect(r.fee).toBe(0);
    expect(Object.fromEntries(r.payouts.map((p) => [p.userId, p.amount]))).toEqual({ a: 233, b: 117 });
    expect(r.payouts.reduce((n, p) => n + p.amount, 0)).toBe(350);
  });

  it('poplatek domu se bere z banku a nikdy nevznikne ani nezmizí měna', () => {
    for (const fee of [0, 1, 5, 7, 33, 100]) {
      const r = settlePool(stakes, 'no', fee);
      expect(r.payouts.reduce((n, p) => n + p.amount, 0) + r.fee).toBe(350);
    }
    expect(settlePool(stakes, 'no', 10).fee).toBe(35);
  });

  it('zrušená sázka, nebo sázka bez protistrany vrací vklady beze změny', () => {
    const r = settlePool(stakes, 'void', 10);
    expect(r).toMatchObject({ refunded: true, fee: 0 });
    expect(Object.fromEntries(r.payouts.map((p) => [p.userId, p.amount]))).toEqual({ a: 100, b: 50, c: 200 });
    const oneSided = settlePool(stakes.filter((s) => s.side === 'yes'), 'yes', 10);
    expect(oneSided.refunded).toBe(true);
    expect(oneSided.payouts.reduce((n, p) => n + p.amount, 0)).toBe(150);
  });

  it('hráč s více vklady dostane jednu výplatu', () => {
    const r = settlePool([{ userId: 'a', side: 'yes', amount: 10 }, { userId: 'a', side: 'yes', amount: 30 }, { userId: 'c', side: 'no', amount: 60 }], 'yes', 0);
    expect(r.payouts).toEqual([{ userId: 'a', amount: 100 }]);
  });
});
