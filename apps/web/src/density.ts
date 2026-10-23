import { useEffect } from 'react';
import { deviceId, useSettings } from './settings';

export type Density = 'compact' | 'normal' | 'comfortable';

/** Zvolená hustota zobrazení; „auto“ = úsporná na dotykových zařízeních (telefon, tablet), běžná na počítači. */
export function resolveDensity(value: unknown): Density {
  if (value === 'compact' || value === 'normal' || value === 'comfortable') return value;
  return deviceId() === 'phone' ? 'compact' : 'normal';
}

export function useDensity(): Density {
  return resolveDensity(useSettings().values['ui.density']);
}

/** Zapíše hustotu na kořen stránky; velikosti odsazení jsou pak v CSS proměnných (styles.css). */
export function useApplyDensity(): void {
  const density = useDensity();
  const scale = Number(useSettings().values['ui.fontScalePercent'] ?? 100);
  // Velikost písma: všechny rozměry jsou v rem, takže stačí změnit základ na kořeni stránky.
  useEffect(() => {
    const root = document.documentElement;
    if (scale === 100) root.style.removeProperty('font-size');
    else root.style.setProperty('font-size', `${scale}%`);
    return () => {
      root.style.removeProperty('font-size');
    };
  }, [scale]);
  // Omezení pohybu (osobní volba): CSS pak vypne všechny animace a přechody.
  const reduced = useSettings().values['ui.reducedMotion'] === true;
  useEffect(() => {
    const root = document.documentElement;
    if (reduced) root.dataset.reducedMotion = 'on';
    else delete root.dataset.reducedMotion;
    return () => {
      delete root.dataset.reducedMotion;
    };
  }, [reduced]);
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);
}
