import { useEffect, useSyncExternalStore } from 'react';
import type { LegalActions, PlayerAction, TableView } from '@kb/game-core';
import { table } from '../net';

/** Plánovaný tah: hráč si ho zvolí dopředu, provede se sám, až bude na tahu (pokud je ještě platný). */
export type Plan = 'fold' | 'checkFold' | 'check' | 'call';

let plan: Plan | null = null;
let planHand: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function setPlan(next: Plan | null, handId: string | null): void {
  plan = next;
  planHand = handId;
  notify();
}

export function usePlan(): Plan | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => plan,
  );
}

/** Akce odpovídající plánu podle toho, co je právě dovolené; null = plán už nejde splnit. */
export function resolvePlan(p: Plan, legal: LegalActions): PlayerAction | null {
  switch (p) {
    case 'fold':
      return legal.canFold ? { type: 'fold' } : null;
    case 'checkFold':
      return legal.canCheck ? { type: 'check' } : legal.canFold ? { type: 'fold' } : null;
    case 'check':
      return legal.canCheck ? { type: 'check' } : null;
    case 'call':
      return legal.canCheck ? { type: 'check' } : legal.callAmount > 0 ? { type: 'call' } : null;
  }
}

/** Provede plán, jakmile přijde tah; s novou handou se plán ruší. */
export function usePlanExecutor(view: TableView | undefined, tableId: string): void {
  const p = usePlan();
  useEffect(() => {
    if (!view) return;
    if (planHand !== null && view.handId !== planHand) {
      setPlan(null, null);
      return;
    }
    if (!p || !view.legal) return;
    const action = resolvePlan(p, view.legal);
    setPlan(null, null);
    if (action) void table.act(tableId, action);
  }, [view, p, tableId]);
}
