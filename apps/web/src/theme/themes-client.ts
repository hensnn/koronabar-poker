import { useSyncExternalStore } from 'react';
import type { Theme } from '@kb/tokens';
import { del, get, patch, post, put } from '../api';

export interface CustomTheme {
  id: string;
  name: string;
  status: string;
  ownerId: string | null;
  ownerNickname: string | null;
  mine: boolean;
  theme: Theme;
  updatedAt: number;
}

interface State {
  loaded: boolean;
  themes: CustomTheme[];
  locked: string[];
  defaultId: string;
}

let state: State = { loaded: false, themes: [], locked: [], defaultId: 'classic-green' };
const listeners = new Set<() => void>();
const set = (patchState: Partial<State>) => {
  state = { ...state, ...patchState };
  listeners.forEach((l) => l());
};

export const useThemeStore = (): State =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );

export async function loadThemes(): Promise<void> {
  const d = await get<{ themes: CustomTheme[]; locked: string[]; defaultId: string }>('/api/themes');
  set({ loaded: true, themes: d.themes, locked: d.locked, defaultId: d.defaultId });
}

export function resetThemes(): void {
  state = { loaded: false, themes: [], locked: [], defaultId: 'classic-green' };
  listeners.forEach((l) => l());
}

type Payload = { light: Record<string, string>; dark: Record<string, string>; schemaVersion?: number };

export async function createTheme(name: string, theme: Payload): Promise<{ id: string; dropped: string[] }> {
  const r = await post<{ id: string; dropped: string[] }>('/api/themes', { name, theme });
  await loadThemes();
  return r;
}
export async function updateTheme(id: string, input: { name?: string; theme?: Payload }): Promise<{ dropped: string[] }> {
  const r = await patch<{ dropped: string[] }>(`/api/themes/${id}`, input);
  await loadThemes();
  return r;
}
export async function deleteTheme(id: string): Promise<void> {
  await del(`/api/themes/${id}`);
  await loadThemes();
}
export async function shareTheme(id: string, on: boolean): Promise<void> {
  await post(`/api/themes/${id}/share`, { on });
  await loadThemes();
}
export async function lockTokens(tokens: string[]): Promise<void> {
  await put('/api/themes/locked', { tokens });
  await loadThemes();
}
