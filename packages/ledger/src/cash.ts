import { accounts, Ledger, LedgerError } from './ledger.js';

/**
 * Cash žetony u stolu jsou přímo měna (kurz `chipsPerUnit`, výchozí 1 : 1).
 * Měna „na stole“ leží na účtu stolu: hráč ji nemá v peněžence, ale nepatří nikomu jinému.
 */
export class CashService {
  constructor(
    private ledger: Ledger,
    private chipsPerUnit = 1,
  ) {
    if (!Number.isInteger(chipsPerUnit) || chipsPerUnit < 1) throw new Error('Neplatný kurz žetonů');
  }

  /** Vydání měny (např. počáteční vklad nebo dobití). */
  mint(userId: string, amount: number, key: string, createdBy?: string, note?: string) {
    return this.ledger.post({
      kind: 'mint',
      idempotencyKey: key,
      entries: [
        { account: accounts.mint(), amount: -amount },
        { account: accounts.wallet(userId), amount },
      ],
      createdBy,
      note,
    });
  }

  /** Buy-in nebo top-up: z peněženky na stůl. Vrací počet žetonů; `chipsPerUnit` je kurz stolu (jinak kurz služby). */
  buyIn(userId: string, tableId: string, currencyAmount: number, key: string, kind: 'cash_buyin' | 'cash_topup' = 'cash_buyin', chipsPerUnit = this.chipsPerUnit): number {
    if (!Number.isInteger(currencyAmount) || currencyAmount <= 0) throw new LedgerError('NOT_INTEGER');
    this.ledger.post({
      kind,
      idempotencyKey: key,
      gameId: tableId,
      entries: [
        { account: accounts.wallet(userId), amount: -currencyAmount },
        { account: accounts.table(tableId), amount: currencyAmount },
      ],
    });
    return currencyAmount * chipsPerUnit;
  }

  /**
   * Cash-out: ze stolu do peněženky. Zbytek žetonů, který nejde převést na celou jednotku měny,
   * jde na účet domu (zaokrouhlení). Vrací vyplacenou měnu.
   */
  cashOut(userId: string, tableId: string, chips: number, key: string, kind: 'cash_cashout' | 'cash_return' = 'cash_cashout', chipsPerUnit = this.chipsPerUnit): number {
    if (!Number.isInteger(chips) || chips < 0) throw new LedgerError('NOT_INTEGER', String(chips));
    const currency = Math.floor(chips / chipsPerUnit);
    const remainderChips = chips - currency * chipsPerUnit;
    // Zbytek žetonů se nedá vyjádřit v měně; účetně se na stole neeviduje (viz tableCurrencyFor).
    if (currency === 0) return 0;
    this.ledger.post({
      kind,
      idempotencyKey: key,
      gameId: tableId,
      note: remainderChips ? `zaokrouhlení ${remainderChips} žetonů` : undefined,
      entries: [
        { account: accounts.table(tableId), amount: -currency },
        { account: accounts.wallet(userId), amount: currency },
      ],
    });
    return currency;
  }

  /** Rake z handy: ze stolu domu a (část) do jackpotového fondu. Částky jsou v měně. */
  rake(tableId: string, houseCurrency: number, jackpotCurrency: number, fundId: string, key: string): void {
    if (houseCurrency < 0 || jackpotCurrency < 0 || houseCurrency + jackpotCurrency <= 0) return;
    const entries = [{ account: accounts.table(tableId), amount: -(houseCurrency + jackpotCurrency) }];
    if (houseCurrency > 0) entries.push({ account: accounts.house(), amount: houseCurrency });
    if (jackpotCurrency > 0) entries.push({ account: accounts.fund(fundId), amount: jackpotCurrency });
    this.ledger.post({ kind: 'rake', idempotencyKey: key, gameId: tableId, entries });
  }

  /** Výplata jackpotu: z fondu na stůl (hráč dostane žetony). */
  jackpotPay(tableId: string, fundId: string, currency: number, key: string, note?: string): void {
    if (currency <= 0) return;
    this.ledger.post({
      kind: 'jackpot_payout',
      idempotencyKey: key,
      gameId: tableId,
      note,
      entries: [
        { account: accounts.fund(fundId), amount: -currency },
        { account: accounts.table(tableId), amount: currency },
      ],
    });
  }

  /** Rakeback: část rake se vrací hráči, který ho zaplatil (z účtu herny na stůl). */
  rakeback(tableId: string, currency: number, key: string): void {
    if (currency <= 0) return;
    this.ledger.post({
      kind: 'rakeback',
      idempotencyKey: key,
      gameId: tableId,
      entries: [
        { account: accounts.house(), amount: -currency },
        { account: accounts.table(tableId), amount: currency },
      ],
    });
  }

  /** Poplatek za čas u stolu (time charge): ze stolu domu. */
  timeCharge(tableId: string, currency: number, key: string): void {
    if (currency <= 0) return;
    this.ledger.post({
      kind: 'time_charge',
      idempotencyKey: key,
      gameId: tableId,
      entries: [
        { account: accounts.table(tableId), amount: -currency },
        { account: accounts.house(), amount: currency },
      ],
    });
  }

  /** Výplata jackpotu hráči, který už u stolu nesedí: přímo do peněženky. */
  jackpotToWallet(userId: string, fundId: string, currency: number, key: string, tableId?: string): void {
    if (currency <= 0) return;
    this.ledger.post({
      kind: 'jackpot_payout',
      idempotencyKey: key,
      gameId: tableId,
      entries: [
        { account: accounts.fund(fundId), amount: -currency },
        { account: accounts.wallet(userId), amount: currency },
      ],
    });
  }

  fundBalance(fundId: string): number {
    return this.ledger.balance(accounts.fund(fundId));
  }

  /** Měna, která má podle zůstatku účtu ležet u stolu. */
  tableBalance(tableId: string): number {
    return this.ledger.balance(accounts.table(tableId));
  }
}
