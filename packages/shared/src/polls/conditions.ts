/**
 * Podmínky, kdo smí hlasovat v anketě: strom skupin „všechny / alespoň jedna“ s volitelnou negací („kromě“)
 * a listy s konkrétními podmínkami. Vyhodnocují se proti profilu hráče, který sestaví server.
 */

export const LEAF_TYPES = [
  'online',
  'atTable',
  'inTournament',
  'inChannel',
  'registered',
  'role',
  'minPower',
  'level',
  'rank',
  'division',
  'rating',
  'activity',
  'accountAge',
  'lastActive',
  'series',
  'leaderboardTop',
  'wins',
  'players',
  'balance',
] as const;
export type LeafType = (typeof LEAF_TYPES)[number];

export interface PollGroup {
  type: 'group';
  /** all = všechny podmínky zároveň (A), any = alespoň jedna (NEBO). */
  mode: 'all' | 'any';
  /** Negace celé skupiny („kromě“). */
  not?: boolean;
  children: PollCondition[];
}

export interface PollLeaf {
  type: LeafType;
  not?: boolean;
  /** Id stolu / turnaje / kanálu / série. */
  id?: string;
  /** Jen dosud nevyřazení hráči turnaje. */
  aliveOnly?: boolean;
  min?: number;
  max?: number;
  /** Klíč role, názvy hodností nebo divizí, id hráčů. */
  keys?: string[];
  scope?: 'tournament' | 'cash';
  /** Rating není provizorní. */
  notProvisional?: boolean;
  /** Aktivita: co a za jaké období. */
  metric?: 'hands' | 'games';
  period?: 'total' | 'season' | 'days';
  days?: number;
}

export type PollCondition = PollGroup | PollLeaf;

/** Fakta o hráči, proti kterým se podmínky vyhodnocují. Sestavuje je server z databáze. */
export interface PlayerProfile {
  userId: string;
  online: boolean;
  tableIds: string[];
  /** Turnaje, kterých se hráč účastní, a z nich ty, kde ještě nevypadl. */
  tournamentIds: string[];
  aliveTournamentIds: string[];
  registeredTournamentIds: string[];
  channelIds: string[];
  roleKeys: string[];
  maxPower: number;
  level: number;
  rankName: string;
  division: string;
  ratingTournament: { value: number; provisional: boolean } | null;
  ratingCash: { value: number; provisional: boolean } | null;
  accountAgeDays: number;
  daysSinceActive: number | null;
  activity: {
    handsTotal: number;
    gamesTotal: number;
    handsSeason: number;
    gamesSeason: number;
    handsInLast: (days: number) => number;
    gamesInLast: (days: number) => number;
  };
  seriesIds: string[];
  leaderboardRank: number | null;
  tournamentWins: number;
  balance: number;
}

const between = (v: number, min?: number, max?: number) => (min === undefined || v >= min) && (max === undefined || v <= max);

function leaf(l: PollLeaf, p: PlayerProfile): boolean {
  switch (l.type) {
    case 'online':
      return p.online;
    case 'atTable':
      return !!l.id && p.tableIds.includes(l.id);
    case 'inTournament':
      return !!l.id && (l.aliveOnly ? p.aliveTournamentIds : p.tournamentIds).includes(l.id);
    case 'inChannel':
      return !!l.id && p.channelIds.includes(l.id);
    case 'registered':
      return !!l.id && p.registeredTournamentIds.includes(l.id);
    case 'role':
      return (l.keys ?? []).some((k) => p.roleKeys.includes(k));
    case 'minPower':
      return p.maxPower >= (l.min ?? 0);
    case 'level':
      return between(p.level, l.min, l.max);
    case 'rank':
      return (l.keys ?? []).includes(p.rankName);
    case 'division':
      return (l.keys ?? []).includes(p.division);
    case 'rating': {
      const r = l.scope === 'cash' ? p.ratingCash : p.ratingTournament;
      if (!r) return false;
      if (l.notProvisional && r.provisional) return false;
      return between(r.value, l.min, l.max);
    }
    case 'activity': {
      const a = p.activity;
      const hands = l.metric !== 'games';
      const v = l.period === 'season' ? (hands ? a.handsSeason : a.gamesSeason) : l.period === 'days' ? (hands ? a.handsInLast(l.days ?? 30) : a.gamesInLast(l.days ?? 30)) : hands ? a.handsTotal : a.gamesTotal;
      return between(v, l.min, l.max);
    }
    case 'accountAge':
      return between(p.accountAgeDays, l.min, l.max);
    case 'lastActive':
      return p.daysSinceActive !== null && p.daysSinceActive <= (l.days ?? l.max ?? 30);
    case 'series':
      return l.id ? p.seriesIds.includes(l.id) : p.seriesIds.length > 0;
    case 'leaderboardTop':
      return p.leaderboardRank !== null && p.leaderboardRank <= (l.max ?? l.min ?? 10);
    case 'wins':
      return between(p.tournamentWins, l.min, l.max);
    case 'players':
      return (l.keys ?? []).includes(p.userId);
    case 'balance':
      return between(p.balance, l.min, l.max);
  }
}

/** Splní hráč podmínky? Prázdná skupina „všechny“ platí pro každého, prázdná „alespoň jedna“ pro nikoho. */
export function matches(node: PollCondition, p: PlayerProfile): boolean {
  let r: boolean;
  if (node.type === 'group') {
    r = node.mode === 'all' ? node.children.every((c) => matches(c, p)) : node.children.some((c) => matches(c, p));
  } else {
    r = leaf(node, p);
  }
  return node.not ? !r : r;
}

/** Hráči, kteří splňují podmínky (pro živý náhled v editoru). */
export function eligibleOf(node: PollCondition, profiles: PlayerProfile[]): PlayerProfile[] {
  return profiles.filter((p) => matches(node, p));
}

export const EVERYONE: PollCondition = { type: 'group', mode: 'all', children: [] };

const MAX_DEPTH = 6;
const MAX_NODES = 60;

export interface PollConditionIssue {
  path: string;
  reason: 'type' | 'depth' | 'size' | 'param';
}

/** Zkontroluje strom podmínek zadaný uživatelem (hloubka, velikost, parametry). */
export function validatePollCondition(root: unknown): { ok: true; condition: PollCondition } | { ok: false; issue: PollConditionIssue } {
  let count = 0;
  const num = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e9);
  const strs = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 80));
  const walk = (n: unknown, depth: number, path: string): PollConditionIssue | null => {
    if (++count > MAX_NODES) return { path, reason: 'size' };
    if (depth > MAX_DEPTH) return { path, reason: 'depth' };
    const o = n as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return { path, reason: 'type' };
    if (o.not !== undefined && typeof o.not !== 'boolean') return { path, reason: 'param' };
    if (o.type === 'group') {
      if (o.mode !== 'all' && o.mode !== 'any') return { path, reason: 'param' };
      if (!Array.isArray(o.children)) return { path, reason: 'param' };
      for (const [i, c] of o.children.entries()) {
        const bad = walk(c, depth + 1, `${path}.${i}`);
        if (bad) return bad;
      }
      return null;
    }
    if (!LEAF_TYPES.includes(o.type as LeafType)) return { path, reason: 'type' };
    if (!num(o.min) || !num(o.max) || !num(o.days) || !strs(o.keys)) return { path, reason: 'param' };
    if (o.id !== undefined && (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 80)) return { path, reason: 'param' };
    if (['atTable', 'inTournament', 'inChannel', 'registered'].includes(o.type as string) && !o.id) return { path, reason: 'param' };
    if (['role', 'rank', 'division', 'players'].includes(o.type as string) && !(Array.isArray(o.keys) && o.keys.length > 0)) return { path, reason: 'param' };
    if (o.scope !== undefined && o.scope !== 'tournament' && o.scope !== 'cash') return { path, reason: 'param' };
    if (o.metric !== undefined && o.metric !== 'hands' && o.metric !== 'games') return { path, reason: 'param' };
    if (o.period !== undefined && !['total', 'season', 'days'].includes(o.period as string)) return { path, reason: 'param' };
    if (o.aliveOnly !== undefined && typeof o.aliveOnly !== 'boolean') return { path, reason: 'param' };
    if (o.notProvisional !== undefined && typeof o.notProvisional !== 'boolean') return { path, reason: 'param' };
    return null;
  };
  const bad = walk(root, 0, 'root');
  if (bad) return { ok: false, issue: bad };
  return { ok: true, condition: root as PollCondition };
}
