import type { TableInfo } from '@kb/game-core';
import { t } from '@kb/shared';

let showSymbol = false;
/** Zobrazovat u stolu symbol měny (osobní nastavení ui.showSymbolAtTable). */
export function setTableFormat(opts: { symbol: boolean }): void {
  showSymbol = opts.symbol;
}

/** Zformátuje částku v žetonech: v měně (symbol jen když je zapnutý), nebo v big blindech. */
export function formatAmount(chips: number, info: TableInfo, inBb: boolean): string {
  if (inBb) {
    const bb = chips / info.bigBlind;
    return `${Number.isInteger(bb) ? bb : bb.toFixed(1)} BB`;
  }
  // Turnajové žetony nejsou měna: bez symbolu měny a bez kurzu; vlastní označení žetonů (table.chipLabel) má přednost.
  if (info.tournament) return `${chips} ${info.chipLabel || t('table.chipsShort')}`;
  const cur = chips / info.chipsPerCurrencyUnit;
  const d = info.currencyDecimals;
  const n = d > 0 ? (cur / 10 ** d).toFixed(d) : String(Math.round(cur));
  const label = info.chipLabel ? ` ${info.chipLabel}` : '';
  return showSymbol ? `${n} ${info.currencySymbol}${label}` : `${n}${label}`;
}

const POSTFLOP_DEFAULT = [33, 50, 75, 100];
const PREFLOP_DEFAULT = [2.5, 3, 4];

/** Rozparsuje seznam čísel oddělených čárkou (nastavení rychlých sázek). */
export function parseList(text: string, fallback: number[]): number[] {
  const out = text
    .split(',')
    .map((x) => Number(x.trim().replace(',', '.')))
    .filter((n) => Number.isFinite(n) && n > 0);
  return out.length ? out.slice(0, 8) : fallback;
}
export const quickBetDefaults = { postflop: POSTFLOP_DEFAULT, preflop: PREFLOP_DEFAULT };

/** Pozice sedadla na oválu (v procentech); vlastní místo je vždy dole. */
export function seatPosition(seat: number, viewerSeat: number | null, count: number) {
  const rel = (seat - (viewerSeat ?? 0) + count) % count;
  const angle = Math.PI / 2 + (rel * 2 * Math.PI) / count;
  return { left: 50 + 44 * Math.cos(angle), top: 50 + 40 * Math.sin(angle) };
}
