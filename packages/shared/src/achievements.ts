/**
 * Katalog úspěchů (odznaků). Podmínka je vždy z pevné nabídky typů s číselnou hodnotou, aby správce
 * mohl přidávat vlastní úspěchy bez programování a aby se podmínky daly spolehlivě vyhodnotit na serveru.
 */

export const CONDITION_TYPES = [
  'handsPlayed',
  'showdownWins',
  'tournamentsPlayed',
  'tournamentWins',
  'knockouts',
  'knockoutsInSeries',
  'seriesParticipation',
  'streakDays',
  'biggestPot',
  'handRank',
  'longshotWin',
  'level',
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

/** Pořadí kombinací od nejslabší; `handRank` znamená „vyhrál handu kombinací aspoň této“. */
export const HAND_RANKS = ['straight', 'flush', 'fullHouse', 'quads', 'straightFlush', 'royalFlush'] as const;
export type HandRankName = (typeof HAND_RANKS)[number];

export interface Condition {
  type: ConditionType;
  /** Počet / hranice (u `handRank` se nepoužívá). */
  value: number;
  rank?: HandRankName;
}

export interface AchievementDef {
  key: string;
  name: string;
  icon: string;
  description: string;
  condition: Condition;
  xp: number;
}

export const BUILTIN_ACHIEVEMENTS: AchievementDef[] = [
  { key: 'first_hand', name: 'První handa', icon: '🃏', description: 'Odehraj svou první handu.', condition: { type: 'handsPlayed', value: 1 }, xp: 5 },
  { key: 'hands_100', name: 'Stovka hand', icon: '💯', description: 'Odehraj 100 hand.', condition: { type: 'handsPlayed', value: 100 }, xp: 20 },
  { key: 'hands_1000', name: 'Tisícovka hand', icon: '🎰', description: 'Odehraj 1000 hand.', condition: { type: 'handsPlayed', value: 1000 }, xp: 100 },
  { key: 'first_showdown', name: 'Ukaž karty', icon: '👀', description: 'Vyhraj handu na showdownu.', condition: { type: 'showdownWins', value: 1 }, xp: 5 },
  { key: 'tournaments_10', name: 'Turnajový matador', icon: '🎟️', description: 'Dohraj 10 turnajů.', condition: { type: 'tournamentsPlayed', value: 10 }, xp: 40 },
  { key: 'first_tournament_win', name: 'První vítězství', icon: '🏆', description: 'Vyhraj turnaj.', condition: { type: 'tournamentWins', value: 1 }, xp: 50 },
  { key: 'tournament_wins_5', name: 'Pětkrát vítěz', icon: '🥇', description: 'Vyhraj 5 turnajů.', condition: { type: 'tournamentWins', value: 5 }, xp: 150 },
  { key: 'knockouts_10', name: 'Lovec', icon: '🎯', description: 'Vyřaď 10 soupeřů v turnajích.', condition: { type: 'knockouts', value: 10 }, xp: 40 },
  { key: 'series_hunter', name: 'Lovec série', icon: '🏹', description: 'Vyřaď 10 soupeřů v turnajích jedné série.', condition: { type: 'knockoutsInSeries', value: 10 }, xp: 60 },
  { key: 'series_3', name: 'Ligový hráč', icon: '📅', description: 'Zúčastni se 3 sérií.', condition: { type: 'seriesParticipation', value: 3 }, xp: 30 },
  { key: 'streak_7', name: 'Týden v kuse', icon: '🔥', description: 'Hraj 7 dní po sobě.', condition: { type: 'streakDays', value: 7 }, xp: 40 },
  { key: 'big_pot', name: 'Velký pot', icon: '💰', description: 'Vyhraj v jedné cash handě aspoň 1000 v měně.', condition: { type: 'biggestPot', value: 1000 }, xp: 30 },
  { key: 'quads', name: 'Čtveřice', icon: '4️⃣', description: 'Vyhraj handu čtveřicí nebo lepší kombinací.', condition: { type: 'handRank', value: 1, rank: 'quads' }, xp: 30 },
  { key: 'straight_flush', name: 'Postupka v barvě', icon: '🌈', description: 'Vyhraj handu postupkou v barvě.', condition: { type: 'handRank', value: 1, rank: 'straightFlush' }, xp: 100 },
  { key: 'royal_flush', name: 'Royal flush', icon: '👑', description: 'Vyhraj handu royal flush.', condition: { type: 'handRank', value: 1, rank: 'royalFlush' }, xp: 200 },
  { key: 'longshot', name: 'Zázrak', icon: '🎲', description: 'Vyhraj all-in s méně než 10 % šancí.', condition: { type: 'longshotWin', value: 10 }, xp: 60 },
  { key: 'level_10', name: 'Desátý level', icon: '⭐', description: 'Dosáhni 10. levelu.', condition: { type: 'level', value: 10 }, xp: 50 },
];

export interface ConditionIssue {
  field: 'type' | 'value' | 'rank';
}

/** Zkontroluje podmínku zadanou správcem. */
export function validateCondition(c: unknown): { ok: true; condition: Condition } | { ok: false; field: ConditionIssue['field'] } {
  const o = (c ?? {}) as Partial<Condition>;
  if (!CONDITION_TYPES.includes(o.type as ConditionType)) return { ok: false, field: 'type' };
  if (o.type === 'handRank') {
    if (!HAND_RANKS.includes(o.rank as HandRankName)) return { ok: false, field: 'rank' };
    return { ok: true, condition: { type: 'handRank', value: 1, rank: o.rank } };
  }
  const value = Number(o.value);
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) return { ok: false, field: 'value' };
  return { ok: true, condition: { type: o.type as ConditionType, value } };
}

/** Nejdelší řada po sobě jdoucích dní (dny jako RRRR-MM-DD). */
export function longestStreak(days: string[]): number {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of sorted) {
    const t = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
    run = prev !== null && Math.round((t - prev) / 86_400_000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

/** Kombinace `key` (např. hand.quads) patří mezi `rank` nebo vyšší. */
export function handRankAtLeast(handKey: string | null, rank: HandRankName): boolean {
  if (!handKey) return false;
  const name = handKey.replace(/^hand\./, '');
  const map: Record<string, HandRankName> = { straight: 'straight', flush: 'flush', fullHouse: 'fullHouse', quads: 'quads', straightFlush: 'straightFlush', royalFlush: 'royalFlush' };
  const got = map[name];
  return !!got && HAND_RANKS.indexOf(got) >= HAND_RANKS.indexOf(rank);
}
