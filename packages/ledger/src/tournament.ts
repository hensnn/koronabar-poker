import { accounts, Ledger } from './ledger.js';

export type TournamentPayment = 'turnaj_buyin' | 'turnaj_rebuy' | 'turnaj_addon';

export interface PaymentSplit {
  /** Částka vstupu (bez poplatku). */
  cost: number;
  /** Poplatek navíc, jde celý domu. */
  fee: number;
  /** Část vstupu pro dům (odvod). */
  house?: number;
  /** Část vstupu do fondu. */
  fund?: number;
  fundId?: string;
  /** Část vstupu do bounty (účet bounty turnaje). */
  bounty?: number;
  /** Při refundu: kolik z bounty části se skutečně vrací (zbytek už byl vyplacen za vyřazení). */
  bountyRefund?: number;
}

/**
 * Peníze turnaje. Hráč platí z peněženky: z `cost` jde `house` domu a `fund` do fondu, zbytek do prize poolu
 * (účet turnaje), `fee` navíc na účet domu. Turnajové žetony se v knize nikdy neevidují.
 */
export class TournamentMoney {
  constructor(private ledger: Ledger) {}

  pay(tournamentId: string, userId: string, kind: TournamentPayment, split: PaymentSplit, key: string, createdBy?: string): void {
    const { cost, fee, house = 0, fund = 0, bounty = 0 } = split;
    if (cost < 0 || fee < 0 || house < 0 || fund < 0 || bounty < 0 || house + fund + bounty > cost || cost + fee <= 0) throw new Error('Neplatná částka');
    const pool = cost - house - fund - bounty;
    const entries = [{ account: accounts.wallet(userId), amount: -(cost + fee) }];
    if (pool > 0) entries.push({ account: accounts.tournament(tournamentId), amount: pool });
    if (bounty > 0) entries.push({ account: accounts.bounty(tournamentId), amount: bounty });
    if (fee + house > 0) entries.push({ account: accounts.house(), amount: fee + house });
    if (fund > 0) entries.push({ account: accounts.fund(split.fundId ?? 'sezona'), amount: fund });
    this.ledger.post({ kind, idempotencyKey: key, gameId: tournamentId, entries, createdBy, note: fee + house + fund > 0 ? `poplatek ${fee}, odvod domu ${house}, fond ${fund}` : undefined });
  }

  /** Vrácení jedné platby (odhlášení před startem, zrušení turnaje) přesně v tom rozdělení, v jakém proběhla. */
  refund(tournamentId: string, userId: string, split: PaymentSplit, key: string): void {
    const { cost, fee, house = 0, fund = 0, bounty = 0 } = split;
    if (cost + fee <= 0) return;
    const pool = cost - house - fund - bounty;
    const back = Math.min(bounty, split.bountyRefund ?? bounty);
    // Bounty, která už byla vyplacena za vyřazení, se nevrací; hráč dostane zpět zbytek vstupu.
    const entries = [{ account: accounts.wallet(userId), amount: cost + fee - bounty + back }];
    if (pool > 0) entries.push({ account: accounts.tournament(tournamentId), amount: -pool });
    if (back > 0) entries.push({ account: accounts.bounty(tournamentId), amount: -back });
    // Dům a fond vrací, co mají. Pokud už peníze utratily (výdaje domu), hráč přesto dostane vše zpět a rozdíl se vydá jako nová měna
    // (virtuální, bez hodnoty), aby zrušení nikdy neselhalo a kniha zůstala vyrovnaná.
    let minted = 0;
    const give = (account: string, amount: number) => {
      if (amount <= 0) return;
      const take = Math.min(amount, Math.max(0, this.ledger.balance(account)));
      if (take > 0) entries.push({ account, amount: -take });
      minted += amount - take;
    };
    give(accounts.house(), fee + house);
    give(accounts.fund(split.fundId ?? 'sezona'), fund);
    if (minted > 0) entries.push({ account: accounts.mint(), amount: -minted });
    this.ledger.post({ kind: 'turnaj_refund', idempotencyKey: key, gameId: tournamentId, entries, note: minted > 0 ? 'dům nebo fond už peníze utratil, rozdíl vydán jako nová měna' : undefined });
  }

  /**
   * Garance: chybějící část prize poolu doplní dům (kolik má na účtu), zbytek se vydá jako nová měna
   * (zůstává v knize a v přehledu pokladníka jako doplatek garance).
   */
  overlay(tournamentId: string, amount: number, key: string): { fromHouse: number; minted: number } {
    if (amount <= 0) return { fromHouse: 0, minted: 0 };
    const fromHouse = Math.min(this.ledger.balance(accounts.house()), amount);
    const minted = amount - fromHouse;
    const entries = [{ account: accounts.tournament(tournamentId), amount }];
    if (fromHouse > 0) entries.push({ account: accounts.house(), amount: -fromHouse });
    if (minted > 0) entries.push({ account: accounts.mint(), amount: -minted });
    this.ledger.post({ kind: 'turnaj_overlay', idempotencyKey: key, gameId: tournamentId, entries, note: 'doplatek garance' });
    return { fromHouse, minted };
  }

  /** Odměna za vyřazení (nebo zbytek bounty vítězi): z účtu bounty do peněženky. */
  bountyPay(tournamentId: string, userId: string, amount: number, key: string, note?: string): void {
    if (amount <= 0) return;
    this.ledger.post({
      kind: 'bounty',
      idempotencyKey: key,
      gameId: tournamentId,
      note,
      entries: [
        { account: accounts.bounty(tournamentId), amount: -amount },
        { account: accounts.wallet(userId), amount },
      ],
    });
  }

  bountyBank(tournamentId: string): number {
    return this.ledger.balance(accounts.bounty(tournamentId));
  }

  /**
   * Zrušení turnaje: vyplacená bounty se bere zpět od držitele (jen do výše jeho zůstatku; peněženka nejde do mínusu)
   * a vrací se na účet bounty, odkud se spolu s ostatními platbami vrátí plátcům. Vrací, kolik se podařilo získat zpět.
   */
  bountyClawback(tournamentId: string, userId: string, amount: number, key: string): number {
    const take = Math.min(amount, Math.max(0, this.ledger.balance(accounts.wallet(userId))));
    if (take <= 0) return 0;
    this.ledger.post({
      kind: 'turnaj_refund',
      idempotencyKey: key,
      gameId: tournamentId,
      entries: [
        { account: accounts.wallet(userId), amount: -take },
        { account: accounts.bounty(tournamentId), amount: take },
      ],
      note: 'zrušení turnaje: vrácení vyplacené bounty',
    });
    return take;
  }

  /** Výplata výhry z prize poolu. */
  payout(tournamentId: string, userId: string, amount: number, key: string): void {
    if (amount <= 0) return;
    this.ledger.post({
      kind: 'turnaj_vyplata',
      idempotencyKey: key,
      gameId: tournamentId,
      entries: [
        { account: accounts.tournament(tournamentId), amount: -amount },
        { account: accounts.wallet(userId), amount },
      ],
    });
  }

  /** Zbytek ze zaokrouhlení výher, který připadne domu. */
  toHouse(tournamentId: string, amount: number, key: string): void {
    if (amount <= 0) return;
    this.ledger.post({
      kind: 'turnaj_vyplata',
      idempotencyKey: key,
      gameId: tournamentId,
      entries: [
        { account: accounts.tournament(tournamentId), amount: -amount },
        { account: accounts.house(), amount },
      ],
      note: 'zbytek ze zaokrouhlení',
    });
  }

  pool(tournamentId: string): number {
    return this.ledger.balance(accounts.tournament(tournamentId));
  }
}
