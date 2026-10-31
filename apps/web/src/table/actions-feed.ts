import { useEffect, useRef, useState } from 'react';
import type { TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { formatAmount } from './format';
import { onSocket } from '../net';
import type { FxEvent } from './fx';

export type SeatActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'reraise' | 'allIn';
export interface SeatAction {
  seat: number;
  kind: SeatActionKind;
  /** Celková sázka hráče na ulici („to“): u raise na kolik, u call kolik dorovnal. */
  amount: number;
  /** O kolik zvýšil nad dosud nejvyšší sázku (jen bet a raise). */
  by?: number;
  /** Kolikátá agrese na ulici to je (bet/raise; preflop se big blind počítá jako první): z toho „3-bet“, „4-bet“. */
  count?: number;
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
      if (s.bet > b.bet) {
        const kind = prevMax === 0 ? 'bet' : s.bet <= prevMax ? 'call' : 'raise';
        out.push({ seat: s.seat, kind, amount: s.bet, ...(kind === 'raise' ? { by: s.bet - prevMax } : {}) });
      }
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

/**
 * Text akce u stolu: bet „Bet 20“, raise „Raise → 57 (+37)“ (na kolik a o kolik), re-raise „3-bet → 120 (+63)“,
 * call a all-in s částkou, fold a check bez ní.
 */
export function actionLabel(a: SeatAction, view: TableView, inBb: boolean): string {
  const fmt = (n: number) => formatAmount(n, view.info, inBb);
  if (a.amount <= 0) return t(`table.${a.kind}`);
  const word = a.kind === 'reraise' && a.count ? t('table.nBet', { n: a.count }) : t(`table.${a.kind}`);
  if ((a.kind === 'raise' || a.kind === 'reraise') && a.by !== undefined && a.by > 0) return `${word} → ${fmt(a.amount)} (+${fmt(a.by)})`;
  return `${word} ${fmt(a.amount)}`;
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
        a.count = aggr.current.n;
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

/** Poslední události u stolu (akce hráčů, výhra, nová handa) jako krátké věty; pro přehled na telefonu. */
export function useActionLog(view: TableView | undefined, inBb: boolean, max = 3, tournamentId: string | null = null): { key: number; text: string; cards?: string[] }[] {
  const prev = useRef<TableView | null>(null);
  const counter = useRef(0);
  const [log, setLog] = useState<{ key: number; text: string; cards?: string[] }[]>([]);
  useEffect(() => {
    if (!view) return;
    const p = prev.current;
    prev.current = view;
    const nameOf = (seat: number) => view.seats.find((s) => s.seat === seat)?.name ?? '?';
    const lines: { text: string; cards?: string[] }[] = [];
    if (view.handId && p?.handId !== view.handId) lines.push({ text: t('table.log.newHand', { n: view.handNumber }) });
    for (const a of detectActions(p, view)) lines.push({ text: `${nameOf(a.seat)}: ${actionLabel(a, view, inBb)}` });
    if (view.winners && view.winners.length > 0 && !p?.winners) {
      const w = view.winners[0]!;
      lines.push({ text: `${nameOf(w.seat)} ${t('table.log.wins', { amount: formatAmount(w.amount, view.info, inBb) })}` });
    }
    if (lines.length > 0) setLog((l) => [...l, ...lines.map((x) => ({ key: ++counter.current, ...x }))].slice(-max));
  }, [view, inBb, max]);
  // Turnajové události (rebuy, add-on, vyřazení, level, odměny na hlavu) jako stručné řádky mezi akcemi.
  useEffect(() => {
    if (!tournamentId) return;
    const add = (text: string) => setLog((l) => [...l, { key: ++counter.current, text }].slice(-max));
    const offFx = onSocket<{ id: string; e: FxEvent }>('tournament:fx', (m) => {
      if (m.id !== tournamentId) return;
      const e = m.e;
      if (e.type === 'rebuy' || e.type === 'addon' || e.type === 'reentry') add(t(`table.log.${e.type}`, { name: e.name }));
      else if (e.type === 'knockout') add(t('table.log.knockout', { by: e.by.join(', '), victim: e.victim }) + (e.amount > 0 ? t('table.log.knockoutBounty', { amount: e.amount }) : ''));
      else if (e.type === 'eliminated') add(t('table.log.eliminated', { name: e.name, remaining: e.remaining }));
      else if (e.type === 'level') add(t('table.log.level', { level: e.level, sb: e.smallBlind, bb: e.bigBlind }));
      else if (e.type === 'bubble') add(t('table.log.bubble'));
      else if (e.type === 'finished') add(t('table.log.finished', { name: e.results[0]?.name ?? '' }));
    });
    const offLog = onSocket<{ id: string; kind: string; target: string; amount: number; winners: string[] }>('tournament:log', (m) => {
      if (m.id === tournamentId && m.kind === 'headBounty') add(t('table.log.headBounty', { target: m.target, amount: m.amount, winners: m.winners.join(', ') }));
    });
    return () => {
      offFx();
      offLog();
    };
  }, [tournamentId, max]);
  return log;
}
