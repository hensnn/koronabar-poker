import { describe, it, expect } from 'vitest';
import { accounts, CashService, Ledger, LedgerError } from './index.js';

const mk = () => {
  const l = new Ledger();
  return { l, c: new CashService(l) };
};

describe('účetní kniha', () => {
  it('odmítne nevyvážené a neceločíselné transakce', () => {
    const { l } = mk();
    expect(() => l.post({ kind: 'mint', idempotencyKey: 'a', entries: [{ account: 'x', amount: 5 }, { account: 'y', amount: -4 }] })).toThrow(LedgerError);
    expect(() => l.post({ kind: 'mint', idempotencyKey: 'b', entries: [{ account: 'x', amount: 1.5 }, { account: 'y', amount: -1.5 }] })).toThrow(/NOT_INTEGER/);
    expect(() => l.post({ kind: 'mint', idempotencyKey: 'c', entries: [{ account: 'x', amount: 0 }] })).toThrow(/EMPTY/);
  });

  it('peněženka nesmí do mínusu (bez limitu), s limitem ano', () => {
    const { l, c } = mk();
    c.mint('u1', 100, 'm1');
    expect(() => c.buyIn('u1', 't1', 150, 'b1')).toThrow(/INSUFFICIENT/);
    l.setPolicy({ negativeBalanceLimit: 100 });
    c.buyIn('u1', 't1', 150, 'b2');
    expect(l.balance(accounts.wallet('u1'))).toBe(-50);
    expect(() => c.buyIn('u1', 't1', 100, 'b3')).toThrow(/INSUFFICIENT/);
  });

  it('opakované volání se stejným klíčem se neprovede podruhé', () => {
    const { l, c } = mk();
    c.mint('u1', 100, 'm1');
    c.buyIn('u1', 't1', 40, 'same');
    c.buyIn('u1', 't1', 40, 'same');
    expect(l.balance(accounts.wallet('u1'))).toBe(60);
    expect(() => c.buyIn('u1', 't1', 50, 'same')).toThrow(/KEY_REUSED/);
  });

  it('neúspěšná transakce nic nezmění', () => {
    const { l, c } = mk();
    c.mint('u1', 100, 'm1');
    expect(() =>
      l.post({
        kind: 'manual_adjustment',
        idempotencyKey: 'x',
        entries: [
          { account: accounts.wallet('u1'), amount: -50 },
          { account: accounts.wallet('u2'), amount: -50 },
          { account: accounts.house(), amount: 100 },
        ],
      }),
    ).toThrow(/INSUFFICIENT/);
    expect(l.balance(accounts.wallet('u1'))).toBe(100);
    expect(l.balance(accounts.house())).toBe(0);
  });

  it('cash-out s kurzem žetonů: zbytek, který nejde převést, se neztrácí v knize', () => {
    const l = new Ledger();
    const c = new CashService(l, 10);
    c.mint('u1', 100, 'm');
    const chips = c.buyIn('u1', 't', 50, 'b');
    expect(chips).toBe(500);
    expect(c.cashOut('u1', 't', 505, 'o')).toBe(50);
    expect(l.balance(accounts.wallet('u1'))).toBe(100);
    expect(l.balance(accounts.table('t'))).toBe(0);
  });

  it('součet všech účtů včetně mint je vždy nula (fuzz)', () => {
    const { l, c } = mk();
    let seed = 3;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const users = ['a', 'b', 'c', 'd'];
    const ids = [accounts.mint(), accounts.house(), ...users.map(accounts.wallet), accounts.table('t1'), accounts.table('t2')];
    for (const u of users) c.mint(u, 1000, `m-${u}`);
    for (let i = 0; i < 500; i++) {
      const u = users[Math.floor(rnd() * 4)]!;
      const t = rnd() < 0.5 ? 't1' : 't2';
      try {
        if (rnd() < 0.5) c.buyIn(u, t, 1 + Math.floor(rnd() * 400), `k${i}`);
        else c.cashOut(u, t, 1 + Math.floor(rnd() * 300), `k${i}`);
      } catch (e) {
        expect(e).toBeInstanceOf(LedgerError);
      }
      expect(l.totalIsZero(ids)).toBe(true);
    }
    for (const id of ids.filter((x) => x !== accounts.mint())) expect(l.balance(id)).toBeGreaterThanOrEqual(0);
  });
});
