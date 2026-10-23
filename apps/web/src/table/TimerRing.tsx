import { useEffect, useRef, useState } from 'react';

/** Podíl zbývajícího času (1 až 0) podle serverového termínu. */
function useFraction(deadline: number | null, offset: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  const total = useRef(1);
  const last = useRef<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  if (deadline === null) return null;
  const remaining = Math.max(0, deadline - (now + offset));
  if (last.current !== deadline) {
    last.current = deadline;
    total.current = Math.max(1, remaining);
  }
  return Math.min(1, remaining / total.current);
}

/** Kruh kolem avataru: ubývá s časem, při time banku mění barvu. */
export function TimerRing({ deadline, offset, bank }: { deadline: number | null; offset: number; bank: boolean }) {
  const frac = useFraction(deadline, offset);
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
  const frac = useFraction(deadline, offset);
  if (frac === null) return null;
  return (
    <div className="tk-timer-bar" data-bank={bank} aria-hidden>
      <span style={{ ['--p' as string]: String(frac) }} />
    </div>
  );
}

export function Countdown({ deadline, offset }: { deadline: number | null; offset: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  if (deadline === null) return null;
  return <span className="font-mono">{Math.max(0, Math.ceil((deadline - (now + offset)) / 1000))} s</span>;
}

/** Tenký pruh přes celou šířku: ubývá s časem hráče na tahu; při time banku mění barvu. Vedle je moje zbývající rezerva. */
export function TimeStrip({ deadline, offset, bank, reserve }: { deadline: number | null; offset: number; bank: boolean; reserve?: string }) {
  const frac = useFraction(deadline, offset);
  return (
    <div className="flex items-center gap-2" aria-hidden>
      <div className="tk-timer-bar tk-timer-strip flex-1" data-bank={bank}>
        {frac !== null && <span style={{ ['--p' as string]: String(frac) }} />}
      </div>
      {reserve && <span className="font-mono text-xs text-muted">⏱ {reserve}</span>}
    </div>
  );
}
