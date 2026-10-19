import { useLayoutEffect, useRef } from 'react';

const MARGIN = 8;

/** O kolik pixelů posunout nabídku (vodorovně), aby celá ležela v šířce okna s malým okrajem. Čistá funkce kvůli testu. */
export function fitShift(left: number, right: number, width: number, margin = MARGIN): number {
  let dx = 0;
  if (right > width - margin) dx = width - margin - right;
  if (left + dx < margin) dx = margin - left;
  return dx;
}

/**
 * Rozbalovací nabídka, která se nikdy nerozbalí mimo okno: po otevření se změří a v případě potřeby posune doleva nebo doprava
 * tak, aby celá ležela v zobrazené oblasti. Posun se nastavuje přímo na prvku (ne přes styl v JSX).
 */
export function useKeepInView<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = '';
    if (!open) return;
    const fit = () => {
      el.style.transform = '';
      const r = el.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const dx = fitShift(r.left, r.right, width);
      if (dx !== 0) el.style.transform = `translateX(${Math.round(dx)}px)`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open]);
  return ref;
}
