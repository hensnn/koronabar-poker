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
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);
}
