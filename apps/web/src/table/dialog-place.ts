import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Kam u stolu umístit rozhodovací okno (run it twice, ukázat / odhodit karty), aby nezakrývalo karty na stole ani pot.
 * Všechny souřadnice jsou svislé, v pixelech, vůči hornímu okraji stolu (místnosti).
 */
export interface DialogPlaceInput {
  /** Výška místnosti se stolem. */
  roomHeight: number;
  /** Střed stolu (board a pot): horní a dolní okraj. */
  boardTop: number;
  boardBottom: number;
  /** Výška okna (včetně případných hlášek nad ním). */
  dialogHeight: number;
  /** Kolik místa je pod / nad místností v okně prohlížeče (kam okno nejvýš vyčnívá mimo stůl). */
  spaceBelow: number;
  spaceAbove: number;
  /** Mezera mezi oknem a kartami. */
  gap?: number;
}

/**
 * Pořadí voleb: nad kartami uvnitř stolu (zakryje jen sedadla soupeřů), pod kartami uvnitř stolu, těsně pod stolem,
 * těsně nad stolem; když se nevejde nic, tam, kde zakryje nejméně karet.
 */
export function dialogTop(p: DialogPlaceInput): number {
  const gap = p.gap ?? 6;
  const h = p.dialogHeight;
  if (p.boardTop - gap - h >= 0) return p.boardTop - gap - h;
  if (p.roomHeight - p.boardBottom - gap >= h) return p.boardBottom + gap;
  if (p.spaceBelow >= h + gap) return p.roomHeight + gap;
  if (p.spaceAbove >= h + gap) return -(h + gap);
  const overlapAbove = Math.max(0, h - p.boardTop);
  const overlapBelow = Math.max(0, p.boardBottom - (p.roomHeight - h));
  return overlapAbove <= overlapBelow ? 0 : Math.max(0, p.roomHeight - h);
}

/**
 * Svislá poloha okna uvnitř místnosti se stolem (px od jejího horního okraje), přepočítaná po každém překreslení a při změně
 * velikosti: okno se drží mimo střed stolu s kartami a potem (viz `dialogTop`).
 */
export function useDialogTop(room: RefObject<HTMLElement | null>, center: RefObject<HTMLElement | null>, box: RefObject<HTMLElement | null>): number {
  const [top, setTop] = useState(0);
  const measure = useCallback(() => {
    const r = room.current;
    const c = center.current;
    const b = box.current;
    if (!r || !c || !b || r.offsetHeight === 0) return;
    const rr = r.getBoundingClientRect();
    const k = rr.height / r.offsetHeight || 1; // měřítko stolu (zámek velikosti může stůl škálovat)
    const next = Math.round(
      dialogTop({
        roomHeight: r.offsetHeight,
        boardTop: (c.getBoundingClientRect().top - rr.top) / k,
        boardBottom: (c.getBoundingClientRect().bottom - rr.top) / k,
        dialogHeight: b.offsetHeight,
        spaceBelow: (window.innerHeight - rr.bottom) / k,
        spaceAbove: rr.top / k,
      }),
    );
    setTop((cur) => (cur === next ? cur : next));
  }, [room, center, box]);
  useLayoutEffect(measure);
  useEffect(() => {
    const els = [room.current, center.current, box.current].filter((e): e is HTMLElement => !!e);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    els.forEach((e) => ro.observe(e));
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [room, center, box, measure]);
  return top;
}
