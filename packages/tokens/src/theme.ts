import { TOKEN_DEFS, themeSchema, THEME_SCHEMA_VERSION, tokenDef, type Mode, type ResolvedTokens, type Theme, type TokenDef } from './schema.js';

/** Plné tokeny motivu pro režim. Chybějící hodnoty doplní výchozí. */
export function resolveTokens(theme: Theme, mode: Mode): ResolvedTokens {
  const out: ResolvedTokens = {};
  // Sdílené tokeny (tvary, velikosti, styly) platí pro oba režimy: motiv je smí uvést jen jednou (ve světlém), tmavý režim je zdědí.
  for (const d of TOKEN_DEFS) out[d.key] = theme[mode][d.key] ?? (d.shared ? theme.light[d.key] : undefined) ?? d[mode];
  return out;
}

/** Název CSS proměnné pro token, např. `color.bg` → `--tk-color-bg`. */
export const cssVarName = (key: string) => `--tk-${key.replace(/\./g, '-')}`;

/** Název datového atributu pro výčtový token, např. `cards.fourColor` → `data-tk-cards-four-color`. */
export const dataAttrName = (key: string) => `data-tk-${key.replace(/\./g, '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;

const ASSET = /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Cesta, odkud klient stahuje nahrané obrázky motivů. */
export const ASSET_URL = (id: string) => `/api/theme-assets/${id}`;

/** Hodnota tokenu tak, jak se zapíše do CSS (obrázek `asset:ID` se převede na `url(...)`, text se do CSS nedává). */
function cssValue(d: TokenDef, v: string): string | null {
  if (d.type === 'text') return null;
  if (d.type === 'image') {
    const m = ASSET.exec(v);
    return m ? `url("${ASSET_URL(m[1]!)}")` : 'none';
  }
  return v;
}

/** CSS pro oba režimy: `:root[data-mode="dark"] { --tk-... }`. */
export function themeToCss(theme: Theme): string {
  const block = (mode: Mode) =>
    Object.entries(resolveTokens(theme, mode))
      .map(([k, v]) => {
        const d = tokenDef(k)!;
        const val = cssValue(d, v);
        return val === null ? '' : `${cssVarName(k)}:${val};`;
      })
      .join('');
  return `:root,:root[data-mode="light"]{${block('light')}}:root[data-mode="dark"]{${block('dark')}}`;
}

/** Datové atributy pro výčtové tokeny (CSS podle nich přepíná styl karet, tlačítek…). */
export function themeAttributes(tokens: ResolvedTokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of TOKEN_DEFS) if (d.type === 'enum') out[dataAttrName(d.key)] = tokens[d.key] ?? d.light;
  return out;
}

/** Hodnota tokenu nesmí obsahovat nic, čím by šlo vložit další CSS nebo skript. */
export function isSafeValue(v: string): boolean {
  return !/[;{}<>\\]|url\(|expression\(|@import/i.test(v);
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const LENGTH = /^-?\d+(\.\d+)?(px|rem|em|%)$/;

/** Je hodnota platná pro daný token (typ, rozsah, výčet)? */
export function validateTokenValue(d: TokenDef, v: string): boolean {
  if (typeof v !== 'string' || v.length > 200 || !isSafeValue(v)) return false;
  switch (d.type) {
    case 'color':
      return HEX.test(v);
    case 'length':
      return LENGTH.test(v);
    case 'number': {
      const n = Number(v);
      return Number.isFinite(n) && n >= (d.min ?? -1e9) && n <= (d.max ?? 1e9);
    }
    case 'enum':
      return (d.options ?? []).includes(v);
    case 'image':
      return v === 'none' || ASSET.test(v);
    case 'text':
      return v.length <= 60;
    case 'shadow':
      return v === 'none' || /^(-?\d+(\.\d+)?(px)?\s+){2,3}-?\d+(\.\d+)?(px)?\s+#[0-9a-fA-F]{3,8}$|^(-?\d+(\.\d+)?(px)?\s+){1,3}#[0-9a-fA-F]{3,8}$/.test(v);
    case 'font':
      return v.length >= 3 && v.length <= 160;
  }
}

/** Převede starší motiv na aktuální verzi schématu (chybějící tokeny doplňují výchozí hodnoty při použití). */
export function migrateTheme(theme: Theme): Theme {
  if (theme.schemaVersion >= THEME_SCHEMA_VERSION) return theme;
  return { ...theme, schemaVersion: THEME_SCHEMA_VERSION };
}

export type ThemeImport = { ok: true; theme: Theme; dropped: string[] } | { ok: false };

/** Import motivu z JSON: ověření, migrace, vyřazení neznámých a neplatných tokenů. */
export function importTheme(json: string): ThemeImport {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false };
  }
  const p = themeSchema.safeParse(raw);
  if (!p.success) return { ok: false };
  const dropped: string[] = [];
  const clean = (m: Record<string, string>) => {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) {
      const d = tokenDef(k);
      if (d && validateTokenValue(d, v)) o[k] = v;
      else dropped.push(k);
    }
    return o;
  };
  return {
    ok: true,
    dropped,
    theme: migrateTheme({
      schemaVersion: p.data.schemaVersion,
      id: p.data.id,
      name: p.data.name,
      builtin: false,
      light: clean(p.data.light),
      dark: clean(p.data.dark),
    }),
  };
}

export function exportTheme(theme: Theme): string {
  return JSON.stringify({ ...theme, builtin: undefined }, null, 2);
}
