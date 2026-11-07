/**
 * Finanční přehled nabídky dohody: co kdo dostane, jaký je to podíl, jak to dopadne proti ICM a co by hráč dostal bez dohody.
 * Částky počítá server, tady se jen skládají do přehledu.
 */
export interface DealFinanceInput {
  participants: { userId: string; name: string; chips: number }[];
  /** Dohodnuté částky podle hráče. */
  amounts: Record<string, number>;
  /** Část ponechaná na hru (dostane ji vítěz, který se dohraje). */
  keep: number;
  /** Dělená částka: součet výplat za první až k-té místo. */
  total: number;
  /** Výplaty za místa 1 až k (chybí u starších návrhů). */
  places?: number[];
  /** Referenční rozdělení podle ICM (chybí, když nejde spočítat). */
  fair?: Record<string, number> | null;
}

export interface DealRow {
  userId: string;
  name: string;
  chips: number;
  /** Podíl žetonů v procentech (na desetiny). */
  chipPct: number;
  amount: number;
  /** Podíl z částky, která se dělí hned (bez ponechané části), v procentech (na desetiny). */
  sharePct: number;
  /** Rozdíl proti ICM (kladný = dohoda je pro hráče výhodnější než ICM); null, když ICM nelze spočítat nebo se část ponechává na hru (částky pak nejsou srovnatelné). */
  vsFair: number | null;
}

export interface DealFinance {
  rows: DealRow[];
  /** Částka rozdělená hned (dělená částka bez ponechané části). */
  shared: number;
  keep: number;
  total: number;
  /** Co by hráč bez dohody dostal nejméně (výplata za poslední z dělených míst) a nejvíc (za první); null u starších návrhů. */
  range: { min: number; max: number } | null;
  /** Kolik z dělené částky dohoda rozdá (musí odpovídat `shared`); neshoda by znamenala chybu v datech. */
  sum: number;
}

const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export function dealFinance(i: DealFinanceInput): DealFinance {
  const chipsTotal = i.participants.reduce((n, p) => n + p.chips, 0);
  const shared = i.total - i.keep;
  const rows = i.participants
    .map((p) => {
      const amount = i.amounts[p.userId] ?? 0;
      return { userId: p.userId, name: p.name, chips: p.chips, chipPct: pct(p.chips, chipsTotal), amount, sharePct: pct(amount, shared), vsFair: i.keep === 0 && i.fair && p.userId in i.fair ? amount - i.fair[p.userId]! : null };
    })
    .sort((a, b) => b.chips - a.chips);
  const places = i.places ?? [];
  return {
    rows,
    shared,
    keep: i.keep,
    total: i.total,
    range: places.length > 0 ? { min: places[places.length - 1]!, max: places[0]! } : null,
    sum: rows.reduce((n, r) => n + r.amount, 0),
  };
}
