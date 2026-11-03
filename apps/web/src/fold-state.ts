import { useCallback } from 'react';
import { resolveFor, saveUserSetting, useSettings } from './settings';

/** Osobní nastavení s pamětí zabalených a rozbalených karet: jen odchylky od výchozího stavu, `1` = rozbaleno, `0` = zabaleno. */
export const FOLD_KEY = 'ui.foldState';
/** Rezerva pod limitem nastavení (4000 znaků); nejstarší záznamy se při přetečení zapomenou. */
const MAX_CHARS = 3800;

type FoldMap = Record<string, 0 | 1>;

let lastRaw: unknown;
let lastMap: FoldMap = {};

function parse(raw: unknown): FoldMap {
  if (raw === lastRaw) return lastMap;
  let out: FoldMap = {};
  if (typeof raw === 'string' && raw) {
    try {
      const j = JSON.parse(raw) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        out = Object.fromEntries(Object.entries(j as Record<string, unknown>).filter(([, v]) => v === 0 || v === 1)) as FoldMap;
      }
    } catch {
      out = {};
    }
  }
  lastRaw = raw;
  lastMap = out;
  return out;
}

/** Je karta rozbalená? Bez uložené volby platí výchozí stav. */
export function isFoldOpen(raw: unknown, id: string, def: boolean): boolean {
  const v = parse(raw)[id];
  return v === undefined ? def : v === 1;
}

/** Nový zápis stavu po změně karet: stav shodný s výchozím se neukládá, nejstarší záznamy se při přetečení zahodí. */
export function withFolds(raw: unknown, changes: { id: string; open: boolean; def: boolean }[]): string {
  const map: FoldMap = { ...parse(raw) };
  for (const c of changes) {
    delete map[c.id];
    if (c.open !== c.def) map[c.id] = c.open ? 1 : 0;
  }
  let text = JSON.stringify(map);
  const keys = Object.keys(map);
  while (text.length > MAX_CHARS && keys.length > 0) {
    delete map[keys.shift()!];
    text = JSON.stringify(map);
  }
  return Object.keys(map).length === 0 ? '' : text;
}

/** Uloží stav více karet najednou (např. „rozbalit vše“). Platí pro typ zařízení (telefon a počítač mají každý svou volbu). */
export function setFolds(changes: { id: string; open: boolean; def: boolean }[]): void {
  void saveUserSetting(FOLD_KEY, withFolds(resolveFor().values[FOLD_KEY], changes), true).catch(() => undefined);
}

/** Rozbalení karty s pamětí: výchozí stav, dokud si hráč nezvolí jinak; volba se ukládá do osobního nastavení. */
export function useFold(id: string, def: boolean): [boolean, (open: boolean) => void] {
  const raw = useSettings().values[FOLD_KEY];
  const open = isFoldOpen(raw, id, def);
  const set = useCallback((next: boolean) => setFolds([{ id, open: next, def }]), [id, def]);
  return [open, set];
}

/** Část adresy, podle které se karty pamatují: stránka (u správy podstránka), ne konkrétní položka. */
export function foldScope(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'admin') return parts.slice(0, 2).join('/');
  return parts[0] ?? 'domu';
}
