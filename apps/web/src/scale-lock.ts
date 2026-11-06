import { useEffect, useState } from 'react';
import { cssVarName } from '@kb/tokens';
import { defaultOf, useSettings } from './settings';

export type ScaleLockMode = 'height' | 'fit';

export interface ScaleInput {
  w: number;
  h: number;
  refW: number;
  refH: number;
  mode: ScaleLockMode;
  minPercent: number;
  maxPercent: number;
}

/**
 * Měřítko rozhraní: velikost okna vůči vzorové velikosti (celá obrazovka), omezené mezemi.
 * Zaokrouhluje se na setiny, ať se rozložení nepřepočítává při každém pixelu tažení okna.
 */
export function scaleFor(i: ScaleInput): number {
  if (!(i.refW > 0 && i.refH > 0 && i.w > 0 && i.h > 0)) return 1;
  const byHeight = i.h / i.refH;
  const raw = i.mode === 'fit' ? Math.min(byHeight, i.w / i.refW) : byHeight;
  const s = Math.min(i.maxPercent / 100, Math.max(i.minPercent / 100, raw));
  return Math.round(s * 100) / 100;
}

/**
 * Přepočte rozměry v podmínce media query (šířka, výška) měřítkem. Rozhraní je v rem a rem v media query se nezvětšuje
 * s písmem na kořeni stránky, takže při měřítku 0,8 musí „okno široké 64 rem“ začínat už na 0,8 × 64 rem skutečné šířky.
 */
export function scaleMediaText(text: string, s: number): string {
  if (!/(width|height)/.test(text)) return text;
  return text.replace(/(\d*\.?\d+)(rem|em|px)\b/g, (_, n: string, unit: string) => `${Math.round(Number(n) * s * 10000) / 10000}${unit}`);
}

const original = new WeakMap<CSSMediaRule, string>();

function eachMedia(rules: CSSRuleList, fn: (r: CSSMediaRule) => void): void {
  for (const r of Array.from(rules)) {
    if (r instanceof CSSMediaRule) fn(r);
    const inner = (r as CSSGroupingRule).cssRules;
    if (inner) eachMedia(inner, fn);
  }
}

/** Přepíše podmínky šířky a výšky ve všech stylech stránky (s = 1 vrátí původní znění). */
export function applyMediaScale(s: number): void {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cizí styl bez přístupu
    }
    eachMedia(rules, (r) => {
      if (s === 1 && !original.has(r)) return;
      const base = original.get(r) ?? r.media.mediaText;
      original.set(r, base);
      const next = scaleMediaText(base, s);
      if (r.media.mediaText !== next) r.media.mediaText = next;
    });
  }
}

/** Aktuální měřítko zamčeného rozložení (1, když je vypnuté); pro místa, kde se rozhoduje podle šířky okna ve skriptu. */
export function scaleLockFactor(): number {
  return Number(document.documentElement.dataset.scaleLock) || 1;
}

/** Tokeny, které se s měřítkem nemění: písmo řídí kořen stránky (`font-size`) a tenké čáry se nemají zmenšit pod jeden pixel. */
const UNSCALED_TOKENS = new Set(['size.textBase', 'shape.borderWidth']);

/**
 * CSS, které přepíše délky v pixelech z motivu (odsazení, velikost karet a avatarů, zaoblení) jejich násobkem měřítka.
 * Vysoká specificita (`:root:root:root`) přebije proměnné motivu pro světlý i tmavý režim bez ohledu na pořadí stylů.
 */
export function scaledTokenCss(tokens: Record<string, string>, s: number): string {
  const decl = Object.entries(tokens)
    .filter(([key, value]) => !UNSCALED_TOKENS.has(key) && /^\d*\.?\d+px$/.test(value))
    .map(([key, value]) => `${cssVarName(key)}:${Math.round(parseFloat(value) * s * 100) / 100}px;`)
    .join('');
  return decl ? `:root:root:root{${decl}}` : '';
}

/** Rozměr v pixelech uložený v osobním nastavení (šířka panelu…) jako CSS délka, která se s měřítkem okna mění stejně jako rem. */
export const scaledPx = (px: number): string => `calc(${px}px * var(--kb-scale, 1))`;

/** Měřítko podle velikosti okna a osobního nastavení; 1, dokud není zapnuté. */
export function useScaleFactor(): number {
  const values = useSettings().values;
  const active = values['ui.scaleLock'] === 'on';
  const [win, setWin] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setWin((c) => (c.w === window.innerWidth && c.h === window.innerHeight ? c : { w: window.innerWidth, h: window.innerHeight })));
    };
    window.addEventListener('resize', measure);
    measure();
    return () => {
      window.removeEventListener('resize', measure);
      cancelAnimationFrame(raf);
    };
  }, [active]);
  if (!active) return 1;
  return scaleFor({
    w: win.w,
    h: win.h,
    refW: Number(values['ui.scaleLockRefWidth']) || window.screen.width,
    refH: Number(values['ui.scaleLockRefHeight']) || window.screen.height,
    mode: values['ui.scaleLockMode'] === 'fit' ? 'fit' : 'height',
    minPercent: Number(values['ui.scaleLockMinPercent'] ?? defaultOf('ui.scaleLockMinPercent')),
    maxPercent: Number(values['ui.scaleLockMaxPercent'] ?? defaultOf('ui.scaleLockMaxPercent')),
  });
}

/**
 * Zapíše měřítko do stránky: podmínky šířky a výšky v CSS se přepočítají (rozložení se rozhoduje podle „virtuálního“ okna)
 * a `data-scale-lock` na <html> říká měřítko skriptům. Velikost písma na kořeni nastavuje `useApplyDensity`.
 */
export function useApplyScaleLock(): number {
  const s = useScaleFactor();
  useEffect(() => {
    const root = document.documentElement;
    if (s === 1) {
      delete root.dataset.scaleLock;
      root.style.removeProperty('--kb-scale');
    } else {
      root.dataset.scaleLock = String(s);
      root.style.setProperty('--kb-scale', String(s));
    }
    applyMediaScale(s);
    if (s === 1) return;
    // Styly, které se načtou později (stránky načítané až při otevření), dostanou stejný přepočet.
    const watch = new MutationObserver(() => applyMediaScale(s));
    watch.observe(document.head, { childList: true });
    return () => watch.disconnect();
  }, [s]);
  useEffect(
    () => () => {
      delete document.documentElement.dataset.scaleLock;
      document.documentElement.style.removeProperty('--kb-scale');
      applyMediaScale(1);
    },
    [],
  );
  return s;
}
