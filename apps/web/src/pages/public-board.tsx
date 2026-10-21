import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { currencyWord, t, type BoardAppearance, type BoardColumn, type CurrencyForms } from '@kb/shared';
import { ApiError, get } from '../api';
import { BrandMark, useBrand } from '../brand';
import { MultiLineChart, type Pt } from './charts';

export interface BoardRow {
  rank: number;
  nickname: string;
  rankName?: string;
  rankIcon?: string;
  division?: string;
  [k: string]: unknown;
}
export interface BoardViewData {
  title: string;
  subtitle: string;
  columns: BoardColumn[];
  rows: BoardRow[];
  currencyForms: CurrencyForms;
  updatedAt: number;
  refreshSeconds: number;
  chart: { id: string; name: string; points: Pt[] }[];
  appearance: BoardAppearance;
}

const MONEY: BoardColumn[] = ['profit', 'cashProfit', 'tournamentProfit', 'bounty', 'balance'];
const SIGNED: BoardColumn[] = ['profit', 'cashProfit', 'tournamentProfit', 'bounty'];
const MEDALS = ['🥇', '🥈', '🥉'];
const num = (n: number) => n.toLocaleString('cs-CZ');

function cell(col: BoardColumn, r: BoardRow, forms: CurrencyForms): string {
  const v = r[col];
  if (v === undefined || v === null) return '–';
  if (typeof v !== 'number') return String(v);
  if (col === 'avgPlace') return v.toFixed(1);
  if (MONEY.includes(col)) return `${v > 0 && SIGNED.includes(col) ? '+' : ''}${num(v)} ${currencyWord(v, forms)}`;
  return num(v);
}

/** Ztmavení obrázku pozadí jako CSS proměnná (bez pevných hodnot v komponentě). */
const frameVars = (a: BoardAppearance, bgImage: string | null): CSSProperties => {
  const vars: Record<string, string> = { '--login-overlay': String(a.bgOverlayPercent / 100), '--login-blur': '0rem' };
  if (a.background === 'image' && bgImage) vars['--login-bg-url'] = `url(/api/public/brand/background?v=${bgImage})`;
  return vars as CSSProperties;
};

/**
 * Vzhled stránky přehledu hráčů podle nastavení (logo, pozadí, barva z motivu, šířka, hustota, zvýraznění nejlepších, patička).
 * Používá ho veřejná stránka i živý náhled ve správě (`preview`).
 */
export function BoardView({ view, bgImage, preview = false }: { view: BoardViewData; bgImage: string | null; preview?: boolean }) {
  const a = view.appearance;
  const brand = useBrand();
  const mode = a.background === 'image' && !bgImage ? 'felt' : a.background;
  const showLogo = a.logo && !!brand?.logo;
  return (
    <div className={`tk-login-bg tk-board-frame ${preview ? 'tk-board-preview' : ''}`} data-login-bg={mode} data-tone={a.tone} data-plate="card" style={frameVars(a, bgImage)}>
      <main className="tk-board-main" data-width={a.width} data-density={a.density} data-zebra={a.zebra ? '1' : '0'}>
        <header className={`tk-board-header ${a.header === 'card' ? 'tk-board-header-card' : ''}`}>
          {showLogo && (
            <div className="tk-login-brand">
              <h2 className="flex">
                <BrandMark large link={false} scalePercent={a.logoSizePercent} showName={false} />
              </h2>
            </div>
          )}
          <div>
            <h1 className="font-heading text-xl font-bold text-text">{view.title}</h1>
            {view.subtitle && <p className="text-sm text-muted">{view.subtitle}</p>}
          </div>
        </header>
        {view.rows.length === 0 ? (
          <p className="tk-board-empty">{t('boards.public.empty')}</p>
        ) : (
          <div className="tk-board-table overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="tk-board-cell">{t('boards.col.rank')}</th>
                  <th className="tk-board-cell">{t('boards.col.player')}</th>
                  {view.columns.map((c) => (
                    <th key={c} className="tk-board-cell text-right">
                      {t(`boards.col.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.rows.map((r) => {
                  const top = r.rank <= a.highlightTop;
                  return (
                    <tr key={r.rank} className={`tk-board-row ${top ? 'tk-board-top' : ''}`}>
                      <td className="tk-board-cell font-mono">{a.medals && r.rank <= MEDALS.length ? MEDALS[r.rank - 1] : r.rank}</td>
                      <td className="tk-board-cell font-semibold text-text">
                        {r.rankIcon ? `${r.rankIcon} ` : ''}
                        {r.nickname}
                      </td>
                      {view.columns.map((c) => {
                        const v = r[c];
                        const tone = SIGNED.includes(c) && typeof v === 'number' ? (v > 0 ? 'text-success' : v < 0 ? 'text-danger' : '') : '';
                        return (
                          <td key={c} className={`tk-board-cell text-right font-mono ${tone}`}>
                            {cell(c, r, view.currencyForms)}
                            {c === 'level' && r.rankName ? <span className="ml-1 font-sans text-xs text-muted">{r.rankName}</span> : null}
                            {c === 'rating' && r.division ? <span className="ml-1 font-sans text-xs text-muted">{r.division}</span> : null}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {view.chart.some((s) => s.points.length > 0) && (
          <section className="tk-board-chart" aria-label={t('boards.public.chart')}>
            <h2 className="mb-1 font-heading text-base font-bold text-text">{t('boards.public.chart')}</h2>
            <MultiLineChart series={view.chart} label={t('boards.public.chartHelp')} signed />
          </section>
        )}
        {(a.showUpdated || a.footerText) && (
          <footer className="tk-board-footer">
            {a.showUpdated && <span>{t('boards.public.updated', { time: new Date(view.updatedAt).toLocaleString('cs-CZ') })}</span>}
            {a.footerText && <span>{a.footerText}</span>}
          </footer>
        )}
      </main>
    </div>
  );
}

/** Veřejná stránka přehledu hráčů: otevře se z tajného odkazu bez přihlášení, nikdy se neindexuje. */
export function PublicBoardPage({ token }: { token: string }) {
  const brand = useBrand();
  const [view, setView] = useState<BoardViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    get<BoardViewData>(`/api/public/board/${encodeURIComponent(token)}`)
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? t('boards.public.notFound') : t('boards.public.error')));
  }, [token]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!view || view.refreshSeconds <= 0) return;
    const id = window.setInterval(load, Math.max(10, view.refreshSeconds) * 1000);
    return () => window.clearInterval(id);
  }, [view, load]);
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    if (view) document.title = view.title;
    return () => meta.remove();
  }, [view]);
  // Barevný režim přehledu (vždy světlý / vždy tmavý) platí jen na této stránce.
  const forced = view?.appearance.colorMode;
  useEffect(() => {
    if (!forced || forced === 'auto') return;
    const root = document.documentElement;
    const before = root.dataset.mode;
    root.dataset.mode = forced;
    const keep = window.setInterval(() => (root.dataset.mode = forced), 1000);
    return () => {
      window.clearInterval(keep);
      if (before) root.dataset.mode = before;
      else delete root.dataset.mode;
    };
  }, [forced]);

  if (error) {
    return (
      <main className="mx-auto max-w-xl p-4">
        <p role="alert" className="rounded-md border border-line bg-surface p-4 text-text">
          {error}
        </p>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="mx-auto max-w-xl p-4">
        <p className="text-muted">{t('boards.public.loading')}</p>
      </main>
    );
  }
  return <BoardView view={view} bgImage={brand?.loginBg ?? null} />;
}
