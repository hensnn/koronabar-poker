/**
 * Kategorie „kdo je v čem nejlepší“: z přehledu hráčů vybere pro každou kategorii nejlepší hráče.
 * Čistá funkce sdílená serverem a testy; klient jen kreslí hotové pořadí.
 */
export interface CategoryPlayer {
  userId: string;
  nickname: string;
  total: number;
  tournamentNet: number;
  cashNet: number;
  balance: number;
  xp: number;
  ratingTournament: number | null;
  ratingCash: number | null;
  hands: number;
  games: number;
  wins: number;
  itm: number;
  avgPlace: number | null;
  bounty: number;
}

export const CATEGORY_GROUPS = ['money', 'tournament', 'cash', 'progress'] as const;
export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

interface CategoryDef {
  id: string;
  group: CategoryGroup;
  /** `low` = nejlepší je nejnižší hodnota (např. průměrné místo). */
  best: 'high' | 'low';
  /** Hodnota hráče; null = do kategorie se nezařadí. */
  value: (p: CategoryPlayer, minGames: number) => number | null;
}

const rate = (n: number, d: number) => Math.round((n / d) * 1000) / 10;
const positive = (n: number) => (n > 0 ? n : null);

export const CATEGORY_DEFS: readonly CategoryDef[] = [
  { id: 'total', group: 'money', best: 'high', value: (p) => (p.games > 0 || p.hands > 0 ? p.total : null) },
  { id: 'tournamentNet', group: 'money', best: 'high', value: (p) => (p.games > 0 ? p.tournamentNet : null) },
  { id: 'cashNet', group: 'money', best: 'high', value: (p) => (p.hands > 0 ? p.cashNet : null) },
  { id: 'balance', group: 'money', best: 'high', value: (p) => p.balance },
  { id: 'bounty', group: 'money', best: 'high', value: (p) => positive(p.bounty) },
  { id: 'wins', group: 'tournament', best: 'high', value: (p) => positive(p.wins) },
  { id: 'winRate', group: 'tournament', best: 'high', value: (p, m) => (p.games >= Math.max(1, m) ? rate(p.wins, p.games) : null) },
  { id: 'itmRate', group: 'tournament', best: 'high', value: (p, m) => (p.games >= Math.max(1, m) ? rate(p.itm, p.games) : null) },
  { id: 'avgPlace', group: 'tournament', best: 'low', value: (p, m) => (p.games >= Math.max(1, m) && p.avgPlace !== null ? p.avgPlace : null) },
  { id: 'games', group: 'tournament', best: 'high', value: (p) => positive(p.games) },
  { id: 'hands', group: 'cash', best: 'high', value: (p) => positive(p.hands) },
  { id: 'xp', group: 'progress', best: 'high', value: (p) => positive(p.xp) },
  { id: 'ratingTournament', group: 'progress', best: 'high', value: (p) => p.ratingTournament },
  { id: 'ratingCash', group: 'progress', best: 'high', value: (p) => p.ratingCash },
];

export interface CategoryEntry {
  userId: string;
  nickname: string;
  value: number;
}
export interface CategoryResult {
  id: string;
  group: CategoryGroup;
  best: 'high' | 'low';
  entries: CategoryEntry[];
}

/** Pořadí v každé kategorii (nejvýš `top` hráčů); prázdné kategorie se vynechají. */
export function buildCategories(players: CategoryPlayer[], opts: { minGames: number; top: number }): CategoryResult[] {
  const out: CategoryResult[] = [];
  for (const def of CATEGORY_DEFS) {
    const entries = players
      .flatMap((p) => {
        const value = def.value(p, opts.minGames);
        return value === null ? [] : [{ userId: p.userId, nickname: p.nickname, value }];
      })
      .sort((a, b) => (def.best === 'high' ? b.value - a.value : a.value - b.value) || a.nickname.localeCompare(b.nickname, 'cs'))
      .slice(0, Math.max(1, opts.top));
    if (entries.length > 0) out.push({ id: def.id, group: def.group, best: def.best, entries });
  }
  return out;
}
