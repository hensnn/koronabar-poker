import { useEffect, useSyncExternalStore } from 'react';
import { useSettings } from '../settings';

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

/** Telefon na šířku: široký, ale nízký displej. Stůl se pak skládá vedle akční lišty. */
export function useLandscapePhone(): boolean {
  return useMedia('(max-height: 30rem) and (orientation: landscape)');
}

/** Mobilní rozložení stolu: podle volby `ui.mobileLayout` (auto = úzký displej nebo telefon na šířku, on/off = vynuceno). */
export function useMobileLayout(): boolean {
  const narrow = useMedia('(max-width: 40rem)');
  const landscape = useLandscapePhone();
  const mode = String(useSettings().values['ui.mobileLayout'] ?? 'auto');
  return mode === 'on' || (mode === 'auto' && (narrow || landscape));
}

/**
 * Zapne `data-mobile` (a na šířku `data-landscape`) na <html>, dokud je stránka stolu v mobilním rozložení;
 * CSS schová nabídku a vše napasuje do okna. Tvar oválu na výšku řídí osobní volba `ui.mobileTableAspect` (v %).
 */
export function useMobileAttribute(active: boolean, modern = false): void {
  const landscape = useLandscapePhone();
  const aspect = Number(useSettings().values['ui.mobileTableAspect'] ?? 115);
  useEffect(() => {
    const root = document.documentElement;
    if (active) root.setAttribute('data-mobile', '1');
    else root.removeAttribute('data-mobile');
    if (active && modern) root.setAttribute('data-mobile-modern', '1');
    else root.removeAttribute('data-mobile-modern');
    if (active && landscape) root.setAttribute('data-landscape', '1');
    else root.removeAttribute('data-landscape');
    root.style.setProperty('--tk-mobile-aspect', String(Math.max(1, aspect) / 100));
    return () => {
      root.removeAttribute('data-mobile');
      root.removeAttribute('data-mobile-modern');
      root.removeAttribute('data-landscape');
    };
  }, [active, modern, landscape, aspect]);
}
