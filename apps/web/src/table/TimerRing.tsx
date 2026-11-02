import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../settings';

/** Jak často se odpočet překresluje (ms): kruh a proužek plynule, číslo stačí po čtvrtvteřinách. */
const RING_TICK_MS = 100;
const COUNTDOWN_TICK_MS = 250;

/** Aktuální čas, který se obnovuje jen dokud běží nějaký termín; bez termínu interval neběží. */
function useNow(active: boolean, tickMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [active, tickMs]);
  return now;
}

/**
 * Celková délka tahu (ms) podle nastavení: základní čas, při time banku rezerva. Pohled na stůl délku tahu nenese,
 * takže při otevření stolu uprostřed tahu by kruh začínal na 100 % a ubýval rychleji; takhle ukazuje skutečný podíl.
 */
function useTurnTotalMs(bank: boolean): number {
  const values = useSettings().values;
  const seconds = Number(values[bank ? 'time.timeBankSeconds' : 'time.turnSeconds'] ?? 0);
  return Math.max(1, seconds) * 1000;
}

/** Podíl zbývajícího času (1 až 0) podle serverového termínu. */
function useFraction(deadline: number | null, offset: number, bank: boolean): number | null {
  const now = useNow(deadline !== null, RING_TICK_MS);
  const totalMs = useTurnTotalMs(bank);
  const total = useRef(1);
  const last = useRef<number | null>(null);
  if (deadline === null) return null;
  const remaining = Math.max(0, deadline - (now + offset));
  if (last.current !== deadline) {
    last.current = deadline;
    // Stůl může mít delší tah, než říká nastavení (šablona, zavolaný čas…): celek nikdy nesmí být kratší než zbývající čas.
    total.current = Math.max(totalMs, remaining, 1);
  }
  return Math.min(1, remaining / total.current);
}

/** Kruh kolem avataru: ubývá s časem, při time banku mění barvu. */
export function TimerRing({ deadline, offset, bank }: { deadline: number | null; offset: number; bank: boolean }) {
  const frac = useFraction(deadline, offset, bank);
  if (frac === null) return null;
  const r = 46;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full -rotate-90" aria-hidden>
      <circle cx="50" cy="50" r={r} fill="none" strokeWidth="6" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} className={bank ? 'stroke-timer-bank' : 'stroke-timer-ok'} />
    </svg>
  );
}

/** Proužek pod avatarem: alternativní styl časovače (token `timer.style`). */
export function TimerBar({ deadline, offset, bank }: { deadline: number | null; offset: number; bank: boolean }) {
  const frac = useFraction(deadline, offset, bank);
  if (frac === null) return null;
  return (
    <div className="tk-timer-bar" data-bank={bank} aria-hidden>
      <span style={{ ['--p' as string]: String(frac) }} />
    </div>
  );
}

export function Countdown({ deadline, offset }: { deadline: number | null; offset: number }) {
  const now = useNow(deadline !== null, COUNTDOWN_TICK_MS);
  if (deadline === null) return null;
  return <span className="font-mono">{Math.max(0, Math.ceil((deadline - (now + offset)) / 1000))} s</span>;
}

/** Tenký pruh přes celou šířku: ubývá s časem hráče na tahu; při time banku mění barvu. Vedle je moje zbývající rezerva. */
export function TimeStrip({ deadline, offset, bank, reserve }: { deadline: number | null; offset: number; bank: boolean; reserve?: string }) {
  const frac = useFraction(deadline, offset, bank);
  return (
    <div className="flex items-center gap-2" aria-hidden>
      <div className="tk-timer-bar tk-timer-strip flex-1" data-bank={bank}>
        {frac !== null && <span style={{ ['--p' as string]: String(frac) }} />}
      </div>
      {reserve && <span className="font-mono text-xs text-muted">⏱ {reserve}</span>}
    </div>
  );
}
