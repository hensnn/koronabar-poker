/**
 * Okno „Moje peníze“ u stolu: výpočty bez vzhledu. Všechny částky jsou celá čísla v měně (u cash stolu v nejmenších jednotkách měny
 * jako účetní kniha), turnajové žetony se tu nikdy nepočítají jako peníze.
 */

export interface CashMoney {
  /** Kolik hráč u stolu celkem koupil (buy-in a dokoupení). */
  invested: number;
  /** Hodnota žetonů, které má právě před sebou. */
  atTable: number;
  /** Co si už od stolu odnesl (cash-out při dřívějším odchodu). */
  cashedOut: number;
  /** Čistý výsledek teď: to, co má a odnesl, minus to, co koupil. */
  net: number;
}

/** Hodnota žetonů v měně (zaokrouhlení dolů, jako při cash-outu). */
export function stackValue(chips: number, chipsPerCurrencyUnit: number): number {
  return chipsPerCurrencyUnit > 0 ? Math.floor(chips / chipsPerCurrencyUnit) : 0;
}

export function cashMoney(bought: number, cashedOut: number, atTable: number): CashMoney {
  return { invested: bought, atTable, cashedOut, net: atTable + cashedOut - bought };
}

export interface LadderRow {
  /** Umístění; `null` = mimo placená místa. */
  place: number | null;
  /** Výhra za umístění (0 mimo placená místa). */
  prize: number;
  /** Celkem v plusu nebo v mínusu: výhra a získaná bounty minus vloženo. */
  net: number;
}

/**
 * Přehled „když skončím na…“: první tři místa, poslední placené a „mimo peníze“. Víc řádků by hráče jen zahltilo.
 * `payouts` jsou placená místa podle aktuálního prize poolu (mění se s počtem hráčů a rebuy).
 */
export function payoutLadder(payouts: { place: number; amount: number }[], invested: number, bountyEarned: number): LadderRow[] {
  const paid = payouts.filter((p) => p.amount > 0).sort((a, b) => a.place - b.place);
  const row = (place: number | null, prize: number): LadderRow => ({ place, prize, net: prize + bountyEarned - invested });
  const keep = paid.length <= 4 ? paid : [...paid.slice(0, 3), paid[paid.length - 1]!];
  return [...keep.map((p) => row(p.place, p.amount)), row(null, 0)];
}

/**
 * Řádek žebříčku, ve kterém hráč právě je (podle aktuálního pořadí): přesné místo, nebo „mimo peníze“, když je hráč za posledním placeným místem.
 * Místo, které žebříček nevypisuje (např. 5. z 8 placených), se nezvýrazní; pozici hráč vidí v textu nad tabulkou.
 */
export function currentLadderRow(rows: LadderRow[], place: number | null): number {
  if (place === null) return -1;
  const exact = rows.findIndex((r) => r.place === place);
  if (exact >= 0) return exact;
  const lastPaid = Math.max(0, ...rows.map((r) => r.place ?? 0));
  return place > lastPaid ? rows.findIndex((r) => r.place === null) : -1;
}

/** Znaménko k částce pro přehled plus/mínus. */
export function signOf(n: number): '+' | '−' | '' {
  return n > 0 ? '+' : n < 0 ? '−' : '';
}
