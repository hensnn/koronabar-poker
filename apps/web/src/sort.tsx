import { Children, isValidElement, useState, type ReactElement, type ReactNode } from 'react';
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

/** Text buňky: spojí všechny řetězce a čísla uvnitř (tlačítka a pole bez textu dají prázdný řetězec). */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

export type CellValue = { kind: 'number'; n: number } | { kind: 'text'; s: string };

/**
 * Hodnota buňky pro řazení: datum a čas (`20. 10. 2026 11:21`), číslo na začátku (`+1 250 Koron`, `35 %`, `-120`, `3,5`)
 * se řadí číselně, ostatní text česky; prázdná buňka je vždy nejmenší.
 */
export function cellValue(raw: string): CellValue {
  const text = raw.replace(/\u00a0/g, ' ').trim();
  const date = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (date) return { kind: 'number', n: new Date(Number(date[3]), Number(date[2]) - 1, Number(date[1]), Number(date[4] ?? 0), Number(date[5] ?? 0), Number(date[6] ?? 0)).getTime() };
  const num = /^([+\-−])?\s*(\d+(?:[\d\s]*\d)?)(?:[.,](\d+))?(?=\s|%|$|[^\d.,])/.exec(text);
  if (num && !/^\d+\s*[.:]\s*\d+\s*[.:]/.test(text)) {
    const value = Number(`${num[2]!.replace(/\s/g, '')}${num[3] ? `.${num[3]}` : ''}`);
    return { kind: 'number', n: num[1] === '-' || num[1] === '−' ? -value : value };
  }
  return { kind: 'text', s: text };
}

export function compareCells(a: CellValue, b: CellValue): number {
  if (a.kind === 'number' && b.kind === 'number') return a.n - b.n;
  const as = a.kind === 'text' ? a.s : String(a.n);
  const bs = b.kind === 'text' ? b.s : String(b.n);
  if (as === '' || bs === '') return as === bs ? 0 : as === '' ? -1 : 1;
  return as.localeCompare(bs, 'cs', { numeric: true });
}

/**
 * Seřadí řádky tabulky (`<tr>`) podle sloupce: čte text buněk. Vrací null, když řádky nejdou číst
 * (něco jiného než přímé `<tr>`), pak se tabulka neřadí.
 */
export function sortTableRows(children: ReactNode, col: number, dir: SortDir): ReactElement[] | null {
  const rows = Children.toArray(children);
  if (!rows.every((r): r is ReactElement => isValidElement(r) && r.type === 'tr')) return null;
  const value = (r: ReactElement): CellValue => cellValue(textOf(Children.toArray((r.props as { children?: ReactNode }).children)[col] ?? ''));
  const sign = dir === 'asc' ? 1 : -1;
  return rows.map((r, i) => ({ r, i, v: value(r) })).sort((x, y) => sign * compareCells(x.v, y.v) || x.i - y.i).map((x) => x.r);
}

/** Zda je sloupec číselný nebo datumový (první klik pak řadí sestupně, u textu vzestupně). */
export function isNumericColumn(children: ReactNode, col: number): boolean {
  const rows = Children.toArray(children).filter((r): r is ReactElement => isValidElement(r) && r.type === 'tr');
  const values = rows.map((r) => textOf(Children.toArray((r.props as { children?: ReactNode }).children)[col] ?? '').trim()).filter((v) => v !== '');
  return values.length > 0 && values.every((v) => cellValue(v).kind === 'number');
}
