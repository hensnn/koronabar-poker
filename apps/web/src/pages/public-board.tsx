import { useCallback, useEffect, useState } from 'react';
import { t, type BoardColumn } from '@kb/shared';
import { ApiError, get } from '../api';

interface Row {
  rank: number;
  nickname: string;
  rankName?: string;
  rankIcon?: string;
  division?: string;
  [k: string]: unknown;
}
interface View {
  title: string;
  subtitle: string;
  columns: BoardColumn[];
  rows: Row[];
  currency: string;
  updatedAt: number;
  refreshSeconds: number;
}

const MONEY: BoardColumn[] = ['profit', 'cashProfit', 'tournamentProfit', 'bounty'];
const num = (n: number) => n.toLocaleString('cs-CZ');

function cell(col: BoardColumn, r: Row): string {
  const v = r[col];
  if (v === undefined || v === null) return '–';
  if (typeof v !== 'number') return String(v);
  if (col === 'avgPlace') return v.toFixed(1);
  if (MONEY.includes(col)) return `${v > 0 ? '+' : ''}${num(v)}`;
  return num(v);
}

/** Veřejná stránka přehledu hráčů: otevře se z tajného odkazu bez přihlášení, nikdy se neindexuje. */
export function PublicBoardPage({ token }: { token: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    get<View>(`/api/public/board/${encodeURIComponent(token)}`)
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

  if (error) {
    return (
      <main className="mx-auto max-w-xl p-4">
        <p role="alert" className="rounded-md border border-line bg-surface p-4 text-text">{error}</p>
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
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
      <header>
        <h1 className="text-xl font-bold text-text">{view.title}</h1>
        {view.subtitle && <p className="text-sm text-muted">{view.subtitle}</p>}
      </header>
      {view.rows.length === 0 ? (
        <p className="text-muted">{t('boards.public.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="px-2 py-2">{t('boards.col.rank')}</th>
                <th className="px-2 py-2">{t('boards.col.player')}</th>
                {view.columns.map((c) => (
                  <th key={c} className="px-2 py-2 text-right">{t(`boards.col.${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.rank} className="border-t border-line">
                  <td className="px-2 py-1 font-mono">{r.rank}</td>
                  <td className="px-2 py-1 font-semibold text-text">
                    {r.rankIcon ? `${r.rankIcon} ` : ''}
                    {r.nickname}
                  </td>
                  {view.columns.map((c) => {
                    const v = r[c];
                    const tone = MONEY.includes(c) && typeof v === 'number' ? (v > 0 ? 'text-success' : v < 0 ? 'text-danger' : '') : '';
                    return (
                      <td key={c} className={`px-2 py-1 text-right font-mono ${tone}`}>
                        {cell(c, r)}
                        {c === 'level' && r.rankName ? <span className="ml-1 font-sans text-xs text-muted">{r.rankName}</span> : null}
                        {c === 'rating' && r.division ? <span className="ml-1 font-sans text-xs text-muted">{r.division}</span> : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <footer className="text-xs text-muted">
        {t('boards.public.updated', { time: new Date(view.updatedAt).toLocaleString('cs-CZ') })} · {t('boards.public.footer')}
      </footer>
    </main>
  );
}
