/**
 * Widgety u stolu na telefonu. Stůl s pevným ovládacím panelem je obrazovka 1; další obrazovky (2 a 3) se listují prstem doleva a doprava.
 * Každý widget je právě na jednom místě: pod stolem (pás na obrazovce 1), na obrazovce 2 nebo 3, jako ikona nahoře (otevře se po klepnutí)
 * nebo skrytý. Kolik obrazovek se používá, si hráč volí. Ukládá se jako osobní nastavení `ui.mobileOrder`.
 */
export const MOBILE_WIDGETS = ['timer', 'best', 'sounds', 'events', 'players', 'table', 'bounties', 'info', 'chat'] as const;
export type MobileWidget = (typeof MOBILE_WIDGETS)[number];
export const ZONES = ['s1', 's2', 's3', 'icon', 'hidden'] as const;
export type Zone = (typeof ZONES)[number];

export const ORDER_KEY = 'ui.mobileOrder';

/** Starší samostatná zaškrtávátka; dnes slouží jen k výchozímu rozmístění, dokud si hráč neuloží vlastní. */
const LEGACY_FLAG: Partial<Record<MobileWidget, { key: string; def: boolean }>> = {
  timer: { key: 'ui.mobileTimerBar', def: true },
  best: { key: 'ui.mobileBest', def: true },
  sounds: { key: 'ui.mobileSounds', def: false },
  events: { key: 'ui.mobileEvents', def: true },
};

export interface MobileOrder {
  /** Kolik obrazovek se používá (1 až 3). */
  screens: 1 | 2 | 3;
  s1: MobileWidget[];
  s2: MobileWidget[];
  s3: MobileWidget[];
  icon: MobileWidget[];
  hidden: MobileWidget[];
}

/** Kam může widget patřit: pruh času jen pod stůl nebo pryč; O hře (akce) a chat ne pod stůl; O hře se nedá skrýt. */
export function allowedZones(id: MobileWidget): Zone[] {
  if (id === 'timer') return ['s1', 'hidden'];
  if (id === 'info') return ['s2', 's3', 'icon'];
  if (id === 'chat') return ['s2', 's3', 'icon', 'hidden'];
  return [...ZONES];
}

/** Výchozí rozmístění: pod stolem to, co starší zaškrtávátka zapínala (pruh času, kombinace, události); informace na obrazovce 2, chat na 3. */
export function defaultOrder(values: Record<string, unknown> = {}): MobileOrder {
  const on = (id: 'timer' | 'best' | 'sounds' | 'events'): boolean => {
    const f = LEGACY_FLAG[id]!;
    return f.def ? values[f.key] !== false : values[f.key] === true;
  };
  const s1 = (['timer', 'best', 'sounds', 'events'] as const).filter(on) as MobileWidget[];
  const s2 = (['table', 'info', 'players', 'best', 'events', 'sounds', 'bounties'] as const).filter((id) => !s1.includes(id));
  return { screens: 3, s1, s2, s3: ['chat'], icon: [], hidden: on('timer') ? [] : ['timer'] };
}

/**
 * Uložené rozmístění; neznámé a nepřípustné položky se zahodí, chybějící (např. z novější verze) se doplní do výchozího místa.
 * Starší verze 2 (pod stolem / informace / skryté) se převede. Bez uložené hodnoty platí výchozí rozmístění.
 */
export function parseMobileOrder(raw: unknown, values: Record<string, unknown> = {}): MobileOrder {
  const def = defaultOrder(values);
  let obj: Record<string, unknown> | null = null;
  try {
    const v = typeof raw === 'string' && raw ? JSON.parse(raw) : raw;
    if (v && typeof v === 'object') obj = v as Record<string, unknown>;
  } catch {
    obj = null;
  }
  if (!obj || (obj.v !== 2 && obj.v !== 3)) return def;
  // verze 2: pod stolem → obrazovka 1, informace → obrazovka 2, chat na obrazovku 3
  const src: Record<string, unknown> = obj.v === 2 ? { s1: obj.mid, s2: obj.info, hidden: obj.hidden, screens: 3 } : obj;
  const seen = new Set<MobileWidget>();
  const take = (zone: Zone): MobileWidget[] => {
    const list = Array.isArray(src[zone]) ? (src[zone] as unknown[]) : [];
    const out: MobileWidget[] = [];
    for (const x of list) {
      const id = x as MobileWidget;
      if (!MOBILE_WIDGETS.includes(id) || seen.has(id) || !allowedZones(id).includes(zone)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  const n = Number(src.screens);
  const out: MobileOrder = { screens: n === 1 || n === 2 ? n : 3, s1: take('s1'), s2: take('s2'), s3: take('s3'), icon: take('icon'), hidden: take('hidden') };
  for (const zone of ZONES) for (const id of def[zone]) if (!seen.has(id)) { seen.add(id); out[zone].push(id); }
  for (const id of MOBILE_WIDGETS) if (!seen.has(id)) out[allowedZones(id)[0]!].push(id);
  return out;
}

export const serializeOrder = (o: MobileOrder): string => JSON.stringify({ v: 3, ...o });

/**
 * Skutečné rozmístění podle počtu používaných obrazovek: widgety z nepoužívaných obrazovek přejdou na poslední používanou,
 * při jediné obrazovce mezi ikony (obrazovka 1 má jen pás pod stolem).
 */
export function effectiveOrder(o: MobileOrder): MobileOrder {
  if (o.screens === 3) return o;
  const out: MobileOrder = { ...o, s2: [...o.s2], s3: [...o.s3], icon: [...o.icon] };
  if (o.screens === 2) {
    out.s2.push(...out.s3);
    out.s3 = [];
  } else {
    out.icon.push(...out.s2, ...out.s3);
    out.s2 = [];
    out.s3 = [];
  }
  return out;
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

/** Přesune widget do jiného místa (na konec jeho seznamu); nepřípustné místo ignoruje. */
export function moveToZone(order: MobileOrder, id: MobileWidget, zone: Zone): MobileOrder {
  if (!allowedZones(id).includes(zone)) return order;
  const strip = (l: MobileWidget[]) => l.filter((x) => x !== id);
  const next = { ...order, s1: strip(order.s1), s2: strip(order.s2), s3: strip(order.s3), icon: strip(order.icon), hidden: strip(order.hidden) };
  next[zone] = [...next[zone], id];
  return next;
}

export const zoneOf = (order: MobileOrder, id: MobileWidget): Zone => ZONES.find((z) => order[z].includes(id)) ?? 'hidden';

/** Ikona widgetu v horní liště (když je mezi ikonami). */
export const WIDGET_ICON: Record<MobileWidget, string> = { timer: '⏱', best: '🃏', sounds: '🔊', events: '📜', players: '👥', table: '🪑', bounties: '🎯', info: 'ℹ️', chat: '💬' };
