/**
 * Veřejný přehled hráčů (statistika na sdíleném odkazu bez přihlášení). Čisté typy a funkce sdílené serverem a klientem:
 * dostupné sloupce, řazení a ověření nastavení přehledu.
 */

/** Sloupce přehledu v pevném pořadí zobrazení (pořadí a přezdívka jsou vždy). */
export const BOARD_COLUMNS = ['profit', 'cashProfit', 'tournamentProfit', 'xp', 'level', 'rating', 'games', 'wins', 'itm', 'avgPlace', 'bounty', 'cashHands'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Sloupce s penězi: skryjí se, když přehled nemá ukazovat částky. */
export const MONEY_COLUMNS: readonly BoardColumn[] = ['profit', 'cashProfit', 'tournamentProfit', 'bounty'];

export const BOARD_SORTS = ['profit', 'xp', 'rating', 'wins', 'games'] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

export interface PublicBoardConfig {
  /** Nadpis stránky (prázdný = název přehledu). */
  title: string;
  subtitle: string;
  columns: BoardColumn[];
  sort: BoardSort;
  /** Počet posledních dní, ze kterých se počítá zisk a statistiky; 0 = za celou dobu. */
  periodDays: number;
  /** Nejvíc řádků (0 = všichni). */
  limit: number;
  /** Hráč se ukáže, má-li aspoň tolik odehraných turnajů, nebo aspoň tolik cash hand (0 a 0 = všichni). */
  minGames: number;
  minHands: number;
  /** Jak se ukáže přezdívka: celá, nebo jen první písmeno (soukromí). */
  nameMode: 'full' | 'initial';
  showMoney: boolean;
  /** Hráči, kteří se v přehledu nikdy neukážou. */
  hiddenUserIds: string[];
  /** Jak často se stránka sama obnoví (sekundy; 0 = nikdy). */
  refreshSeconds: number;
}

export const defaultBoardConfig = (): PublicBoardConfig => ({
  title: '',
  subtitle: '',
  columns: ['profit', 'xp', 'level', 'games', 'wins'],
  sort: 'profit',
  periodDays: 0,
  limit: 20,
  minGames: 0,
  minHands: 0,
  nameMode: 'full',
  showMoney: true,
  hiddenUserIds: [],
  refreshSeconds: 60,
});

const int = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const str = (v: unknown, def: string, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : def);

/** Ověří a doplní nastavení přehledu; neznámé a nesmyslné hodnoty nahradí výchozími. Vždy vrací platnou konfiguraci. */
export function sanitizeBoardConfig(raw: unknown): PublicBoardConfig {
  const d = defaultBoardConfig();
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const wanted = Array.isArray(r.columns) ? r.columns.filter((c): c is BoardColumn => (BOARD_COLUMNS as readonly string[]).includes(String(c))) : d.columns;
  const columns = BOARD_COLUMNS.filter((c) => wanted.includes(c));
  const sort = (BOARD_SORTS as readonly string[]).includes(String(r.sort)) ? (r.sort as BoardSort) : d.sort;
  const hidden = Array.isArray(r.hiddenUserIds) ? [...new Set(r.hiddenUserIds.filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 500) : [];
  return {
    title: str(r.title, d.title, 80),
    subtitle: str(r.subtitle, d.subtitle, 200),
    columns,
    sort,
    periodDays: int(r.periodDays, d.periodDays, 0, 3650),
    limit: int(r.limit, d.limit, 0, 500),
    minGames: int(r.minGames, d.minGames, 0, 10_000),
    minHands: int(r.minHands, d.minHands, 0, 1_000_000),
    nameMode: r.nameMode === 'initial' ? 'initial' : 'full',
    showMoney: r.showMoney === false ? false : true,
    hiddenUserIds: hidden,
    refreshSeconds: int(r.refreshSeconds, d.refreshSeconds, 0, 3600),
  };
}

/** Sloupce, které se opravdu ukážou: bez peněz, když je přehled skrývá, a bez zkušeností/ratingu, když jsou vypnuté. */
export function effectiveColumns(c: PublicBoardConfig, features: { xp: boolean; rating: boolean }): BoardColumn[] {
  return c.columns.filter((col) => {
    if (!c.showMoney && MONEY_COLUMNS.includes(col)) return false;
    if (!features.xp && (col === 'xp' || col === 'level')) return false;
    if (!features.rating && col === 'rating') return false;
    return true;
  });
}

/** Přezdívka podle zvoleného režimu soukromí. */
export function boardName(nickname: string, mode: PublicBoardConfig['nameMode']): string {
  if (mode === 'full') return nickname;
  const first = [...nickname.trim()][0] ?? '?';
  return `${first.toUpperCase()}•••`;
}
