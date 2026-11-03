/**
 * Widgety u stolu na telefonu. Každý je právě v jednom místě: pod stolem (pás nad ovládacím panelem, který je pevně dole),
 * v informacích (zásuvka ℹ️) nebo skrytý. Pořadí v místě je pořadí v seznamu. Ukládá se jako osobní nastavení `ui.mobileOrder`.
 */
export const MOBILE_WIDGETS = ['timer', 'best', 'sounds', 'events', 'players', 'table', 'bounties', 'info'] as const;
export type MobileWidget = (typeof MOBILE_WIDGETS)[number];
export type Zone = 'mid' | 'info' | 'hidden';

export const ORDER_KEY = 'ui.mobileOrder';

/** Starší samostatná zaškrtávátka; dnes slouží jen k výchozímu rozmístění, dokud si hráč neuloží vlastní. */
const LEGACY_FLAG: Partial<Record<MobileWidget, { key: string; def: boolean }>> = {
  timer: { key: 'ui.mobileTimerBar', def: true },
  best: { key: 'ui.mobileBest', def: true },
  sounds: { key: 'ui.mobileSounds', def: false },
  events: { key: 'ui.mobileEvents', def: true },
};

export interface MobileOrder {
  mid: MobileWidget[];
  info: MobileWidget[];
  hidden: MobileWidget[];
}

/** Kam může widget patřit: pruh času jen pod stůl nebo pryč, O hře (akce) jen do informací. */
export function allowedZones(id: MobileWidget): Zone[] {
  return id === 'info' ? ['info'] : id === 'timer' ? ['mid', 'hidden'] : ['mid', 'info', 'hidden'];
}

const INFO_FIRST: MobileWidget[] = ['table', 'info', 'players', 'best', 'events', 'sounds', 'bounties'];

/** Výchozí rozmístění: pod stolem to, co starší zaškrtávátka zapínala (pruh času, kombinace, události), ostatní v informacích. */
export function defaultOrder(values: Record<string, unknown> = {}): MobileOrder {
  const on = (id: 'timer' | 'best' | 'sounds' | 'events'): boolean => {
    const f = LEGACY_FLAG[id];
    return !!f && (f.def ? values[f.key] !== false : values[f.key] === true);
  };
  const mid = (['timer', 'best', 'sounds', 'events'] as const).filter(on);
  const hidden: MobileWidget[] = on('timer') ? [] : ['timer'];
  const info = INFO_FIRST.filter((id) => !(mid as MobileWidget[]).includes(id));
  return { mid, info, hidden };
}

/**
 * Uložené rozmístění; neznámé a nepřípustné položky se zahodí, chybějící (např. z novější verze) se doplní do výchozího místa.
 * Bez uložené hodnoty platí výchozí rozmístění podle starších zaškrtávátek.
 */
export function parseMobileOrder(raw: unknown, values: Record<string, unknown> = {}): MobileOrder {
  const def = defaultOrder(values);
  let obj: Record<string, unknown> | null = null;
  try {
    const v = typeof raw === 'string' && raw ? JSON.parse(raw) : raw;
    if (v && typeof v === 'object' && (v as Record<string, unknown>).v === 2) obj = v as Record<string, unknown>;
  } catch {
    obj = null;
  }
  if (!obj) return def;
  const seen = new Set<MobileWidget>();
  const take = (zone: Zone): MobileWidget[] => {
    const list = Array.isArray(obj![zone]) ? (obj![zone] as unknown[]) : [];
    const out: MobileWidget[] = [];
    for (const x of list) {
      const id = x as MobileWidget;
      if (!MOBILE_WIDGETS.includes(id) || seen.has(id) || !allowedZones(id).includes(zone)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  const out: MobileOrder = { mid: take('mid'), info: take('info'), hidden: take('hidden') };
  for (const zone of ['mid', 'info', 'hidden'] as const) {
    for (const id of def[zone]) if (!seen.has(id)) { seen.add(id); out[zone].push(id); }
  }
  for (const id of MOBILE_WIDGETS) if (!seen.has(id)) out[allowedZones(id)[0] === 'mid' ? 'hidden' : 'info'].push(id);
  return out;
}

export const serializeOrder = (o: MobileOrder): string => JSON.stringify({ v: 2, ...o });

/** Posune položku v seznamu o jedno místo (`-1` nahoru, `1` dolů). */
export function moveItem<T>(list: readonly T[], item: T, dir: -1 | 1): T[] {
  const i = list.indexOf(item);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** Přesune widget do jiného místa (na konec jeho seznamu); nepřípustné místo ignoruje. */
export function moveToZone(order: MobileOrder, id: MobileWidget, zone: Zone): MobileOrder {
  if (!allowedZones(id).includes(zone)) return order;
  const strip = (l: MobileWidget[]) => l.filter((x) => x !== id);
  return { mid: strip(order.mid), info: strip(order.info), hidden: strip(order.hidden), [zone]: [...strip(order[zone]), id] } as MobileOrder;
}

export const zoneOf = (order: MobileOrder, id: MobileWidget): Zone => (order.mid.includes(id) ? 'mid' : order.info.includes(id) ? 'info' : 'hidden');
