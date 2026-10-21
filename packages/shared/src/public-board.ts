/**
 * Veřejný přehled hráčů (statistika na sdíleném odkazu bez přihlášení). Čisté typy a funkce sdílené serverem a klientem:
 * dostupné sloupce, řazení a ověření nastavení přehledu.
 */

/** Sloupce přehledu v pevném pořadí zobrazení (pořadí a přezdívka jsou vždy). */
export const BOARD_COLUMNS = ['profit', 'cashProfit', 'tournamentProfit', 'xp', 'level', 'rating', 'games', 'wins', 'itm', 'avgPlace', 'bounty', 'cashHands', 'balance'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Sloupce s penězi: skryjí se, když přehled nemá ukazovat částky. */
export const MONEY_COLUMNS: readonly BoardColumn[] = ['profit', 'cashProfit', 'tournamentProfit', 'bounty', 'balance'];

export const BOARD_SORTS = ['profit', 'xp', 'rating', 'wins', 'games'] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

/** Vzhled veřejného přehledu: logo, pozadí, barva z motivu, barevný režim, šířka, hustota řádků, zvýraznění nejlepších a patička. */
export const BOARD_BACKGROUNDS = ['plain', 'felt', 'gradient', 'suits', 'image'] as const;
export const BOARD_TONES = ['primary', 'secondary', 'accent', 'info'] as const;
export const BOARD_MODES = ['auto', 'light', 'dark'] as const;
export const BOARD_WIDTHS = ['narrow', 'normal', 'wide', 'full'] as const;
export const BOARD_DENSITIES = ['compact', 'normal', 'comfortable'] as const;
export const BOARD_HEADERS = ['card', 'plain'] as const;

export interface BoardAppearance {
  /** Logo aplikace v záhlaví přehledu, nebo žádné. */
  logo: boolean;
  logoSizePercent: number;
  background: (typeof BOARD_BACKGROUNDS)[number];
  tone: (typeof BOARD_TONES)[number];
  /** Ztmavení obrázku pozadí (0 až 90 %); obrázek je pozadí přihlašovací stránky. */
  bgOverlayPercent: number;
  /** Barevný režim stránky: podle zařízení, vždy světlý, vždy tmavý. */
  colorMode: (typeof BOARD_MODES)[number];
  width: (typeof BOARD_WIDTHS)[number];
  density: (typeof BOARD_DENSITIES)[number];
  header: (typeof BOARD_HEADERS)[number];
  zebra: boolean;
  /** Medaile u prvních tří míst. */
  medals: boolean;
  /** Kolik nejlepších řádků je zvýrazněných (0 až 10). */
  highlightTop: number;
  showUpdated: boolean;
  footerText: string;
}

export const defaultAppearance = (): BoardAppearance => ({
  logo: true,
  logoSizePercent: 100,
  background: 'felt',
  tone: 'primary',
  bgOverlayPercent: 40,
  colorMode: 'auto',
  width: 'normal',
  density: 'normal',
  header: 'card',
  zebra: true,
  medals: true,
  highlightTop: 3,
  showUpdated: true,
  footerText: '',
});

const oneOf = <T extends string>(list: readonly T[], v: unknown, def: T): T => (list.includes(v as T) ? (v as T) : def);

/** Ověří vzhled přehledu; neplatné hodnoty nahradí výchozími. */
export function sanitizeAppearance(raw: unknown): BoardAppearance {
  const d = defaultAppearance();
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const n = (v: unknown, def: number, min: number, max: number) => {
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x))) : def;
  };
  return {
    logo: r.logo === false ? false : true,
    logoSizePercent: n(r.logoSizePercent, d.logoSizePercent, 40, 400),
    background: oneOf(BOARD_BACKGROUNDS, r.background, d.background),
    tone: oneOf(BOARD_TONES, r.tone, d.tone),
    bgOverlayPercent: n(r.bgOverlayPercent, d.bgOverlayPercent, 0, 90),
    colorMode: oneOf(BOARD_MODES, r.colorMode, d.colorMode),
    width: oneOf(BOARD_WIDTHS, r.width, d.width),
    density: oneOf(BOARD_DENSITIES, r.density, d.density),
    header: oneOf(BOARD_HEADERS, r.header, d.header),
    zebra: r.zebra === false ? false : true,
    medals: r.medals === false ? false : true,
    highlightTop: n(r.highlightTop, d.highlightTop, 0, 10),
    showUpdated: r.showUpdated === false ? false : true,
    footerText: typeof r.footerText === 'string' ? r.footerText.trim().slice(0, 200) : d.footerText,
  };
}

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
  /** Graf vývoje zisku z turnajů v čase (jen když se ukazují částky). */
  showChart: boolean;
  /** Kolik nejlepších hráčů má graf (1 až 10). */
  chartPlayers: number;
  /** Vzhled stránky přehledu. */
  appearance: BoardAppearance;
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
  showChart: true,
  chartPlayers: 5,
  appearance: defaultAppearance(),
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
    showChart: r.showChart === false ? false : true,
    chartPlayers: int(r.chartPlayers, d.chartPlayers, 1, 10),
    appearance: sanitizeAppearance(r.appearance),
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
