import { WIDGET_IDS, type WidgetId } from './layout';

/** Části pod stolem na telefonu (pruh času, moje kombinace, zvukové emotikony, poslední události). */
export const MID_PARTS = ['timer', 'best', 'sounds', 'events'] as const;
export type MidPart = (typeof MID_PARTS)[number];

/** Osobní nastavení, které část pod stolem zapíná. */
export const MID_FLAG: Record<MidPart, { key: string; def: boolean }> = {
  timer: { key: 'ui.mobileTimerBar', def: true },
  best: { key: 'ui.mobileBest', def: true },
  sounds: { key: 'ui.mobileSounds', def: false },
  events: { key: 'ui.mobileEvents', def: true },
};

/** Widgety v zásuvce ℹ️ na telefonu (chat má vlastní tlačítko). */
export const INFO_IDS = WIDGET_IDS.filter((w): w is Exclude<WidgetId, 'chat'> => w !== 'chat');
const INFO_DEFAULT: WidgetId[] = ['table', 'info', ...INFO_IDS.filter((w) => w !== 'table' && w !== 'info')];

export const ORDER_KEY = 'ui.mobileOrder';

export interface MobileOrder {
  info: WidgetId[];
  mid: MidPart[];
  /** Widgety, které si hráč v informacích na telefonu skryl (O hře se skrýt nedá, jsou v něm akce). */
  hidden: WidgetId[];
}

/** Uložené pořadí z osobního nastavení; neznámé položky se zahodí a chybějící (např. z novější verze) se doplní na konec ve výchozím pořadí. */
export function parseMobileOrder(raw: unknown): MobileOrder {
  let obj: Record<string, unknown> = {};
  try {
    const v = typeof raw === 'string' && raw ? JSON.parse(raw) : raw;
    if (v && typeof v === 'object') obj = v as Record<string, unknown>;
  } catch {
    obj = {};
  }
  const pick = <T extends string>(x: unknown, all: readonly T[]): T[] => {
    const have = Array.isArray(x) ? [...new Set(x.filter((v): v is T => all.includes(v as T)))] : [];
    return [...have, ...all.filter((a) => !have.includes(a))];
  };
  const hidden = Array.isArray(obj.hidden) ? [...new Set(obj.hidden.filter((v): v is WidgetId => INFO_DEFAULT.includes(v as WidgetId) && v !== 'info'))] : [];
  return { info: pick(obj.info, INFO_DEFAULT), mid: pick(obj.mid, MID_PARTS), hidden };
}

/** Posune položku v seznamu o jedno místo (`-1` nahoru, `1` dolů). */
export function moveItem<T>(list: readonly T[], item: T, dir: -1 | 1): T[] {
  const i = list.indexOf(item);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

export const serializeOrder = (o: MobileOrder): string => JSON.stringify(o);
