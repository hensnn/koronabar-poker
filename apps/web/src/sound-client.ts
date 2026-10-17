import { useSyncExternalStore } from 'react';
import { del, get, post } from './api';

export interface SoundItem {
  id: string;
  name: string;
  shortcut: string;
  emoji: string;
  category: string;
  status: string;
  builtin: boolean;
  durationMs: number;
  sizeBytes: number;
  mine: boolean;
  ownerNickname: string | null;
  favorite: boolean;
  lastUsedAt: number | null;
  uses: number;
}
export interface SoundMute {
  kind: string;
  target: string;
}
export interface SoundUsage {
  bytes: number;
  quotaBytes: number;
  count: number;
}
export interface SoundPlayEvent {
  soundId: string;
  shortcut: string;
  name: string;
  emoji: string;
  durationMs: number;
  from: { userId: string; nickname: string };
  target: { kind: 'table' | 'channel'; id: string };
  silent: boolean;
  jingle?: boolean;
}

interface State {
  loaded: boolean;
  sounds: SoundItem[];
  mutes: SoundMute[];
  usage: SoundUsage | null;
  /** Prohlížeč zablokoval přehrávání, dokud uživatel na stránce nekliknul. */
  locked: boolean;
}

let state: State = { loaded: false, sounds: [], mutes: [], usage: null, locked: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const useSoundState = (): State =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );

export async function loadSounds(): Promise<void> {
  const d = await get<{ sounds: SoundItem[]; mutes: SoundMute[]; usage: SoundUsage }>('/api/sounds');
  set({ loaded: true, sounds: d.sounds, mutes: d.mutes, usage: d.usage });
}

export function resetSounds(): void {
  state = { loaded: false, sounds: [], mutes: [], usage: null, locked: false };
  listeners.forEach((l) => l());
}

export const soundUrl = (id: string) => `/api/sounds/${id}/audio`;

export async function playSound(id: string, target: { kind: 'table' | 'channel'; id: string }): Promise<{ silent: boolean }> {
  const r = await post<{ silent: boolean }>(`/api/sounds/${id}/play`, target);
  void loadSounds().catch(() => undefined);
  return r;
}

export async function toggleFavorite(id: string, on: boolean): Promise<void> {
  await post(`/api/sounds/${id}/favorite`, { on });
  await loadSounds();
}

export async function setMute(kind: 'sound' | 'player' | 'channel' | 'table', target: string, on: boolean): Promise<void> {
  await post('/api/sounds/mute', { kind, target, on });
  await loadSounds();
}

export async function removeSound(id: string): Promise<void> {
  await del(`/api/sounds/${id}`);
  await loadSounds();
}

// ---------- přehrávání ----------

const cache = new Map<string, HTMLAudioElement>();
let unlocked = false;

/** Prohlížeče blokují zvuk před první interakcí; po prvním kliknutí ho odemkneme. */
export function unlockAudio(): void {
  if (unlocked) return;
  unlocked = true;
  try {
    const a = new Audio();
    a.muted = true;
    void a.play().catch(() => undefined);
  } catch {
    /* nic */
  }
  if (state.locked) set({ locked: false });
}

if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, unlockAudio, { once: true, passive: true });
}

export interface PlaybackPrefs {
  /** Slyšet znělky ostatních. */
  jingles?: boolean;
  play: boolean;
  volume: number;
  mode: 'both' | 'table' | 'chat';
}

/** Rozhodne podle osobního nastavení a ztlumení, jestli se zvuk přehraje, a případně ho přehraje. */
export function handleSoundEvent(e: SoundPlayEvent, prefs: PlaybackPrefs): boolean {
  if (e.silent || !prefs.play || prefs.volume <= 0) return false;
  if (e.jingle && prefs.jingles === false) return false;
  if ((e.target.kind === 'table' && prefs.mode === 'chat') || (e.target.kind === 'channel' && prefs.mode === 'table')) return false;
  const muted = (kind: string, target: string) => state.mutes.some((m) => m.kind === kind && m.target === target);
  if (muted('sound', e.shortcut) || muted('player', e.from.userId) || muted(e.target.kind, e.target.id)) return false;
  try {
    let a = cache.get(e.soundId);
    if (!a) {
      a = new Audio(soundUrl(e.soundId));
      a.preload = 'auto';
      cache.set(e.soundId, a);
    }
    a.volume = Math.min(1, Math.max(0, prefs.volume / 100));
    a.currentTime = 0;
    void a.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        unlocked = false;
        set({ locked: true });
      }
    });
    return true;
  } catch {
    return false;
  }
}

/** Krátký dvoutónový signál (bez souborů) pro upozornění na zmínku v chatu. */
export function playMentionTone(volume: number): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx || unlocked === false) return;
    const ctx = new Ctx();
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1, Math.max(0, volume / 100)) * 0.3;
    gain.connect(ctx.destination);
    [880, 1175].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.1);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* zvuk není dostupný */
  }
}

/** Přehraje zvuk jako náhled (z knihovny), bez ohledu na ztlumení. */
export function previewSound(id: string, volume = 80): void {
  const a = new Audio(soundUrl(id));
  a.volume = Math.min(1, Math.max(0, volume / 100));
  void a.play().catch(() => undefined);
}
