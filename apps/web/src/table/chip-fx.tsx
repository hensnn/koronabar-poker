import { useEffect, useRef, useState } from 'react';
import type { TableView } from '@kb/game-core';
import { ChipStack } from './Chips';

type Pos = { left: number; top: number };

export interface Sweep {
  key: number;
  from: Pos;
  to: Pos;
  amount: number;
}

/** Jak dlouho zůstane přelétávající hromádka v DOM (animace trvá kratší dobu a podle rychlosti animací). */
const SWEEP_LIFETIME_MS = 1600;

/**
 * Pohyb žetonů po kole sázení: když skončí ulice, sázky hráčů se „shrábnou“ do potu uprostřed;
 * když handa skončí, pot přeletí k výhercům. Sázky samotné zůstávají u hráčů, dokud ulice trvá (řeší je vykreslení stolu).
 */
export function useChipSweeps(view: TableView | undefined, enabled: boolean, pos: { bet: (seat: number) => Pos; seat: (seat: number) => Pos; pot: Pos }): Sweep[] {
  const prev = useRef<TableView | null>(null);
  const counter = useRef(0);
  const [sweeps, setSweeps] = useState<Sweep[]>([]);
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    if (!view) return;
    const p = prev.current;
    prev.current = view;
    if (!enabled || !p || !p.handId || p.handId !== view.handId) return;
    const add: Sweep[] = [];
    const where = posRef.current;
    // Konec ulice (nebo handy): sázky zmizely ze sedadel, takže se shrábnou do potu.
    if (view.street !== p.street || (view.winners && !p.winners)) {
      for (const s of p.seats) {
        const now = view.seats.find((x) => x.seat === s.seat);
        if (s.bet > 0 && (!now || now.bet === 0)) add.push({ key: ++counter.current, from: where.bet(s.seat), to: where.pot, amount: s.bet });
      }
    }
    // Výhra: pot přeletí k výhercům.
    if (view.winners && !p.winners) {
      for (const w of view.winners) add.push({ key: ++counter.current, from: where.pot, to: where.seat(w.seat), amount: w.amount });
    }
    if (add.length === 0) return;
    setSweeps((list) => [...list, ...add]);
    const keys = add.map((a) => a.key);
    // Při pomalejších animacích (nastavení rychlosti) žetony zůstanou o to déle.
    const speed = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tk-anim-speed')) || 1;
    window.setTimeout(() => setSweeps((list) => list.filter((x) => !keys.includes(x.key))), SWEEP_LIFETIME_MS / speed);
  }, [view, enabled]);
  return sweeps;
}

/** Vrstva přelétávajících hromádek žetonů nad stolem. */
export function ChipSweeps({ sweeps, unit }: { sweeps: Sweep[]; unit: number }) {
  return (
    <>
      {sweeps.map((s) => (
        <div key={s.key} className="tk-chip-sweep" style={{ left: `${s.from.left}%`, top: `${s.from.top}%`, ['--to-left' as string]: `${s.to.left}%`, ['--to-top' as string]: `${s.to.top}%` }}>
          <ChipStack amount={s.amount} unit={unit} />
        </div>
      ))}
    </>
  );
}
