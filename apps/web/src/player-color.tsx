import { useEffect, useState } from 'react';
import { playerColorVar } from '@kb/shared';
import { get } from './api';

/** Barvy hráčů (kód 1 až 60) pro všechny statistiky, grafy a žebříčky; načtou se jednou a osvěží se po minutě. */
let colors: Record<string, number> = {};
let loadedAt = 0;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(force = false): void {
  if (loading || (!force && Date.now() - loadedAt < 60_000)) return;
  loading = get<{ colors: Record<string, number> }>('/api/stats/player-colors')
    .then((d) => {
      colors = d.colors;
      loadedAt = Date.now();
      listeners.forEach((l) => l());
    })
    .catch(() => undefined)
    .finally(() => {
      loading = null;
    });
}

/** Barvy všech hráčů podle id (prázdné, dokud se nenačtou). */
export function usePlayerColors(): Record<string, number> {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    load();
    return () => void listeners.delete(l);
  }, []);
  return colors;
}

/** Barevná tečka podle kódu barvy (pro obrazovky bez přihlášení: veřejný přehled, televize). */
export function PlayerDot({ color }: { color?: number | null }) {
  if (!color) return null;
  return <span aria-hidden className="mr-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full align-middle" style={{ background: playerColorVar(color) }} />;
}

/** Barevná tečka hráče podle jeho id (barvy se načtou z `/api/stats/player-colors`). */
export function PlayerDotById({ userId }: { userId: string }) {
  return <PlayerDot color={usePlayerColors()[userId]} />;
}
