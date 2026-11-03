// Opravy z auditu 2. 11. 2026: kontokorent kryje celý chybějící rozdíl, vrácení čerpání při selhání, zbytek žetonů při zavření stolu, paměťové úložiště.
import { describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger } from './index.js';

describe('kontokorent', () => {
  const withCredit = (limit: number) => {
    const l = new Ledger();
    const c = new CashService(l);
    l.setOverdraft((account, shortfall, req) =>
      shortfall > limit
        ? null
        : { kind: 'credit_draw', idempotencyKey: `credit:${req.idempotencyKey}`, entries: [{ account: accounts.mint(), amount: -shortfall }, { account, amount: shortfall }] },
    );
    return { l, c };
  };

  it('dolní mez peněženky je nula: čerpá se celý chybějící rozdíl', () => {
    const { l, c } = withCredit(500);
    c.mint('u1', 100, 'm1');
    c.buyIn('u1', 't1', 300, 'b1');
    expect(l.balance(accounts.wallet('u1'))).toBe(0);
    expect(l.balance(accounts.table('t1'))).toBe(300);
    const drawn = l.transactions().filter((t) => t.kind === 'credit_draw').reduce((n, t) => n + t.entries.find((e) => e.account === accounts.wallet('u1'))!.amount, 0);
    expect(drawn).toBe(200);
  });

  it('když původní pohyb selže i po čerpání, čerpání se vrátí a hráči nezůstane dluh', () => {
    const { l } = withCredit(500);
    l.post({ kind: 'mint', idempotencyKey: 'm', entries: [{ account: accounts.mint(), amount: -100 }, { account: accounts.wallet('u1'), amount: 100 }] });
    // druhý účet (dům) nemá dost: peněžence se doplní 50, ale pohyb stejně selže
    expect(() =>
      l.post({
        kind: 'manual_adjustment',
        idempotencyKey: 'x',
        entries: [
          { account: accounts.wallet('u1'), amount: -150 },
          { account: accounts.house(), amount: -10 },
          { account: accounts.wallet('u2'), amount: 160 },
        ],
      }),
    ).toThrow(/INSUFFICIENT/);
    expect(l.balance(accounts.wallet('u1'))).toBe(100);
    expect(l.balance(accounts.wallet('u2'))).toBe(0);
    const kinds = l.transactions().map((t) => t.kind);
    expect(kinds.filter((k) => k === 'credit_draw')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'credit_repay')).toHaveLength(1);
    expect(l.totalIsZero([accounts.mint(), accounts.house(), accounts.wallet('u1'), accounts.wallet('u2')])).toBe(true);
  });
});

describe('zavření stolu a paměťové úložiště', () => {
  it('zavření stolu s kurzem žetonů: zbytek připadne domu a účet stolu končí na nule', () => {
    const l = new Ledger();
    const c = new CashService(l, 10);
    c.mint('u1', 100, 'm');
    c.buyIn('u1', 't', 50, 'b');
    expect(c.cashOut('u1', 't', 495, 'o')).toBe(49);
    expect(l.balance(accounts.table('t'))).toBe(1);
    expect(c.sweepTable('t', 'sweep')).toBe(1);
    expect(l.balance(accounts.table('t'))).toBe(0);
    expect(l.balance(accounts.house())).toBe(1);
    expect(c.sweepTable('t', 'sweep2')).toBe(0);
  });

  it('neúspěšný zápis nic nezmění ani po mnoha pohybech (historie se nekopíruje)', () => {
    const l = new Ledger();
    const c = new CashService(l);
    c.mint('u1', 1000, 'm');
    for (let i = 0; i < 500; i++) c.buyIn('u1', 't', 1, `b${i}`);
    expect(() => c.buyIn('u1', 't', 10_000, 'too-much')).toThrow(/INSUFFICIENT/);
    expect(l.balance(accounts.wallet('u1'))).toBe(500);
    expect(l.transactions()).toHaveLength(501);
    expect(l.transactions().at(-1)!.id).toBe(501);
    // klíč neúspěšného pohybu zůstal volný
    c.buyIn('u1', 't', 1, 'too-much');
    expect(l.balance(accounts.wallet('u1'))).toBe(499);
  });
});
