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

/** Jsou poslední vteřiny tahu (zbývá víc než nic a nejvýš zadaný počet vteřin; 0 = upozornění vypnuté)? */
export function isUrgent(remainingMs: number, finalSeconds: number): boolean {
  return finalSeconds > 0 && remainingMs > 0 && remainingMs <= finalSeconds * 1000;
}

/** Hranice posledního upozornění (vteřiny) z osobního nastavení. */
function useFinalSeconds(): number {
  return Number(useSettings().values['ui.warnFinalSeconds'] ?? 0);
}

/** Podíl zbývajícího času (1 až 0) podle serverového termínu a příznak posledních vteřin. */
function useTimer(deadline: number | null, offset: number, bank: boolean): { frac: number; urgent: boolean } | null {
  const now = useNow(deadline !== null, RING_TICK_MS);
  const totalMs = useTurnTotalMs(bank);
  const finalSeconds = useFinalSeconds();
  const total = useRef(1);
  const last = useRef<number | null>(null);
  if (deadline === null) return null;
  const remaining = Math.max(0, deadline - (now + offset));
  if (last.current !== deadline) {
    last.current = deadline;
    // Stůl může mít delší tah, než říká nastavení (šablona, zavolaný čas…): celek nikdy nesmí být kratší než zbývající čas.
    total.current = Math.max(totalMs, remaining, 1);
  }
  return { frac: Math.min(1, remaining / total.current), urgent: isUrgent(remaining, finalSeconds) };
}

/** Jsou u tahu s daným termínem poslední vteřiny? Pro zvýraznění stavového řádku kolem odpočtu. */
export function useUrgent(deadline: number | null, offset: number): boolean {
  const now = useNow(deadline !== null, COUNTDOWN_TICK_MS);
  const finalSeconds = useFinalSeconds();
  return deadline !== null && isUrgent(deadline - (now + offset), finalSeconds);
}

/** Kruh kolem avataru: ubývá s časem, při time banku mění barvu, v posledních vteřinách zčervená a bliká. */
export function TimerRing({ deadline, offset, bank }: { deadline: number | null; offset: number; bank: boolean }) {
  const timer = useTimer(deadline, offset, bank);
  if (timer === null) return null;
  const r = 46;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full -rotate-90" aria-hidden>
      <circle cx="50" cy="50" r={r} fill="none" strokeWidth="6" strokeDasharray={c} strokeDashoffset={c * (1 - timer.frac)} className={timer.urgent ? 'stroke-timer-warn tk-timer-urgent' : bank ? 'stroke-timer-bank' : 'stroke-timer-ok'} />
    </svg>
  );
}

/** Proužek pod avatarem: alternativní styl časovače (token `timer.style`). */
export function TimerBar({ deadline, offset, bank }: { deadline: number | null; offset: number; bank: boolean }) {
  const timer = useTimer(deadline, offset, bank);
  if (timer === null) return null;
  return (
    <div className="tk-timer-bar" data-bank={bank} data-urgent={timer.urgent} aria-hidden>
      <span style={{ ['--p' as string]: String(timer.frac) }} />
    </div>
  );
}

/** Odpočet v sekundách; `warn` (jen u tahů) ho v posledních vteřinách zvýrazní. */
export function Countdown({ deadline, offset, warn = false }: { deadline: number | null; offset: number; warn?: boolean }) {
  const now = useNow(deadline !== null, COUNTDOWN_TICK_MS);
  const finalSeconds = useFinalSeconds();
  if (deadline === null) return null;
  const left = deadline - (now + offset);
  const urgent = warn && isUrgent(left, finalSeconds);
  return (
    <span className={`font-mono ${urgent ? 'tk-countdown-urgent' : ''}`} data-urgent={urgent}>
      {Math.max(0, Math.ceil(left / 1000))} s
    </span>
  );
}

/** Tenký pruh přes celou šířku: ubývá s časem hráče na tahu; při time banku mění barvu. Vedle je moje zbývající rezerva. */
export function TimeStrip({ deadline, offset, bank, reserve }: { deadline: number | null; offset: number; bank: boolean; reserve?: string }) {
  const timer = useTimer(deadline, offset, bank);
  return (
    <div className="flex items-center gap-2" aria-hidden>
      <div className="tk-timer-bar tk-timer-strip flex-1" data-bank={bank} data-urgent={timer?.urgent ?? false}>
        {timer !== null && <span style={{ ['--p' as string]: String(timer.frac) }} />}
      </div>
      {reserve && <span className="font-mono text-xs text-muted">⏱ {reserve}</span>}
    </div>
  );
}
