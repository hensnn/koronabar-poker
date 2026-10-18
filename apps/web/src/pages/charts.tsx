import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { t } from '@kb/shared';

export type Pt = [number, number];

const H = 190;
const DEFAULT_W = 600;
const PAD = { l: 48, r: 10, t: 10, b: 24 };
/** Skutečná šířka kontejneru v pixelech: graf se kreslí v jeho měřítku, takže texty nejsou zdeformované a vyplní celou šířku karty. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(DEFAULT_W);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setW(Math.max(240, Math.round(el.getBoundingClientRect().width)));
    apply();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  return [ref, w];
}

const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
const fmtFull = (ts: number) => new Date(ts).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtNum = (n: number) => (Math.abs(n) >= 10_000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

/** „Hezké“ krajní hodnoty a 4 popisky osy y. */
function ticks(min: number, max: number): number[] {
  if (min === max) return [min - 1, min, min + 1];
  const step = (max - min) / 3;
  return [0, 1, 2, 3].map((i) => min + step * i);
}

/**
 * Spojnicový graf v čase: osy s popisky, vyplněná plocha, nulová čára (když je v rozsahu), poslední hodnota
 * a podrobnost při najetí myší / klepnutí. Barvu určuje `className` (text-*), takže vše jde přes design tokeny.
 */
export function LineChart({ points, label, className = 'text-primary', signed = false }: { points: Pt[]; label: string; className?: string; signed?: boolean }) {
  const id = useId();
  const [boxRef, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const geo = useMemo(() => {
    if (points.length === 0) return null;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    let y0 = Math.min(...ys);
    let y1 = Math.max(...ys);
    if (signed) {
      y0 = Math.min(y0, 0);
      y1 = Math.max(y1, 0);
    }
    const pad = (y1 - y0) * 0.08 || 1;
    y0 -= pad;
    y1 += pad;
    const sx = (x: number) => PAD.l + (x1 === x0 ? (W - PAD.l - PAD.r) / 2 : ((x - x0) / (x1 - x0)) * (W - PAD.l - PAD.r));
    const sy = (y: number) => PAD.t + (1 - (y - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
    return { x0, x1, y0, y1, sx, sy };
  }, [points, signed, W]);
  if (!geo || points.length === 0) return <p className="text-sm text-muted">{t('charts.noData')}</p>;
  const { sx, sy } = geo;
  const line = points.map((p) => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  const area = `${sx(points[0]![0]).toFixed(1)},${sy(geo.y0).toFixed(1)} ${line} ${sx(points[points.length - 1]![0]).toFixed(1)},${sy(geo.y0).toFixed(1)}`;
  const last = points[points.length - 1]!;
  const h = hover !== null ? points[hover]! : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    let bd = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(sx(p[0]) - x);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  };
  return (
    <figure className={className}>
      <div ref={boxRef} className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full touch-pan-y" role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)} onPointerDown={onMove}>
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks(geo.y0 + (geo.y1 - geo.y0) * 0.08, geo.y1 - (geo.y1 - geo.y0) * 0.08).map((v, i) => (
          <g key={i} className="text-muted">
            <line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} stroke="currentColor" strokeOpacity="0.18" />
            <text x={PAD.l - 6} y={sy(v) + 3} textAnchor="end" fontSize="10" fill="currentColor">
              {fmtNum(v)}
            </text>
          </g>
        ))}
        {geo.y0 < 0 && geo.y1 > 0 && <line x1={PAD.l} x2={W - PAD.r} y1={sy(0)} y2={sy(0)} stroke="currentColor" strokeOpacity="0.5" strokeDasharray="4 3" className="text-text" />}
        {(geo.x0 === geo.x1 ? [geo.x0] : [geo.x0, (geo.x0 + geo.x1) / 2, geo.x1]).map((v, i, arr) => (
          <text key={i} x={sx(v)} y={H - 6} textAnchor={arr.length === 1 ? 'middle' : i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle'} fontSize="10" fill="currentColor" className="text-muted">
            {fmtDate(v)}
          </text>
        ))}
        <polygon points={area} fill={`url(#g${id})`} />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <circle cx={sx(last[0])} cy={sy(last[1])} r="3.5" fill="currentColor" />
        {h && (
          <g>
            <line x1={sx(h[0])} x2={sx(h[0])} y1={PAD.t} y2={H - PAD.b} stroke="currentColor" strokeOpacity="0.4" />
            <circle cx={sx(h[0])} cy={sy(h[1])} r="4.5" fill="currentColor" />
          </g>
        )}
      </svg>
      </div>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-text">
        <span className="text-muted">{label}</span>
        <span className="font-mono">{h ? `${fmtFull(h[0])}: ${signed && h[1] > 0 ? '+' : ''}${Math.round(h[1])}` : `${signed && last[1] > 0 ? '+' : ''}${Math.round(last[1])}`}</span>
      </figcaption>
    </figure>
  );
}

/** Sloupcový graf (výsledek po hrách nebo dnech): kladné sloupce zeleně, záporné červeně, s nulovou čárou. */
export function BarChart({ bars, label }: { bars: { x: number; v: number; tip: string }[]; label: string }) {
  const [boxRef, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  if (bars.length === 0) return <p className="text-sm text-muted">{t('charts.noData')}</p>;
  const max = Math.max(1, ...bars.map((b) => Math.abs(b.v)));
  const innerH = H - PAD.t - PAD.b;
  const zero = PAD.t + innerH / 2;
  const bw = Math.max(2, Math.min(24, (W - PAD.l - PAD.r) / bars.length - 2));
  const gap = (W - PAD.l - PAD.r - bw * bars.length) / Math.max(1, bars.length);
  const h = hover !== null ? bars[hover]! : null;
  return (
    <figure>
      <div ref={boxRef} className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full touch-pan-y" role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
        <g className="text-muted">
          <text x={PAD.l - 6} y={PAD.t + 8} textAnchor="end" fontSize="10" fill="currentColor">
            {fmtNum(max)}
          </text>
          <text x={PAD.l - 6} y={H - PAD.b} textAnchor="end" fontSize="10" fill="currentColor">
            {fmtNum(-max)}
          </text>
          <line x1={PAD.l} x2={W - PAD.r} y1={zero} y2={zero} stroke="currentColor" strokeOpacity="0.5" />
        </g>
        {bars.map((b, i) => {
          const hh = (Math.abs(b.v) / max) * (innerH / 2);
          const x = PAD.l + i * (bw + gap) + gap / 2;
          return (
            <rect
              key={i}
              x={x}
              y={b.v >= 0 ? zero - hh : zero}
              width={bw}
              height={Math.max(1, hh)}
              fill="currentColor"
              className={b.v >= 0 ? 'text-success' : 'text-danger'}
              opacity={hover === null || hover === i ? 1 : 0.55}
              onPointerEnter={() => setHover(i)}
              onPointerDown={() => setHover(i)}
            />
          );
        })}
        {(bars.length === 1 ? [bars[0]!] : [bars[0]!, bars[bars.length - 1]!]).map((b, i) => (
          <text key={i} x={bars.length === 1 ? W / 2 : i === 0 ? PAD.l : W - PAD.r} y={H - 6} textAnchor={bars.length === 1 ? 'middle' : i === 0 ? 'start' : 'end'} fontSize="10" fill="currentColor" className="text-muted">
            {fmtDate(b.x)}
          </text>
        ))}
      </svg>
      </div>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="text-muted">{label}</span>
        <span className="font-mono">{h ? h.tip : ''}</span>
      </figcaption>
    </figure>
  );
}
