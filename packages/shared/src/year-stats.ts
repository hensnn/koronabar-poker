/**
 * Roční statistika hráče („výdělek v roce“): výsledky her, nabité a strhnuté žetony a vývoj zůstatku za kalendářní rok.
 * Čisté typy a funkce sdílené serverem a klientem; které údaje se ukážou na webu, pošlou e-mailem a vrátí API, určuje správce.
 */

/** Údaje roční statistiky v pevném pořadí zobrazení. */
export const YEAR_FIELDS = ['net', 'tournamentNet', 'cashNet', 'liveNet', 'won', 'lost', 'topUps', 'withdrawals', 'balanceStart', 'balanceEnd', 'hands', 'tournaments', 'monthly'] as const;
export type YearField = (typeof YEAR_FIELDS)[number];

export const YEAR_CHANNELS = ['web', 'email', 'api'] as const;
export type YearChannel = (typeof YEAR_CHANNELS)[number];

/** Výchozí výběr údajů pro každý kanál (správce ho mění v Nastavení → Statistiky). */
export const YEAR_DEFAULTS: Record<YearChannel, YearField[]> = {
  web: [...YEAR_FIELDS],
  email: ['net', 'tournamentNet', 'cashNet', 'topUps', 'withdrawals', 'balanceEnd'],
  api: ['net', 'tournamentNet', 'cashNet', 'liveNet', 'won', 'lost', 'topUps', 'withdrawals', 'balanceStart', 'balanceEnd', 'hands', 'tournaments', 'monthly'],
};

/** Měsíční výsledek (index 0 = leden). */
export type MonthlyNet = number[];

export interface YearStats {
  year: number;
  /** Výdělek v roce: turnaje + cash + živý cash. */
  net: number;
  tournamentNet: number;
  cashNet: number;
  liveNet: number;
  /** Součet kladných výsledků her (turnaj, živý cash, cash po dnech) v roce. */
  won: number;
  /** Součet záporných výsledků her v roce (záporné číslo). */
  lost: number;
  /** Žetony nabité správcem do peněženky během roku. */
  topUps: number;
  /** Žetony strhnuté správcem z peněženky během roku. */
  withdrawals: number;
  balanceStart: number;
  balanceEnd: number;
  hands: number;
  tournaments: number;
  /** Výdělek po měsících (12 hodnot). */
  monthly: MonthlyNet;
}

/** Zbývá-li jen platné, vrátí seznam údajů v pevném pořadí; nesmysl nahradí výchozím výběrem kanálu. */
export function parseYearFields(raw: unknown, channel: YearChannel): YearField[] {
  const text = String(raw ?? '').trim();
  if (text === '') return [];
  const wanted = text.split(/[\s,;]+/).filter(Boolean);
  const valid = YEAR_FIELDS.filter((f) => wanted.includes(f));
  return valid.length > 0 ? valid : YEAR_DEFAULTS[channel];
}

export const serializeYearFields = (fields: readonly YearField[]): string => YEAR_FIELDS.filter((f) => fields.includes(f)).join(',');

/** Vybere z roční statistiky jen povolené údaje (rok je vždy). */
export function pickYearFields(stats: YearStats, fields: readonly YearField[]): Partial<YearStats> & { year: number } {
  const out: Record<string, unknown> = { year: stats.year };
  for (const f of fields) out[f] = stats[f];
  return out as Partial<YearStats> & { year: number };
}

/** Část dne v zadané časové zóně (offset v ms vůči UTC v daný okamžik). */
function tzOffset(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ms / 1000) * 1000;
}

/** Začátek (včetně) a konec (bez) kalendářního roku v časové zóně, v ms. */
export function yearBounds(year: number, tz: string): { from: number; to: number } {
  const start = (y: number) => {
    const guess = Date.UTC(y, 0, 1);
    return guess - tzOffset(guess - tzOffset(guess, tz), tz);
  };
  return { from: start(year), to: start(year + 1) };
}

/** Měsíc (0 až 11) okamžiku v časové zóně. */
export function monthIndex(ms: number, tz: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'numeric' }).format(new Date(ms))) - 1;
}
