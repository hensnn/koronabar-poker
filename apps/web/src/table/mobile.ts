import { useEffect, useSyncExternalStore } from 'react';
import { useSettings } from '../settings';

const QUERY = '(max-width: 40rem)';
const mq = typeof window !== 'undefined' && 'matchMedia' in window ? window.matchMedia(QUERY) : null;

function useNarrow(): boolean {
  return useSyncExternalStore(
    (l) => {
      mq?.addEventListener('change', l);
      return () => mq?.removeEventListener('change', l);
    },
    () => mq?.matches ?? false,
  );
}

/** Mobilní rozložení stolu: podle volby `ui.mobileLayout` (auto = úzký displej, on/off = vynuceno). */
export function useMobileLayout(): boolean {
  const narrow = useNarrow();
  const mode = String(useSettings().values['ui.mobileLayout'] ?? 'auto');
  return mode === 'on' || (mode === 'auto' && narrow);
}

/** Zapne `data-mobile` na <html>, dokud je stránka stolu v mobilním rozložení (CSS schová nabídku a vše napasuje do okna). */
export function useMobileAttribute(active: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    if (active) root.setAttribute('data-mobile', '1');
    else root.removeAttribute('data-mobile');
    return () => root.removeAttribute('data-mobile');
  }, [active]);
}
