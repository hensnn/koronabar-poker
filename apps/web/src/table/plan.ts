import { useEffect, useSyncExternalStore } from 'react';
import type { LegalActions, PlayerAction, TableView } from '@kb/game-core';
import { table } from '../net';

/** Plánovaný tah: hráč si ho zvolí dopředu, provede se sám, až bude na tahu (pokud je ještě platný). */
export type Plan = 'fold' | 'checkFold' | 'check' | 'call' | 'allIn';

/**
 * Plán je vázaný na stůl a handu: u jiného stolu ani v další handě se neprovede. Plán zvolený mezi handami
 * (`handId` null) platí pro příští handu a při jejím rozdání se k ní připne. U „Call“ se pamatuje částka,
 * kterou hráč viděl: když mezitím někdo navýší, plán se zruší, aby hráč nedorovnal víc, než chtěl.
 */
export interface PlanState {
  plan: Plan;
  tableId: string;
  handId: string | null;
  callAmount: number;
}

let state: PlanState | null = null;
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

/** Kolik by hráč teď musel dorovnat (nejvyšší sázka u stolu minus jeho vlastní); mimo tah to engine neposílá. */
export function currentCallAmount(view: TableView): number {
  const mine = view.seats.find((s) => s.seat === view.viewerSeat)?.bet ?? 0;
  const top = view.seats.reduce((m, s) => Math.max(m, s.bet), 0);
  return Math.max(0, top - mine);
}

/** Handa, ke které se plán váže: rozehraná handa; po jejím skončení (i během ukázání výsledku) už jde o příští handu (null). */
export function planTarget(view: TableView): string | null {
  return view.handId !== null && view.winners === null ? view.handId : null;
}

export function setPlan(next: Plan | null, ctx: { tableId: string; handId: string | null; callAmount?: number }): void {
  state = next ? { plan: next, tableId: ctx.tableId, handId: ctx.handId, callAmount: ctx.callAmount ?? 0 } : null;
  notify();
}

/** Plán zvolený pro tento stůl (u jiného stolu null). */
export function planFor(s: PlanState | null, tableId: string): Plan | null {
  return s && s.tableId === tableId ? s.plan : null;
}

export function usePlan(): PlanState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
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

/**
 * Co s plánem při novém stavu stolu: `keep` (čekat dál), `bind` (plán z přestávky připnout k právě rozdané handě),
 * `drop` (jiný stůl, jiná handa nebo navýšení nad plánovaný call), nebo akce k odeslání.
 */
export function stepPlan(s: PlanState, view: TableView, tableId: string): { kind: 'keep' } | { kind: 'bind'; handId: string } | { kind: 'drop' } | { kind: 'act'; action: PlayerAction | null } {
  if (s.tableId !== tableId) return { kind: 'drop' };
  if (s.handId === null) {
    const target = planTarget(view);
    return target === null ? { kind: 'keep' } : { kind: 'bind', handId: target };
  }
  if (view.handId !== s.handId) return { kind: 'drop' };
  if (!view.legal) return { kind: 'keep' };
  if (s.plan === 'call' && view.legal.callAmount > s.callAmount) return { kind: 'drop' };
  return { kind: 'act', action: resolvePlan(s.plan, view.legal) };
}

/** Provede plán, jakmile přijde tah; s jinou handou nebo jiným stolem se plán ruší. */
export function usePlanExecutor(view: TableView | undefined, tableId: string): void {
  const s = usePlan();
  useEffect(() => {
    if (!view || !s) return;
    const step = stepPlan(s, view, tableId);
    if (step.kind === 'keep') return;
    if (step.kind === 'bind') {
      setPlan(s.plan, { tableId, handId: step.handId, callAmount: s.callAmount });
      return;
    }
    setPlan(null, { tableId, handId: null });
    if (step.kind === 'act' && step.action) void table.act(tableId, step.action, view.handId);
  }, [view, s, tableId]);
}
