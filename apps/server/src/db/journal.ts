import { eq, sql } from 'drizzle-orm';
import type { Tx } from '@kb/ledger';
import { MemoryLedgerStore, type LedgerSnapshot } from '@kb/ledger';
import { schema, type Db } from './index.js';

type Trx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Op = (trx: Trx) => Promise<void>;

/**
 * Zápis do DB „write-behind“ v pořadí. Herní stav a účetní kniha žijí v paměti (jeden zapisovatel),
 * do DB se zapisují dávkově v jedné transakci. Protože se JavaScript v rámci jednoho příkazu
 * nepřerušuje, dávka vždy obsahuje celé příkazy (pohyb peněz + jemu odpovídající stav stolu),
 * takže DB je po pádu v konzistentním stavu k určitému okamžiku (poslední dávka).
 * Selže-li zápis opakovaně, zavolá se `onFatal` (server se zastaví, aby se stavy nerozešly).
 */
export class Journal {
  private pending: { label: string; op: Op }[] = [];
  private flushing: Promise<void> | null = null;
  private failed = false;

  constructor(
    private db: Db,
    private onFatal: (e: unknown) => void = (e) => {
      console.error('Zápis do databáze selhal, zastavuji server:', e);
      process.exit(1);
    },
    private retries = 3,
  ) {}

  push(label: string, op: Op): void {
    if (this.failed) throw new Error('Journal je v chybovém stavu');
    this.pending.push({ label, op });
    // Zápis proběhne po dokončení aktuálního (synchronního) příkazu.
    if (!this.flushing) this.flushing = Promise.resolve().then(() => this.run());
  }

  /** Počká na zapsání všeho, co je ve frontě. */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
  }

  private async run(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const batch = this.pending;
        this.pending = [];
        let lastError: unknown;
        for (let attempt = 0; attempt <= this.retries; attempt++) {
          try {
            await this.db.transaction(async (trx) => {
              for (const item of batch) await item.op(trx);
            });
            lastError = undefined;
            break;
          } catch (e) {
            lastError = e;
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          }
        }
        if (lastError) {
          this.failed = true;
          this.onFatal(lastError);
          return;
        }
      }
    } finally {
      this.flushing = null;
      if (this.pending.length > 0 && !this.failed) this.flushing = Promise.resolve().then(() => this.run());
    }
  }
}

/** Zápis jedné transakce účetní knihy včetně změn zůstatků. */
export function ledgerTxOp(tx: Tx): Op {
  return async (trx) => {
    await trx.insert(schema.ledgerTransactions).values({
      id: tx.id,
      kind: tx.kind,
      idempotencyKey: tx.idempotencyKey,
      gameId: tx.gameId ?? null,
      note: tx.note ?? null,
      createdBy: tx.createdBy ?? null,
      at: new Date(tx.at),
    });
    await trx.insert(schema.ledgerEntries).values(tx.entries.map((e, i) => ({ transactionId: tx.id, seq: i, account: e.account, amount: e.amount })));
    const delta = new Map<string, number>();
    for (const e of tx.entries) delta.set(e.account, (delta.get(e.account) ?? 0) + e.amount);
    for (const [account, d] of delta) {
      await trx
        .insert(schema.ledgerAccounts)
        .values({ id: account, balance: d })
        .onConflictDoUpdate({ target: schema.ledgerAccounts.id, set: { balance: sql`${schema.ledgerAccounts.balance} + ${d}` } });
    }
  };
}

/** Uložení stavu stolu (poslední předěl mezi handami). */
export function tableStateOp(tableId: string, snapshot: unknown): Op {
  const json = JSON.parse(JSON.stringify(snapshot));
  return async (trx) => {
    await trx
      .insert(schema.tableState)
      .values({ tableId, snapshot: json })
      .onConflictDoUpdate({ target: schema.tableState.tableId, set: { snapshot: json, updatedAt: new Date() } });
  };
}

export function tournamentStateOp(id: string, status: string, state: unknown): Op {
  const json = JSON.parse(JSON.stringify(state));
  return async (trx) => {
    await trx.update(schema.tournaments).set({ state: json, status }).where(eq(schema.tournaments.id, id));
  };
}

export async function loadLedger(db: Db): Promise<LedgerSnapshot> {
  const accounts = await db.select().from(schema.ledgerAccounts);
  const keys = await db.select({ key: schema.ledgerTransactions.idempotencyKey }).from(schema.ledgerTransactions);
  const [last] = await db.select({ id: sql<number>`coalesce(max(${schema.ledgerTransactions.id}), 0)::int` }).from(schema.ledgerTransactions);
  return {
    balances: new Map(accounts.map((a) => [a.id, a.balance])),
    keys: keys.map((k) => k.key),
    lastTxId: last?.id ?? 0,
  };
}

export async function openLedgerStore(db: Db): Promise<MemoryLedgerStore> {
  return new MemoryLedgerStore(await loadLedger(db));
}

export async function loadTableState(db: Db, tableId: string): Promise<unknown | undefined> {
  const [row] = await db.select().from(schema.tableState).where(eq(schema.tableState.tableId, tableId));
  return row?.snapshot;
}
