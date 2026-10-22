import { lazy, type ComponentType } from 'react';

/** Načte stránku až při prvním otevření (menší první načtení aplikace). Pro moduly s pojmenovaným exportem. */
export function lazyPage<T extends Record<string, ComponentType<never>>, K extends keyof T>(load: () => Promise<T>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] as ComponentType<Record<string, unknown>> })));
}
