/** Kdy lze hodnotu měnit. */
export type Mutability = 'anytime' | 'betweenHands' | 'beforeStart' | 'adminOnly';

/** Vrstvy nastavení, pozdější v seznamu přepisuje dřívější. */
export const SCOPES = ['global', 'template', 'game', 'table', 'user', 'userDevice'] as const;
export type Scope = (typeof SCOPES)[number];

/** Na jaký druh hry se parametr vztahuje (pro skrývání nesmyslných polí). */
export type AppliesTo = 'cash' | 'tournament' | 'live' | 'all';

export type Dependency = { key: string; equals?: unknown; truthy?: boolean };

interface BaseDef {
  /** Jednoznačný klíč, např. `table.bigBlind`. */
  key: string;
  /** Kategorie (záložka v UI). */
  category: string;
  /** Jednotka zobrazená u pole (např. `ms`, `BB`, `%`). */
  unit?: string;
  mutability: Mutability;
  appliesTo?: AppliesTo;
  dependsOn?: Dependency;
  /** Které vrstvy smějí parametr přepsat. Výchozí: global, template, game, table. */
  scopes?: readonly Scope[];
  /** Hodnota pro „Retro“ šablony, pokud je parametr novou funkcí. */
  retroDefault?: unknown;
  /** Tajný údaj: nikdy se nevrací klientovi, neexportuje se a nelogguje. */
  secret?: boolean;
}

export interface IntDef extends BaseDef {
  type: 'int';
  default: number;
  min: number;
  max: number;
  step?: number;
}
export interface BoolDef extends BaseDef {
  type: 'bool';
  default: boolean;
}
export interface EnumDef extends BaseDef {
  type: 'enum';
  default: string;
  options: readonly string[];
}
export interface StringDef extends BaseDef {
  type: 'string';
  default: string;
  maxLength?: number;
}
export interface ColorDef extends BaseDef {
  type: 'color';
  default: string;
}

export type SettingDef = IntDef | BoolDef | EnumDef | StringDef | ColorDef;
export type SettingValue = number | boolean | string;
export type SettingValues = Record<string, SettingValue>;

/** Překladové klíče se odvozují z klíče parametru. */
export const labelKey = (key: string) => `settings.${key}.label`;
export const helpKey = (key: string) => `settings.${key}.help`;
export const categoryKey = (cat: string) => `settings.category.${cat}`;
export const optionKey = (key: string, option: string) => `settings.${key}.option.${option}`;
