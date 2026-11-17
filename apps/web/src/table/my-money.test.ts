import { describe, expect, it } from 'vitest';
import { cashMoney, currentLadderRow, payoutLadder, signOf, stackValue } from './my-money';

describe('Moje peníze: cash stůl', () => {
  it('výsledek = co mám před sebou a co jsem odnesl, minus co jsem koupil', () => {
    expect(cashMoney(500, 0, 730)).toEqual({ invested: 500, atTable: 730, cashedOut: 0, net: 230 });
    expect(cashMoney(500, 0, 120).net).toBe(-380);
    // dřívější odchod ode stolu a nové usednutí: vybrané peníze se počítají do výsledku
    expect(cashMoney(1000, 400, 700).net).toBe(100);
  });
  it('žetony se přepočítají na měnu dolů, jako při cash-outu', () => {
    expect(stackValue(1999, 10)).toBe(199);
    expect(stackValue(500, 1)).toBe(500);
    expect(stackValue(500, 0)).toBe(0);
  });
});

describe('Moje peníze: turnaj', () => {
  const payouts = [{ place: 1, amount: 600 }, { place: 2, amount: 300 }, { place: 3, amount: 100 }];

  it('každé placené místo ukáže výhru a výsledek po odečtení vloženého; mimo placená místa je jen ztráta', () => {
    expect(payoutLadder(payouts, 150, 0)).toEqual([
      { place: 1, prize: 600, net: 450 },
      { place: 2, prize: 300, net: 150 },
      { place: 3, prize: 100, net: -50 },
      { place: null, prize: 0, net: -150 },
    ]);
  });
  it('získaná bounty se přičítá ke každému řádku, i mimo placená místa', () => {
    const rows = payoutLadder(payouts, 150, 40);
    expect(rows.map((r) => r.net)).toEqual([490, 190, -10, -110]);
  });
  it('rebuy navyšuje vloženou částku a tím snižuje všechny výsledky', () => {
    expect(payoutLadder(payouts, 250, 0).map((r) => r.net)).toEqual([350, 50, -150, -250]);
  });
  it('při mnoha placených místech se ukáže první trojka a poslední placené, ne všechna', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ place: i + 1, amount: 1000 - i * 100 }));
    expect(payoutLadder(many, 100, 0).map((r) => r.place)).toEqual([1, 2, 3, 9, null]);
  });
  it('místa s nulovou výplatou se nepočítají jako placená', () => {
    expect(payoutLadder([{ place: 1, amount: 500 }, { place: 2, amount: 0 }], 100, 0).map((r) => r.place)).toEqual([1, null]);
  });
  it('bez placených míst (turnaj ještě nemá prize pool) je jen řádek „mimo peníze“', () => {
    expect(payoutLadder([], 100, 0)).toEqual([{ place: null, prize: 0, net: -100 }]);
  });

  it('zvýrazní se řádek, ve kterém hráč právě je', () => {
    const rows = payoutLadder(payouts, 150, 0);
    expect(currentLadderRow(rows, 2)).toBe(1);
    expect(currentLadderRow(rows, 7)).toBe(3); // za posledním placeným místem
    expect(currentLadderRow(rows, null)).toBe(-1);
    const many = payoutLadder(Array.from({ length: 9 }, (_, i) => ({ place: i + 1, amount: 100 })), 50, 0);
    expect(currentLadderRow(many, 5)).toBe(-1); // 5. místo žebříček nevypisuje
    expect(currentLadderRow(many, 12)).toBe(many.length - 1);
  });
});

describe('znaménko', () => {
  it('plus, mínus (pravé minus) a nic u nuly', () => {
    expect(signOf(5)).toBe('+');
    expect(signOf(-5)).toBe('−');
    expect(signOf(0)).toBe('');
  });
});
