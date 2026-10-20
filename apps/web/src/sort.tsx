import { useState, type ReactNode } from 'react';
import { t } from '@kb/shared';

export type SortDir = 'asc' | 'desc';

/** Seřadí řádky podle hodnoty z `get`: texty česky, čísla číselně; při shodě zůstane původní pořadí. */
export function sortRows<T>(rows: readonly T[], get: (row: T) => string | number, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    return sign * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'cs'));
  });
}

/**
 * Řazení tabulky klikem na záhlaví (stejný styl jako v účetní knize): první klik řadí sestupně, druhý vzestupně, šipka ukazuje směr.
 * `getters` říká, podle čeho se který sloupec řadí; texty se řadí česky, čísla číselně.
 */
export function useSort<T, K extends string>(initial: { key: K; dir: SortDir }, getters: Record<K, (row: T) => string | number>) {
  const [sort, setSort] = useState<{ key: K; dir: SortDir }>(initial);
  const sorted = (rows: readonly T[]): T[] => sortRows(rows, getters[sort.key], sort.dir);
  const head = (key: K, label: string): ReactNode => (
    <button className="underline decoration-dotted" onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))} aria-label={t('cashier.ledger.sortBy', { col: label })}>
      {label}
      {sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
    </button>
  );
  return { sorted, head, sort };
}
