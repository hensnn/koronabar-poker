/**
 * Velikosti panelů a oken se pamatují zvlášť pro každé zobrazení (rozlišení obrazovky a zvětšení systému),
 * takže notebook se zvětšením Windows 150 % a velký monitor nepřepisují jeden druhému velikosti widgetů.
 */
export const SIZE_KEYS: ReadonlySet<string> = new Set([
  'ui.tableSideWidth',
  'ui.tableSideHeight',
  'ui.tablePanelWidth',
  'ui.tablePanelHeight',
  'ui.tableChatHeight',
  'ui.tableAreaWidthPercent',
  'ui.tableWidthPercent',
  'ui.tableHeightPercent',
  'ui.noteWindowWidth',
  'ui.noteWindowHeight',
  'ui.fontScalePercent',
]);

/** Kolik zobrazení se pamatuje (nejstarší se zahodí), aby se uložený text nezvětšoval donekonečna. */
export const MAX_DISPLAYS = 8;

type Profiles = Record<string, Record<string, number>>;

/** Identifikátor zobrazení: rozlišení obrazovky a zvětšení (např. „1920x1080@1.5“). */
export function displayId(): string {
  if (typeof window === 'undefined') return 'default';
  const s = window.screen;
  return `${s?.width ?? 0}x${s?.height ?? 0}@${window.devicePixelRatio || 1}`;
}

export function parseProfiles(text: string): Profiles {
  try {
    const o = JSON.parse(text) as unknown;
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return {};
    const out: Profiles = {};
    for (const [id, entry] of Object.entries(o as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const vals: Record<string, number> = {};
      for (const [k, v] of Object.entries(entry as Record<string, unknown>)) if (SIZE_KEYS.has(k) && typeof v === 'number' && Number.isFinite(v)) vals[k] = v;
      out[id] = vals;
    }
    return out;
  } catch {
    return {};
  }
}

/** Uloží hodnotu pro dané zobrazení; to se přesune na konec (nejnovější), nejstarší nad limit se zahodí. */
export function setProfileValue(text: string, id: string, key: string, value: number): string {
  const p = parseProfiles(text);
  const entry = { ...(p[id] ?? {}), [key]: value };
  delete p[id];
  const ids = Object.keys(p).slice(-(MAX_DISPLAYS - 1));
  const next: Profiles = {};
  for (const i of ids) next[i] = p[i]!;
  next[id] = entry;
  return JSON.stringify(next);
}

/** Zruší uloženou hodnotu pro dané zobrazení (platí zase výchozí). */
export function clearProfileValue(text: string, id: string, key: string): string {
  const p = parseProfiles(text);
  if (!p[id]) return text;
  const { [key]: _drop, ...rest } = p[id]!;
  if (Object.keys(rest).length > 0) p[id] = rest;
  else delete p[id];
  return Object.keys(p).length > 0 ? JSON.stringify(p) : '';
}

/** Hodnoty velikostí platné pro dané zobrazení. */
export function profileOverrides(text: string, id: string): Record<string, number> {
  return parseProfiles(text)[id] ?? {};
}
