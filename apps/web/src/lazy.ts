import { lazy, type ComponentType } from 'react';

/** Příznak v sessionStorage: stránka se kvůli nenačtenému modulu už jednou obnovila (ochrana před smyčkou). */
export const RELOAD_FLAG = 'kb.lazy.reloaded';

interface RetryDeps {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  reload: () => void;
}

const browserDeps = (): RetryDeps => {
  let storage: RetryDeps['storage'] = null;
  try {
    storage = typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    storage = null;
  }
  return { storage, reload: () => window.location.reload() };
};

/**
 * Načte modul; když selže (po nasazení nové verze už starý soubor na serveru není), stránku jednou obnoví,
 * aby si stáhla nový seznam souborů. Druhé selhání po sobě už chybu propustí (zachytí ji ErrorBoundary).
 */
export function loadWithRetry<T>(load: () => Promise<T>, deps: RetryDeps = browserDeps()): Promise<T> {
  const flag = () => {
    try {
      return deps.storage?.getItem(RELOAD_FLAG) === '1';
    } catch {
      return false;
    }
  };
  return load().then(
    (m) => {
      try {
        deps.storage?.removeItem(RELOAD_FLAG);
      } catch {
        /* bez úložiště se jen neobnovuje */
      }
      return m;
    },
    (e: unknown) => {
      // Bez úložiště by se obnovení mohlo opakovat donekonečna: chybu raději propustit.
      if (!deps.storage || flag()) throw e;
      try {
        deps.storage.setItem(RELOAD_FLAG, '1');
      } catch {
        throw e;
      }
      deps.reload();
      // Stránka se právě obnovuje; nic dalšího se už nevykreslí.
      return new Promise<T>(() => undefined);
    },
  );
}

/** Načte stránku až při prvním otevření (menší první načtení aplikace). Pro moduly s pojmenovaným exportem. */
export function lazyPage<T extends Record<string, ComponentType<never>>, K extends keyof T>(load: () => Promise<T>, name: K) {
  return lazy(() => loadWithRetry(load).then((m) => ({ default: m[name] as ComponentType<Record<string, unknown>> })));
}
