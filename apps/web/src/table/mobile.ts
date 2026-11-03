import { useEffect, useSyncExternalStore } from 'react';
import { setProfileKind, useSettings } from '../settings';

function useMedia(query: string): boolean {
  const mq = typeof window !== 'undefined' && 'matchMedia' in window ? window.matchMedia(query) : null;
  return useSyncExternalStore(
    (l) => {
      mq?.addEventListener('change', l);
      return () => mq?.removeEventListener('change', l);
    },
    () => mq?.matches ?? false,
  );
}

/** Nainstalovaná aplikace (vlastní okno bez prohlížeče): hráč si okno smí libovolně zmenšit, třeba vedle Discordu. */
const APP_MODE = '(display-mode: standalone)';

/**
 * Telefon na šířku: široký, ale nízký displej s dotykovým ovládáním. Stůl se pak skládá vedle akční lišty.
 * Počítač s myší (např. notebook se zvětšením Windows na 150 %, kde je okno nízké) tím do telefonního rozložení nepřepne.
 */
export function useLandscapePhone(): boolean {
  const phone = useMedia('(max-height: 30rem) and (orientation: landscape) and (pointer: coarse)');
  const lowApp = useMedia(`${APP_MODE} and (max-height: 40rem) and (min-width: 40rem) and (orientation: landscape)`);
  return phone || lowApp;
}

/** Mobilní rozložení stolu: podle volby `ui.mobileLayout` (auto = úzký displej nebo telefon na šířku, on/off = vynuceno). */
export function useMobileLayout(): boolean {
  const narrow = useMedia('(max-width: 40rem)');
  // V aplikaci se do kompaktního rozložení přepíná už pod šířkou, kde mizí levý panel (64 rem), takže okno jde plynule zmenšovat.
  const appNarrow = useMedia(`${APP_MODE} and (max-width: 63.99rem)`);
  const landscape = useLandscapePhone();
  const mode = String(useSettings().values['ui.mobileLayout'] ?? 'auto');
  return mode === 'on' || (mode === 'auto' && (narrow || appNarrow || landscape));
}

/**
 * Zapne `data-mobile` (a na šířku `data-landscape`) na <html>, dokud je stránka stolu v mobilním rozložení;
 * CSS schová nabídku a vše napasuje do okna. Tvar oválu na výšku řídí osobní volba `ui.mobileTableAspect` (v %).
 */
export function useMobileAttribute(active: boolean, modern = false, scale = 1): void {
  const landscape = useLandscapePhone();
  const aspect = Number(useSettings().values['ui.mobileTableAspect'] ?? 115);
  const height = Number(useSettings().values['ui.mobileTableHeight'] ?? 100);
  const turnAlert = useSettings().values['ui.mobileTurnAlert'] !== false;
  useEffect(() => {
    const root = document.documentElement;
    if (active) root.setAttribute('data-mobile', '1');
    else root.removeAttribute('data-mobile');
    if (active && modern) root.setAttribute('data-mobile-modern', '1');
    else root.removeAttribute('data-mobile-modern');
    if (active && modern && turnAlert) root.setAttribute('data-turn-alert', '1');
    else root.removeAttribute('data-turn-alert');
    if (active && landscape) root.setAttribute('data-landscape', '1');
    else root.removeAttribute('data-landscape');
    applyMobileGeometry(aspect, height);
    const onResize = () => applyMobileGeometry(aspect, height);
    window.addEventListener('resize', onResize);
    if (active) root.style.setProperty('--tk-mscale', String(scale));
    else root.style.removeProperty('--tk-mscale');
    return () => {
      root.removeAttribute('data-mobile');
      root.removeAttribute('data-mobile-modern');
      root.removeAttribute('data-turn-alert');
      root.removeAttribute('data-landscape');
      root.style.removeProperty('--tk-mscale');
      root.style.removeProperty('--tk-mheight');
      window.removeEventListener('resize', onResize);
    };
  }, [active, modern, landscape, aspect, height, turnAlert, scale]);
}

/** Mobilní rozložení u stolu na počítači používá nastavení telefonu (karta Telefon), jinak by se jeho volby neprojevily. */
export function useFollowPhoneProfile(mobile: boolean): void {
  useEffect(() => {
    setProfileKind(mobile ? 'phone' : null);
    return () => setProfileKind(null);
  }, [mobile]);
}

/** Zmenšení prvků na stole podle počtu sedadel (osm: 92 %, devět: 85 %, deset: 80 %), aby se na úzkém displeji nepřekrývaly. */
export const autoShrinkFor = (seatCount: number): number => (seatCount >= 10 ? 0.8 : seatCount === 9 ? 0.85 : seatCount === 8 ? 0.92 : 1);

/** Výsledné měřítko prvků na stole na telefonu: volba hráče krát automatické zmenšení (je-li zapnuté), v rozsahu 0,5 až 1,1. */
export function mobileScale(values: Record<string, unknown>, seatCount: number): number {
  const base = Math.min(110, Math.max(60, Number(values['ui.mobileTableScale'] ?? 100))) / 100;
  const auto = values['ui.mobileAutoShrink'] === false ? 1 : autoShrinkFor(seatCount);
  return Math.round(Math.min(1.1, Math.max(0.5, base * auto)) * 1000) / 1000;
}

/**
 * Činitel výšky stolu na telefonu: hráčova volba (1 = výchozí), ale nejvýš tak, aby nad ovládacím panelem zbylo aspoň minimum místa
 * (lišta, plánované tahy a panel zabírají asi 16 rem). Šířka stolu se nemění, jen jeho výška.
 */
export function tableHeightFactor(k: number, vw: number, vh: number, aspect: number, reserve = 260): number {
  const a = Math.max(0.1, aspect);
  const width = Math.min(vw - 16, (vh - 352) * a);
  const base = width / a;
  const max = base > 0 ? (vh - reserve) / base : k;
  return Math.round(Math.max(0.6, Math.min(k, max)) * 1000) / 1000;
}

/** Nastaví tvar a výšku stolu na telefonu (CSS proměnné); používá se při změně nastavení i při náhledu posuvníku. */
export function applyMobileGeometry(aspectPct: number, heightPct: number): void {
  const root = document.documentElement;
  const a = Math.max(1, aspectPct) / 100;
  const k = tableHeightFactor(Math.min(130, Math.max(70, heightPct)) / 100, window.innerWidth, window.innerHeight, a);
  root.style.setProperty('--tk-mobile-aspect', String(a / k));
  root.style.setProperty('--tk-mheight', String(k));
}
