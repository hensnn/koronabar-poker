import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { BUILTIN_THEMES, resolveTokens, themeAttributes, themeToCss, type ResolvedTokens, type Theme } from '@kb/tokens';

export type ColorMode = 'light' | 'dark' | 'auto';

interface ThemeCtx {
  themes: Theme[];
  theme: Theme;
  /** Tokeny motivu pro sdílené (nebarevné) hodnoty, např. výčty a text. */
  tokens: ResolvedTokens;
}
const fallback = BUILTIN_THEMES[0]!;
const Ctx = createContext<ThemeCtx>({ themes: BUILTIN_THEMES, theme: fallback, tokens: resolveTokens(fallback, 'light') });
export const useThemes = () => useContext(Ctx);
/** Sdílená hodnota tokenu aktuálního motivu (výčet, text, číslo). */
export const useThemeToken = (key: string): string => useContext(Ctx).tokens[key] ?? '';

const STYLE_ID = 'tk-theme';

/** Vloží CSS proměnné motivu, datové atributy výčtových tokenů a nastaví světlý/tmavý režim (včetně „podle systému“). */
export function ThemeProvider({
  themeId,
  fallbackId = 'classic-green',
  colorMode,
  custom = [],
  preview,
  previewMode = null,
  locked = [],
  children,
}: {
  themeId: string;
  /** Motiv, který se použije, když vybraný neexistuje (např. smazaný sdílený). */
  fallbackId?: string;
  colorMode: ColorMode;
  custom?: Theme[];
  /** Rozpracovaný motiv z editoru: přebije vybraný motiv. */
  preview?: Theme | null;
  /** Režim vynucený editorem (světlý / tmavý). */
  previewMode?: 'light' | 'dark' | null;
  /** Zamčené tokeny: motiv je nesmí přepsat, platí výchozí hodnota. */
  locked?: string[];
  children: ReactNode;
}) {
  const themes = useMemo(() => [...BUILTIN_THEMES, ...custom], [custom]);
  const picked = preview ?? themes.find((t) => t.id === themeId) ?? themes.find((t) => t.id === fallbackId) ?? BUILTIN_THEMES[0]!;
  const lockKey = locked.join(',');
  const theme = useMemo(() => {
    if (!lockKey || picked.builtin) return picked;
    const strip = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([k]) => !lockKey.split(',').includes(k)));
    return { ...picked, light: strip(picked.light), dark: strip(picked.dark) };
  }, [picked, lockKey]);
  const tokens = useMemo(() => resolveTokens(theme, 'light'), [theme]);

  useEffect(() => {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = themeToCss(theme);
    const root = document.documentElement;
    for (const [attr, value] of Object.entries(themeAttributes(tokens))) root.setAttribute(attr, value);
  }, [theme, tokens]);

  useEffect(() => {
    const root = document.documentElement;
    if (previewMode) {
      root.dataset.mode = previewMode;
      return;
    }
    if (colorMode !== 'auto') {
      root.dataset.mode = colorMode;
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      root.dataset.mode = mq.matches ? 'dark' : 'light';
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [colorMode, previewMode]);

  // Barva lišty prohlížeče a instalované aplikace sleduje pozadí aktuálního motivu a režimu.
  useEffect(() => {
    const apply = () => {
      const dark = (previewMode ?? (colorMode === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : colorMode)) === 'dark';
      let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'theme-color';
        document.head.appendChild(meta);
      }
      meta.content = resolveTokens(theme, dark ? 'dark' : 'light')['color.bg'] ?? meta.content;
    };
    apply();
    if (colorMode !== 'auto' || previewMode) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme, colorMode, previewMode]);

  return <Ctx.Provider value={{ themes, theme, tokens }}>{children}</Ctx.Provider>;
}
