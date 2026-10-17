/**
 * Účetní kniha s dvojím zápisem. Částky jsou celá čísla (nejmenší jednotka měny).
 * Každá transakce má součet záznamů přesně 0, takže nic nevznikne ani nezmizí.
 * Jediným zdrojem nově vydané měny je účet `mint` (vyžaduje oprávnění a audit na vyšší vrstvě).
 *
 * Turnajové žetony do této knihy nepatří (mají vlastní evidenci), aby je nešlo smíchat s měnou.
 */

export type AccountId = string;

export const accounts = {
  wallet: (userId: string) => `wallet:${userId}`,
  table: (tableId: string) => `table:${tableId}`,
  house: () => 'house',
  mint: () => 'mint',
  fund: (id: string) => `fund:${id}`,
  escrow: (id: string) => `escrow:${id}`,
  /** Prize pool turnaje (po výplatách musí být nulový). */
  tournament: (id: string) => `tournament:${id}`,
  /** Bounty turnaje: odměny za vyřazení a hlavy hráčů (po skončení turnaje nulový). */
  bounty: (id: string) => `bounty:${id}`,
} as const;

export type EntryKind =
  | 'mint'
  | 'cash_buyin'
  | 'cash_topup'
  | 'cash_cashout'
  | 'cash_return'
  | 'rake'
  | 'jackpot_payout'
  | 'rakeback'
  | 'time_charge'
  | 'turnaj_buyin'
  | 'turnaj_rebuy'
  | 'turnaj_addon'
  | 'turnaj_fee'
  | 'turnaj_vyplata'
  | 'turnaj_refund'
  | 'turnaj_overlay'
  | 'bounty'
  | 'bet_stake'
  | 'bet_payout'
  | 'bet_refund'
  | 'bet_fee'
  | 'head_bounty_post'
  | 'head_bounty_payout'
  | 'head_bounty_return'
  | 'head_bounty_house'
  | 'shop_purchase'
  | 'manual_adjustment';

export interface Entry {
  account: AccountId;
  /** Kladné = připsat na účet, záporné = odepsat. */
  amount: number;
}

export interface TxRequest {
  kind: EntryKind;
  /** Klíč proti dvojímu provedení (opakované volání vrátí původní transakci). */
  idempotencyKey: string;
  entries: Entry[];
  gameId?: string;
  note?: string;
  createdBy?: string;
}

export interface Tx extends TxRequest {
  id: number;
  at: number;
}

export class LedgerError extends Error {
  constructor(
    public readonly code:
      | 'NOT_INTEGER'
      | 'NOT_BALANCED'
      | 'EMPTY'
      | 'INSUFFICIENT_FUNDS'
      | 'BAD_ACCOUNT'
      | 'KEY_REUSED'
      | 'LIMIT_REACHED',
    message?: string,
  ) {
    super(message ? `${code}: ${message}` : code);
  }
}

/** Pravidla zůstatků: peněženka smí do mínusu jen do limitu, `mint` je neomezený, ostatní nesmí do mínusu. */
/** Transakci zamítl hlídač (osobní limity hráče). */
export class LedgerGuardError extends LedgerError {
  constructor(public readonly params: Record<string, unknown>) {
    super('LIMIT_REACHED');
  }
}

export interface LedgerPolicy {
  negativeBalanceLimit: number;
}

export interface LedgerStore {
  /** Atomicky provede `fn` nad stavem; při výjimce se nic nezapíše. */
  atomic<T>(fn: (s: MutableState) => T): T;
  balance(account: AccountId): number;
  transactions(): readonly Tx[];
  hasKey(idempotencyKey: string): boolean;
}

export interface MutableState {
  balance(account: AccountId): number;
  setBalance(account: AccountId, value: number): void;
  find(idempotencyKey: string): Tx | undefined;
  append(tx: Omit<Tx, 'id'>): Tx;
}

/** Počáteční stav načtený z databáze při startu serveru. */
export interface LedgerSnapshot {
  balances: Map<AccountId, number>;
  /** Všechny dosud použité idempotenční klíče. */
  keys: Iterable<string>;
  /** Id poslední transakce. */
  lastTxId: number;
}

export class MemoryLedgerStore implements LedgerStore {
  private balances = new Map<AccountId, number>();
  private txs: Tx[] = [];
  private byKey = new Map<string, Tx>();
  private knownKeys = new Set<string>();
  private idOffset = 0;

  constructor(initial?: LedgerSnapshot) {
    if (initial) {
      this.balances = new Map(initial.balances);
      this.knownKeys = new Set(initial.keys);
      this.idOffset = initial.lastTxId;
    }
  }

  atomic<T>(fn: (s: MutableState) => T): T {
    const balances = new Map(this.balances);
    const txs = [...this.txs];
    const byKey = new Map(this.byKey);
    const state: MutableState = {
      balance: (a) => balances.get(a) ?? 0,
      setBalance: (a, v) => void balances.set(a, v),
      find: (k) => byKey.get(k) ?? (this.knownKeys.has(k) ? LOADED_TX : undefined),
      append: (t) => {
        const tx = { ...t, id: this.idOffset + txs.length + 1 };
        txs.push(tx);
        byKey.set(tx.idempotencyKey, tx);
        return tx;
      },
    };
    const result = fn(state);
    this.balances = balances;
    this.txs = txs;
    this.byKey = byKey;
    return result;
  }
  balance(a: AccountId): number {
    return this.balances.get(a) ?? 0;
  }
  transactions(): readonly Tx[] {
    return this.txs;
  }
  hasKey(k: string): boolean {
    return this.byKey.has(k) || this.knownKeys.has(k);
  }
}

/** Zástupná hodnota pro transakci načtenou z DB při startu (známe jen její klíč). */
const LOADED_TX: Tx = { id: 0, at: 0, kind: 'mint', idempotencyKey: '', entries: [] };

export class Ledger {
  constructor(
    private store: LedgerStore = new MemoryLedgerStore(),
    private policy: LedgerPolicy = { negativeBalanceLimit: 0 },
    private now: () => number = Date.now,
    /** Zavolá se synchronně po každé nové (ne opakované) transakci; slouží k zápisu do DB. */
    private onCommit?: (tx: Tx) => void,
  ) {}

  private guardFn: ((req: TxRequest) => void) | null = null;
  private listeners: ((tx: Tx) => void)[] = [];

  setPolicy(p: LedgerPolicy) {
    this.policy = p;
  }

  /** Hlídač se volá před každou novou transakcí a smí ji zamítnout výjimkou. */
  setGuard(fn: ((req: TxRequest) => void) | null) {
    this.guardFn = fn;
  }

  /** Posluchač dostane každou nově zapsanou transakci. */
  addListener(fn: (tx: Tx) => void) {
    this.listeners.push(fn);
  }

  balance(account: AccountId): number {
    return this.store.balance(account);
  }
  transactions(): readonly Tx[] {
    return this.store.transactions();
  }
  hasKey(key: string): boolean {
    return this.store.hasKey(key);
  }

  /** Provede transakci. Opakované volání se stejným klíčem a stejným obsahem vrátí původní výsledek. */
  post(req: TxRequest): Tx {
    let created = false;
    const tx = this.store.atomic((s) => {
      const existing = s.find(req.idempotencyKey);
      if (existing) {
        // Transakce načtená z DB při startu nemá záznamy; klíč už byl použit, nic se neprovádí.
        if (existing !== LOADED_TX && JSON.stringify(existing.entries) !== JSON.stringify(req.entries)) throw new LedgerError('KEY_REUSED');
        return existing;
      }
      if (req.entries.length < 2) throw new LedgerError('EMPTY');
      this.guardFn?.(req);
      let sum = 0;
      for (const e of req.entries) {
        if (!Number.isSafeInteger(e.amount)) throw new LedgerError('NOT_INTEGER');
        if (!e.account) throw new LedgerError('BAD_ACCOUNT');
        sum += e.amount;
      }
      if (sum !== 0) throw new LedgerError('NOT_BALANCED', `Součet záznamů je ${sum}, musí být 0`);
      // Sloučení záznamů na stejném účtu, aby se zůstatek kontroloval až po celé transakci.
      const delta = new Map<AccountId, number>();
      for (const e of req.entries) delta.set(e.account, (delta.get(e.account) ?? 0) + e.amount);
      for (const [account, d] of delta) {
        const next = s.balance(account) + d;
        if (account !== accounts.mint() && next < this.floor(account)) {
          throw new LedgerError('INSUFFICIENT_FUNDS', `Účet ${account} by klesl na ${next}`);
        }
        s.setBalance(account, next);
      }
      created = true;
      return s.append({ ...req, at: this.now() });
    });
    if (created) {
      this.onCommit?.(tx);
      for (const l of this.listeners) l(tx);
    }
    return tx;
  }

  private floor(account: AccountId): number {
    return account.startsWith('wallet:') ? -this.policy.negativeBalanceLimit : 0;
  }

  /** Kontrola invariantu: součet všech účtů včetně `mint` je 0. */
  totalIsZero(accountIds: AccountId[]): boolean {
    return accountIds.reduce((n, a) => n + this.balance(a), 0) === 0;
  }
}
