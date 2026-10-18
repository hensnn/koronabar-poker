import { useEffect, useRef, useState } from 'react';
import type { TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { formatAmount } from './format';

export type SeatActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'reraise' | 'allIn';
export interface SeatAction {
  seat: number;
  kind: SeatActionKind;
  amount: number;
}

/** Odvodí akce hráčů z rozdílu dvou pohledů na stůl (server posílá jen stav, ne události). Čistá funkce. */
export function detectActions(prev: TableView | null, next: TableView): SeatAction[] {
  if (!prev || prev.handId !== next.handId || !next.handId) return [];
  const out: SeatAction[] = [];
  const prevMax = Math.max(0, ...prev.seats.map((s) => s.bet));
  const sameStreet = prev.street === next.street;
  for (const s of next.seats) {
    const b = prev.seats.find((x) => x.seat === s.seat);
    if (!b) continue;
    if (s.status === 'folded' && b.status !== 'folded') {
      out.push({ seat: s.seat, kind: 'fold', amount: 0 });
      continue;
    }
    if (s.status === 'allIn' && b.status !== 'allIn') {
      out.push({ seat: s.seat, kind: 'allIn', amount: sameStreet ? s.bet : b.bet });
      continue;
    }
    if (sameStreet) {
      if (s.bet > b.bet) out.push({ seat: s.seat, kind: prevMax === 0 ? 'bet' : s.bet <= prevMax ? 'call' : 'raise', amount: s.bet });
      else if (prev.actingSeat === s.seat && next.actingSeat !== s.seat && s.bet === b.bet && s.status === b.status) out.push({ seat: s.seat, kind: 'check', amount: 0 });
    } else if (prev.actingSeat === s.seat && s.status === b.status) {
      // Akce, která uzavřela ulici: sázky už jsou smetené do potu, takže se pozná jen podle předchozího stavu.
      if (b.bet < prevMax) out.push({ seat: s.seat, kind: 'call', amount: prevMax });
      else out.push({ seat: s.seat, kind: 'check', amount: 0 });
    }
  }
  return out;
}

/**
 * Kolikátá agrese (bet/raise) na ulici to je. Preflop se big blind počítá jako první (začíná se jedničkou),
 * takže raise nad blindem je druhá agrese a další raise už je re-raise; postflop bet je první, raise druhá.
 */
export function aggressionStart(street: TableView['street']): number {
  return street === 'PREFLOP' ? 1 : 0;
}

/** Třetí a další agrese na ulici je re-raise (3-bet a výš). */
export function classifyAggression(kind: SeatActionKind, count: number): SeatActionKind {
  return kind === 'raise' && count >= 3 ? 'reraise' : kind;
}

export function actionLabel(a: SeatAction, view: TableView, inBb: boolean): string {
  const word = t(`table.${a.kind}`);
  return a.amount > 0 ? `${word} ${formatAmount(a.amount, view.info, inBb)}` : word;
}

export interface Bubble {
  key: number;
  text: string;
  kind: SeatActionKind;
}

/** Bubliny s poslední akcí u každého sedadla; mizí po pár vteřinách. */
export function useActionBubbles(view: TableView | undefined, inBb: boolean, ttlMs = 2600): Record<number, Bubble> {
  const prev = useRef<TableView | null>(null);
  const counter = useRef(0);
  const aggr = useRef<{ handId: string | null; street: TableView['street']; n: number }>({ handId: null, street: null, n: 0 });
  const [bubbles, setBubbles] = useState<Record<number, Bubble>>({});
  useEffect(() => {
    if (!view) return;
    // Konec sázkového kola nebo nová handa: staré bubliny zmizí hned.
    const roundOver = !!prev.current && (prev.current.street !== view.street || prev.current.handId !== view.handId);
    const actions = detectActions(prev.current, view);
    prev.current = view;
    if (aggr.current.handId !== view.handId || aggr.current.street !== view.street) aggr.current = { handId: view.handId, street: view.street, n: aggressionStart(view.street) };
    for (const a of actions) {
      if (a.kind === 'bet' || a.kind === 'raise') {
        aggr.current.n += 1;
        a.kind = classifyAggression(a.kind, aggr.current.n);
      }
    }
    if (roundOver) setBubbles({});
    if (actions.length === 0) return;
    const added: Record<number, Bubble> = {};
    for (const a of actions) added[a.seat] = { key: ++counter.current, text: actionLabel(a, view, inBb), kind: a.kind };
    setBubbles((b) => ({ ...b, ...added }));
    // Časovač se neruší při dalším překreslení (jinak by při živé hře bubliny nikdy nezmizely); odstraní jen „své“ bubliny.
    window.setTimeout(() => setBubbles((b) => Object.fromEntries(Object.entries(b).filter(([seat, v]) => added[Number(seat)]?.key !== v.key))), ttlMs);
  }, [view, inBb, ttlMs]);
  return bubbles;
}
