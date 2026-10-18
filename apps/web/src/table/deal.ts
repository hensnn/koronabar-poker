import { useEffect, useRef, useState } from 'react';
import type { TableView } from '@kb/game-core';
import { useSettings } from '../settings';
import { playSfx } from './sfx';

/** Pořadí rozdávání: od prvního obsazeného místa po tlačítku po směru hodinových ručiček. Jen hráči s kartami. */
export function dealOrder(seats: { seat: number; hasCards: boolean }[], buttonSeat: number | null): number[] {
  const withCards = seats.filter((s) => s.hasCards).map((s) => s.seat).sort((a, b) => a - b);
  if (withCards.length === 0) return [];
  const start = buttonSeat === null ? 0 : withCards.findIndex((s) => s > buttonSeat);
  const from = start < 0 ? 0 : start;
  return [...withCards.slice(from), ...withCards.slice(0, from)];
}

/** Číslo „kroku“ rozdání každé karty: nejdřív každý dostane první kartu, pak druhou (jako u skutečného rozdávání). */
export function dealSlots(order: number[], cardsPerPlayer = 2): Map<string, number> {
  const slots = new Map<string, number>();
  for (let round = 0; round < cardsPerPlayer; round++) order.forEach((seat, i) => slots.set(`${seat}:${round}`, round * order.length + i));
  return slots;
}

export interface DealTiming {
  /** Zpoždění první karty (po zazvučení míchání). */
  startMs: number;
  /** Odstup mezi kartami. */
  stepMs: number;
  /** Celková doba rozdání. */
  totalMs: number;
}

/** Odstup mezi kartami podle nastavení, ale celé rozdání nikdy nepřekročí `maxMs` (u plného stolu se karty rozdávají rychleji). */
export function dealTiming(cardCount: number, stepSetting: number, maxMs = 4000, startMs = 650): DealTiming {
  const step = cardCount > 0 ? Math.max(40, Math.min(stepSetting, Math.floor((maxMs - startMs) / cardCount))) : stepSetting;
  return { startMs, stepMs: step, totalMs: startMs + step * cardCount };
}

/** Kam má karta „doletět“ od rozdávajícího: posun v procentech šířky stolu (vodorovně i svisle). */
export function flyOffset(from: { left: number; top: number }, to: { left: number; top: number }): { dx: number; dy: number } {
  return { dx: from.left - to.left, dy: from.top - to.top };
}

export interface DealState {
  active: boolean;
  timing: DealTiming;
  /** Zpoždění dané karty v ms, nebo undefined, když se nerozdává. */
  delayMs: (seat: number, cardIndex: number) => number | undefined;
}

/**
 * Animace a zvuk rozdávání nové handy. Spustí se jen při přechodu na další handu (ne při otevření stolu uprostřed handy)
 * a jen když je zapnutá v osobním nastavení. Zvuk míchání dělá `useTableSfx`, tady zní každá rozdaná karta.
 */
export function useDealAnimation(view: TableView | undefined): DealState {
  const values = useSettings().values;
  const enabled = values['ui.dealAnimation'] !== false && values['ui.reducedMotion'] !== true;
  const stepSetting = Number(values['ui.dealCardMs'] ?? 280);
  const [, setTick] = useState(0);
  const lastHand = useRef<string | null | undefined>(undefined);
  const started = useRef(0);
  const slots = useRef<Map<string, number>>(new Map());
  const timing = useRef<DealTiming>(dealTiming(0, stepSetting));
  const volume = Number(values['ui.sfxVolumePercent'] ?? 60) / 100;
  const sound = values['ui.sfxEnabled'] !== false && values['ui.sfxDeal'] !== false;
  const cfg = useRef({ sound, volume });
  cfg.current = { sound, volume };

  // Nová handa se pozná při vykreslení (karty se mají rozdat hned, ne o snímek později).
  const handId = view?.handId ?? null;
  if (view && handId !== lastHand.current) {
    const first = lastHand.current === undefined;
    lastHand.current = handId;
    if (!first && handId && enabled && view.street === 'PREFLOP') {
      const order = dealOrder(view.seats, view.buttonSeat);
      slots.current = dealSlots(order);
      timing.current = dealTiming(order.length * 2, stepSetting);
      started.current = Date.now();
    } else {
      started.current = 0;
      slots.current = new Map();
    }
  }
  const active = started.current > 0 && Date.now() - started.current < timing.current.totalMs + 600;

  // Zvuk každé rozdané karty.
  useEffect(() => {
    if (!active || started.current === 0) return;
    const ids: number[] = [];
    const { startMs, stepMs } = timing.current;
    const count = slots.current.size;
    for (let i = 0; i < count; i++) ids.push(window.setTimeout(() => cfg.current.sound && playSfx('dealCard', cfg.current.volume), startMs + i * stepMs));
    // po skončení rozdávání se stůl překreslí, aby se odemkla akční lišta
    ids.push(window.setTimeout(() => setTick((n) => n + 1), timing.current.totalMs + 650));
    return () => ids.forEach((id) => window.clearTimeout(id));
    // jen jednou pro každou handu
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handId]);

  return {
    active,
    timing: timing.current,
    delayMs: (seat, cardIndex) => {
      if (!active) return undefined;
      const slot = slots.current.get(`${seat}:${cardIndex}`);
      return slot === undefined ? undefined : timing.current.startMs + slot * timing.current.stepMs;
    },
  };
}
