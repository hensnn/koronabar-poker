/**
 * Kosmetické předměty: čistě vzhledové, nikdy neovlivní hru. Vzhled předmětu je vždy klíč designového tokenu
 * (barva) a pevný styl, takže katalog jde spravovat bez programování a v komponentách nejsou žádné pevné barvy.
 */

export const COSMETIC_KINDS = ['frame', 'effect', 'cardBack', 'felt', 'nameColor', 'title', 'trophy', 'soundSlots'] as const;
export type CosmeticKind = (typeof COSMETIC_KINDS)[number];

/** Klíče barevných tokenů, které smí vzhled předmětu použít. */
export const COSMETIC_COLORS = ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'danger', 'muted'] as const;
export type CosmeticColor = (typeof COSMETIC_COLORS)[number];

/** Styly podle druhu (druhy bez stylu mají jen barvu). */
export const COSMETIC_STYLES: Partial<Record<CosmeticKind, readonly string[]>> = {
  frame: ['solid', 'double', 'dashed', 'glow'],
  effect: ['glow', 'pulse', 'sparkle'],
  cardBack: ['solid', 'stripes', 'dots'],
};

export interface CosmeticLook {
  color?: CosmeticColor;
  style?: string;
  /** Ikona trofeje (jeden znak nebo emoji). */
  icon?: string;
  /** Kolik slotů pro zvuky navíc předmět přidává. */
  extra?: number;
}

/** Podmínky získání; stačí splnit kteroukoli. Prázdné = jen přidělení správcem. */
export interface CosmeticAcquire {
  /** Dosažený level. */
  level?: number;
  /** Název hodnosti (platí od jejího prvního levelu). */
  rank?: string;
  /** Klíč úspěchu. */
  achievement?: string;
  /** Umístění v uzavřené sezóně (nejlépe `place`); bez `seasonId` v kterékoli. */
  season?: { place: number; seasonId?: string };
}

export interface CosmeticInput {
  kind: CosmeticKind;
  name: string;
  description?: string;
  look: CosmeticLook;
  acquire: CosmeticAcquire;
  /** Cena v obchodě; prázdné = nelze koupit. */
  price: number | null;
  availableFrom?: number | null;
  availableUntil?: number | null;
  enabled?: boolean;
}

/** Chyba v poli, nebo null. */
export function validateCosmetic(i: Partial<CosmeticInput>): string | null {
  if (!i.kind || !(COSMETIC_KINDS as readonly string[]).includes(i.kind)) return 'kind';
  const name = i.name?.trim() ?? '';
  if (name.length < 2 || name.length > 40) return 'name';
  if ((i.description ?? '').length > 200) return 'description';
  const look = i.look ?? {};
  if (i.kind === 'soundSlots') {
    if (!Number.isInteger(look.extra) || look.extra! < 1 || look.extra! > 500) return 'extra';
  } else if (i.kind === 'trophy') {
    if (!look.icon || [...look.icon].length > 4) return 'icon';
  } else {
    if (!look.color || !(COSMETIC_COLORS as readonly string[]).includes(look.color)) return 'color';
    const styles = COSMETIC_STYLES[i.kind];
    if (styles && (!look.style || !styles.includes(look.style))) return 'style';
  }
  if (i.price != null && (!Number.isInteger(i.price) || i.price < 0 || i.price > 1_000_000_000)) return 'price';
  const a = i.acquire ?? {};
  if (a.level != null && (!Number.isInteger(a.level) || a.level < 1 || a.level > 1000)) return 'level';
  if (a.rank != null && (a.rank.length < 1 || a.rank.length > 30)) return 'rank';
  if (a.achievement != null && (a.achievement.length < 1 || a.achievement.length > 60)) return 'achievement';
  if (a.season != null && (!Number.isInteger(a.season.place) || a.season.place < 1 || a.season.place > 100)) return 'season';
  if (i.availableFrom != null && i.availableUntil != null && i.availableUntil <= i.availableFrom) return 'availableUntil';
  return null;
}

export interface BuiltinCosmetic {
  key: string;
  kind: CosmeticKind;
  look: CosmeticLook;
  acquire: CosmeticAcquire;
  price: number | null;
}

/** Vestavěná sada, aby obchod nebyl prázdný. Názvy jsou v překladech `cosmetic.item.<key>.name`. */
export const BUILTIN_COSMETICS: BuiltinCosmetic[] = [
  { key: 'frame_bronze', kind: 'frame', look: { color: 'warning', style: 'solid' }, acquire: { level: 3 }, price: null },
  { key: 'frame_silver', kind: 'frame', look: { color: 'info', style: 'double' }, acquire: { level: 10 }, price: null },
  { key: 'frame_gold', kind: 'frame', look: { color: 'accent', style: 'glow' }, acquire: {}, price: 400 },
  { key: 'frame_royal', kind: 'frame', look: { color: 'danger', style: 'double' }, acquire: { achievement: 'royal_flush' }, price: null },
  { key: 'frame_winner', kind: 'frame', look: { color: 'success', style: 'dashed' }, acquire: { achievement: 'first_tournament_win' }, price: 300 },
  { key: 'fx_glow', kind: 'effect', look: { color: 'warning', style: 'glow' }, acquire: {}, price: 250 },
  { key: 'fx_pulse', kind: 'effect', look: { color: 'primary', style: 'pulse' }, acquire: { level: 15 }, price: null },
  { key: 'fx_spark', kind: 'effect', look: { color: 'accent', style: 'sparkle' }, acquire: { achievement: 'tournament_wins_5' }, price: null },
  { key: 'back_stripes', kind: 'cardBack', look: { color: 'primary', style: 'stripes' }, acquire: {}, price: 200 },
  { key: 'back_dots', kind: 'cardBack', look: { color: 'accent', style: 'dots' }, acquire: {}, price: 200 },
  { key: 'back_shark', kind: 'cardBack', look: { color: 'danger', style: 'stripes' }, acquire: { rank: 'Žralok' }, price: null },
  { key: 'felt_sea', kind: 'felt', look: { color: 'info' }, acquire: {}, price: 350 },
  { key: 'felt_wine', kind: 'felt', look: { color: 'danger' }, acquire: {}, price: 350 },
  { key: 'name_green', kind: 'nameColor', look: { color: 'success' }, acquire: { level: 8 }, price: null },
  { key: 'name_gold', kind: 'nameColor', look: { color: 'warning' }, acquire: {}, price: 150 },
  { key: 'name_royal', kind: 'nameColor', look: { color: 'accent' }, acquire: { rank: 'Hospodský' }, price: null },
  { key: 'title_regular', kind: 'title', look: { color: 'info' }, acquire: { rank: 'Štamgast' }, price: null },
  { key: 'title_hunter', kind: 'title', look: { color: 'danger' }, acquire: { achievement: 'knockouts_10' }, price: null },
  { key: 'title_champion', kind: 'title', look: { color: 'warning' }, acquire: { achievement: 'first_tournament_win' }, price: null },
  { key: 'title_podium', kind: 'title', look: { color: 'accent' }, acquire: { season: { place: 3 } }, price: null },
  { key: 'trophy_season_gold', kind: 'trophy', look: { icon: '🥇' }, acquire: { season: { place: 1 } }, price: null },
  { key: 'trophy_season_silver', kind: 'trophy', look: { icon: '🥈' }, acquire: { season: { place: 2 } }, price: null },
  { key: 'trophy_royal', kind: 'trophy', look: { icon: '👑' }, acquire: { achievement: 'royal_flush' }, price: null },
  { key: 'trophy_hundred', kind: 'trophy', look: { icon: '💯' }, acquire: { achievement: 'hands_100' }, price: 100 },
  { key: 'slots_plus5', kind: 'soundSlots', look: { extra: 5 }, acquire: {}, price: 500 },
  { key: 'slots_plus10', kind: 'soundSlots', look: { extra: 10 }, acquire: {}, price: 1200 },
];

/** Co o hráči vidí ostatní u stolu, v chatu a v profilu. */
export interface PublicLook {
  userId: string;
  frame: { color: string; style: string } | null;
  effect: { color: string; style: string } | null;
  nameColor: string | null;
  title: { name: string; color: string } | null;
  trophies: { key: string; name: string; icon: string }[];
}
