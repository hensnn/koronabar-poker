import type { SettingValues } from '@kb/shared';
import type { DealPlan, SeatOptions } from '../adapter.js';
import type { HandState, PlayerAction } from '../types.js';

/** Hráč u stolu tak, jak ho vidí moduly. */
export interface ModuleSeat {
  userId: string;
  seat: number;
  chips: number;
  /** Nový (nebo vrátivší se) hráč, na kterého se vztahuje pravidlo pro nové hráče. */
  fresh: boolean;
  /** Hráč si vyžádal dobrovolný straddle. */
  wantsStraddle: boolean;
}

export interface ModuleContext {
  settings: SettingValues;
  handNumber: number;
  seats: readonly ModuleSeat[];
}

/**
 * Háčky do průběhu handy. Modul smí měnit jen to, co mu háček výslovně dovoluje
 * (plán rozdání, možnosti usazení). Stav handy (`HandState`) je jen ke čtení a obsahuje
 * i skrytá data, proto se nikdy nepředává klientovi.
 */
export interface ModuleHooks {
  /** Před rozdáním: doplní plán (straddle, mrtvé peníze). */
  beforeDeal?(ctx: ModuleContext, plan: DealPlan): void;
  /** Při usazení hráče do enginu pro další handu. */
  seatOptions?(ctx: ModuleContext, seat: ModuleSeat): SeatOptions | void;
  onHandStart?(ctx: ModuleContext, hand: HandState): void;
  afterAction?(ctx: ModuleContext, hand: HandState, info: { userId: string; action: PlayerAction['type']; auto: boolean }): void;
  /** Handa skončila showdownem, ještě před odhalením karet. */
  onShowdown?(ctx: ModuleContext, hand: HandState): void;
  /** Pot byl rozdělen (výherci známí). */
  afterPotAwarded?(ctx: ModuleContext, hand: HandState): void;
  onHandEnd?(ctx: ModuleContext, hand: HandState): void;
  onPlayerBusted?(ctx: ModuleContext, seat: ModuleSeat): void;
}

export type HookName = keyof ModuleHooks;

export interface GameModule {
  /** Jednoznačné id, např. `straddle`. */
  id: string;
  /** Překladový klíč názvu modulu. */
  titleKey: string;
  /** Moduly, které musí být registrované (pořadí řeší priorita). */
  dependsOn?: string[];
  /** Menší číslo = dřív. */
  priority: number;
  /** Klíče nastavení, které modul používá (musí existovat v centrálním schématu). */
  settingKeys: string[];
  /** Zda je modul pro dané nastavení aktivní. */
  isEnabled(settings: SettingValues): boolean;
  hooks: ModuleHooks;
}
