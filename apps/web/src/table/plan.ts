import { useEffect, useSyncExternalStore } from 'react';
import type { LegalActions, PlayerAction, TableView } from '@kb/game-core';
import { table } from '../net';

/** Plánovaný tah: hráč si ho zvolí dopředu, provede se sám, až bude na tahu (pokud je ještě platný). */
export type Plan = 'fold' | 'checkFold' | 'check' | 'call' | 'allIn';

let plan: Plan | null = null;
let planHand: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Plánované tahy v pořadí, v jakém se nabízejí; které se zobrazí, určují osobní nastavení `ui.plan*`. */
export const PLAN_OPTIONS: { plan: Plan; setting: string }[] = [
  { plan: 'fold', setting: 'ui.planFold' },
  { plan: 'checkFold', setting: 'ui.planCheckFold' },
  { plan: 'check', setting: 'ui.planCheck' },
  { plan: 'call', setting: 'ui.planCall' },
  { plan: 'allIn', setting: 'ui.planAllIn' },
];

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
    case 'allIn':
      return legal.canBet || legal.canRaise || legal.callAmount > 0 ? { type: 'allIn' } : null;
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
