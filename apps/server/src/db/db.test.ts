import { afterEach, describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { openPglite, schema, type Database } from './index.js';
import { Journal, ledgerTxOp, loadLedger, loadTableState, openLedgerStore, tableStateOp } from './journal.js';

let database: Database | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});

async function setup() {
  database = await openPglite();
  const { db } = database;
  const journal = new Journal(db, (e) => {
    throw e;
  });
  const store = await openLedgerStore(db);
  const ledger = new Ledger(store, { negativeBalanceLimit: 0 }, Date.now, (tx) => journal.push('tx', ledgerTxOp(tx)));
  return { db, journal, ledger, cash: new CashService(ledger) };
}

describe('databáze: migrace a účetní kniha', () => {
  it('migrace vytvoří všechny tabulky', async () => {
    database = await openPglite();
    const rows = await database.db.execute(`select table_name from information_schema.tables where table_schema = 'public'`);
    const names = (rows.rows as { table_name: string }[]).map((r) => r.table_name);
    for (const t of ['users', 'sessions', 'invites', 'roles', 'role_assignments', 'audit_log', 'ledger_transactions', 'ledger_entries', 'ledger_accounts', 'table_state', 'secrets', 'settings_values']) {
      expect(names).toContain(t);
    }
  });

  it('pohyby se zapíší do DB a po „restartu“ se zůstatky načtou stejné', async () => {
    const s = await setup();
    s.cash.mint('u1', 1000, 'm1');
    s.cash.buyIn('u1', 't1', 400, 'b1');
    s.cash.cashOut('u1', 't1', 150, 'o1');
    await s.journal.flush();

    const stored = await loadLedger(s.db);
    expect(stored.balances.get(accounts.wallet('u1'))).toBe(750);
    expect(stored.balances.get(accounts.table('t1'))).toBe(250);
    expect(stored.balances.get(accounts.mint())).toBe(-1000);
    expect([...stored.keys].sort()).toEqual(['b1', 'm1', 'o1']);
    expect(stored.lastTxId).toBe(3);

    // „restart“: nová paměťová kniha ze stejné DB
    const j2 = new Journal(s.db);
    const ledger2 = new Ledger(await openLedgerStore(s.db), { negativeBalanceLimit: 0 }, Date.now, (tx) => j2.push('tx', ledgerTxOp(tx)));
    expect(ledger2.balance(accounts.wallet('u1'))).toBe(750);
    // stejný klíč po restartu se znovu neprovede
    new CashService(ledger2).buyIn('u1', 't1', 400, 'b1');
    expect(ledger2.balance(accounts.wallet('u1'))).toBe(750);
    // nová transakce naváže na číslování
    new CashService(ledger2).buyIn('u1', 't1', 50, 'b2');
    await j2.flush();
    expect((await loadLedger(s.db)).lastTxId).toBe(4);
  });

  it('součet všech účtů v DB je nula a odpovídá záznamům v knize', async () => {
    const s = await setup();
    s.cash.mint('a', 500, 'ma');
    s.cash.mint('b', 700, 'mb');
    s.cash.buyIn('a', 't', 300, 'ba');
    s.cash.buyIn('b', 't', 100, 'bb');
    s.cash.cashOut('b', 't', 40, 'ob');
    await s.journal.flush();
    const accountsRows = await s.db.select().from(schema.ledgerAccounts);
    expect(accountsRows.reduce((n, a) => n + a.balance, 0)).toBe(0);
    const entries = await s.db.select().from(schema.ledgerEntries);
    const byAccount = new Map<string, number>();
    for (const e of entries) byAccount.set(e.account, (byAccount.get(e.account) ?? 0) + e.amount);
    for (const a of accountsRows) expect(byAccount.get(a.id) ?? 0).toBe(a.balance);
  });

  it('uložení a načtení stavu stolu', async () => {
    const s = await setup();
    s.journal.push('table', tableStateOp('stul-1', { seats: [{ userId: 'u1', chips: 500 }] }));
    s.journal.push('table', tableStateOp('stul-1', { seats: [{ userId: 'u1', chips: 520 }] }));
    await s.journal.flush();
    expect(await loadTableState(s.db, 'stul-1')).toEqual({ seats: [{ userId: 'u1', chips: 520 }] });
    expect(await loadTableState(s.db, 'nic')).toBeUndefined();
  });

  it('dávka je atomická: selhání jedné operace nezapíše nic z dávky a zavolá se onFatal', async () => {
    database = await openPglite();
    const fatal: unknown[] = [];
    const journal = new Journal(database.db, (e) => void fatal.push(e), 0);
    journal.push('ok', tableStateOp('t1', { x: 1 }));
    journal.push('chyba', async (trx) => {
      await trx.execute('select nesmysl from neexistuje');
    });
    await journal.flush();
    expect(fatal).toHaveLength(1);
    expect(await loadTableState(database.db, 't1')).toBeUndefined();
    expect(() => journal.push('dalsi', tableStateOp('t2', {}))).toThrow(/chybovém/);
  });

  it('pořadí zápisů se zachová', async () => {
    const s = await setup();
    for (let i = 1; i <= 20; i++) s.journal.push('t', tableStateOp('t', { i }));
    await s.journal.flush();
    expect(await loadTableState(s.db, 't')).toEqual({ i: 20 });
  });
});
