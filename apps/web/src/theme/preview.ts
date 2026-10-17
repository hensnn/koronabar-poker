import { useSyncExternalStore } from 'react';
import type { Theme } from '@kb/tokens';

/** Rozpracovaný motiv z editoru vzhledu; celá aplikace ho zobrazí živě, dokud editor běží. */
interface State {
  draft: Theme | null;
  mode: 'light' | 'dark' | null;
}

let state: State = { draft: null, mode: null };
const listeners = new Set<() => void>();

export function setThemePreview(draft: Theme | null, mode: 'light' | 'dark' | null = null): void {
  state = { draft, mode };
  listeners.forEach((l) => l());
}

export const useThemePreview = (): State =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
