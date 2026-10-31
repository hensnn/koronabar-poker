import { useEffect, useRef, useState } from 'react';

/**
 * Plynulé přičtení čísla: když `enabled` a hodnota vzroste, zobrazená hodnota se během `ms` dorovná; jinak se mění hned.
 * Pomáhá vidět dopad výhry na stack vítěze.
 */
export function useRollingNumber(target: number, enabled: boolean, ms: number): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (!enabled || ms <= 0 || target <= from.current) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    const base = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = Math.round(base + (target - base) * eased);
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled, ms]);
  return shown;
}
