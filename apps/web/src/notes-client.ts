import { useSyncExternalStore } from 'react';
import { del, get, post, put, patch } from './api';

export interface NoteLabel {
  id: string;
  name: string;
  color: string;
}
export interface PlayerNote {
  targetId: string;
  nickname: string;
  note: string;
  labelId: string | null;
  updatedAt: number;
}
interface State {
  colors: string[];
  labels: NoteLabel[];
  notes: PlayerNote[];
  loaded: boolean;
}

const EMPTY: State = { colors: [], labels: [], notes: [], loaded: false };
let state: State = EMPTY;
const listeners = new Set<() => void>();
const set = (next: State) => {
  state = next;
  listeners.forEach((l) => l());
};

export const useNotes = (): State =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );

/** Barvy štítků jsou klíče designových tokenů; třídy jsou tady vypsané celé, aby je Tailwind našel. */
export const LABEL_BG: Record<string, string> = { primary: 'bg-primary', secondary: 'bg-secondary', accent: 'bg-accent', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', muted: 'bg-muted' };

export async function loadNotes(): Promise<void> {
  const d = await get<{ colors: string[]; labels: NoteLabel[]; notes: PlayerNote[] }>('/api/notes');
  set({ ...d, loaded: true });
}

export const resetNotes = () => set(EMPTY);

export async function saveNote(targetId: string, note: string, labelId: string | null): Promise<void> {
  await put(`/api/notes/player/${targetId}`, { note, labelId });
  await loadNotes();
}

export async function deleteNote(targetId: string): Promise<void> {
  await del(`/api/notes/player/${targetId}`);
  await loadNotes();
}

export async function addLabel(name: string, color: string): Promise<void> {
  await post('/api/notes/labels', { name, color });
  await loadNotes();
}

export async function updateLabel(id: string, name: string, color: string): Promise<void> {
  await patch(`/api/notes/labels/${id}`, { name, color });
  await loadNotes();
}

export async function removeLabel(id: string): Promise<void> {
  await del(`/api/notes/labels/${id}`);
  await loadNotes();
}

/** Štítek a poznámka k hráči (pokud nějaké jsou). */
export function noteFor(s: State, userId: string): { note: PlayerNote; label: NoteLabel | null } | null {
  const note = s.notes.find((n) => n.targetId === userId);
  return note ? { note, label: s.labels.find((l) => l.id === note.labelId) ?? null } : null;
}
