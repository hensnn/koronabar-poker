import { accounts } from '@kb/ledger';
import { schema, type Db } from './db/index.js';

let nextId = 9_000_000;

/**
 * Test helper: writes one game movement of a player straight into the stored ledger at a chosen time (the real ledger takes the time
 * from the clock and cannot go back). The statistics read exactly these stored movements, so they see it like any other.
 */
export async function bookGame(db: Db, o: { kind: string; gameId: string | null; at: number; userId: string; amount: number }): Promise<void> {
  if (o.amount === 0) return;
  const id = nextId++;
  await db.insert(schema.ledgerTransactions).values({ id, kind: o.kind, idempotencyKey: `test-book:${id}`, gameId: o.gameId, at: new Date(o.at) });
  await db.insert(schema.ledgerEntries).values([
    { transactionId: id, seq: 0, account: accounts.wallet(o.userId), amount: o.amount },
    { transactionId: id, seq: 1, account: accounts.mint(), amount: -o.amount },
  ]);
}

/** A finished tournament in the ledger: entry fee, payout and bounty of one player (the result table row is separate). */
export async function bookTournament(db: Db, o: { gameId: string; at: number; userId: string; spent: number; payout: number; bounty?: number }): Promise<void> {
  await bookGame(db, { kind: 'turnaj_buyin', gameId: o.gameId, at: o.at, userId: o.userId, amount: -o.spent });
  await bookGame(db, { kind: 'turnaj_vyplata', gameId: o.gameId, at: o.at, userId: o.userId, amount: o.payout });
  await bookGame(db, { kind: 'bounty', gameId: o.gameId, at: o.at, userId: o.userId, amount: o.bounty ?? 0 });
}
