import type { CSSProperties, ReactNode } from 'react';
import { useRef } from 'react';
import { t } from '@kb/shared';

export interface ResizeLimits {
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Okno s tahacími úchyty na okrajích (šířka, výška, roh). Samo velikost nenastavuje, jen ji hlásí rodiči:
 * `onChange(w, h, commit)` se volá při tažení (commit = false) a po puštění (commit = true).
 * `w`/`h` = aktuální hodnota; 0 znamená automaticky (změří se z prvku). Dvojklik na úchyt vrátí výchozí velikost.
 */
export function Resizable({
  w,
  h,
  limits,
  side = 'right',
  resizeW = true,
  resizeH = true,
  onChange,
  onReset,
  className,
  style,
  as: Tag = 'div',
  children,
}: {
  w: number;
  h: number;
  limits: ResizeLimits;
  /** Na které straně je úchyt šířky (u chatu vpravo od stolu vlevo). */
  side?: 'left' | 'right';
  resizeW?: boolean;
  resizeH?: boolean;
  onChange: (w: number, h: number, commit: boolean) => void;
  onReset: () => void;
  className?: string;
  style?: CSSProperties;
  as?: 'div' | 'aside';
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);

  const start = (mode: 'w' | 'h' | 'both') => (e: React.PointerEvent<HTMLDivElement>) => {
    const el = box.current;
    if (!el) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const sw = w || el.offsetWidth;
    const sh = h || el.offsetHeight;
    const sign = side === 'left' ? -1 : 1;
    let cw = sw;
    let ch = sh;
    const move = (ev: PointerEvent) => {
      if (mode !== 'h') cw = clamp(Math.round(sw + (ev.clientX - sx) * sign), limits.minW, limits.maxW);
      if (mode !== 'w') ch = clamp(Math.round(sh + (ev.clientY - sy)), limits.minH, limits.maxH);
      onChange(cw, ch, false);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      onChange(cw, ch, true);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const grip = 'absolute z-10 touch-none bg-transparent hover:bg-primary';
  const title = t('table.resizeHint');
  const wEdge = side === 'left' ? 'left-0' : 'right-0';
  const corner = side === 'left' ? 'bottom-0 left-0 cursor-nesw-resize' : 'bottom-0 right-0 cursor-nwse-resize';
  return (
    <Tag ref={box as never} className={className} style={style}>
      {children}
      {resizeW && <div className={`${grip} ${wEdge} top-0 h-full w-1.5 cursor-ew-resize`} title={title} onPointerDown={start('w')} onDoubleClick={onReset} />}
      {resizeH && <div className={`${grip} bottom-0 left-0 h-1.5 w-full cursor-ns-resize`} title={title} onPointerDown={start('h')} onDoubleClick={onReset} />}
      {resizeW && resizeH && <div className={`${grip} ${corner} h-3 w-3`} title={title} onPointerDown={start('both')} onDoubleClick={onReset} />}
    </Tag>
  );
}
