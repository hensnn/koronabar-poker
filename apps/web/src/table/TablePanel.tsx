import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { get } from '../api';
import { onSocket } from '../net';
import { useSession } from '../session';
import { saveUserSetting, useSettings } from '../settings';
import { SoundPalette } from '../pages/sounds';
import { CardView } from './CardView';
import { formatAmount } from './format';

/** Widgety panelu u stolu; pořadí je i výchozí pořadí zobrazení. */
export const WIDGETS = ['clock', 'table', 'hand', 'odds', 'players', 'sounds'] as const;
export type WidgetId = (typeof WIDGETS)[number];

interface PanelState {
  collapsed: WidgetId[];
  hidden: WidgetId[];
}

function parseState(raw: unknown): PanelState {
  try {
    const p = JSON.parse(String(raw || '{}')) as Partial<PanelState>;
    const ok = (x: unknown): x is WidgetId[] => Array.isArray(x) && x.every((v) => (WIDGETS as readonly string[]).includes(String(v)));
    return { collapsed: ok(p.collapsed) ? p.collapsed : [], hidden: ok(p.hidden) ? p.hidden : [] };
  } catch {
    return { collapsed: [], hidden: [] };
  }
}

/** Stav panelu je osobní nastavení, takže se synchronizuje mezi zařízeními. */
export function usePanelState(): [PanelState, (next: PanelState) => void] {
  const settings = useSettings();
  const state = useMemo(() => parseState(settings.values['ui.tablePanel']), [settings.values]);
  const set = useCallback((next: PanelState) => void saveUserSetting('ui.tablePanel', JSON.stringify(next)).catch(() => undefined), []);
  return [state, set];
}

interface Clock {
  name: string;
  status: string;
  paused: boolean;
  onBreak: boolean;
  serverTime: number;
  levelNumber: number;
  level: { smallBlind: number; bigBlind: number; ante: number } | null;
  nextLevel: { smallBlind: number; bigBlind: number; ante: number } | null;
  clockKind: 'level' | 'break' | null;
  clockMs: number | null;
  alive: number;
  players: number;
  prizePool?: number;
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const blinds = (l: { smallBlind: number; bigBlind: number; ante: number } | null) => (l ? `${l.smallBlind}/${l.bigBlind}${l.ante ? ` (${l.ante})` : ''}` : '-');

/** Hodiny turnaje: level, blindy, zbývající čas; data z turnaje, odpočet lokálně. */
function ClockWidget({ tournamentId }: { tournamentId: string }) {
  const [c, setC] = useState<(Clock & { fetchedAt: number }) | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(() => {
    get<Clock>(`/api/tournaments/${tournamentId}`)
      .then((v) => setC({ ...v, fetchedAt: Date.now() }))
      .catch(() => undefined);
  }, [tournamentId]);
  useEffect(() => {
    load();
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    const off = onSocket<{ id: string }>('tournament:changed', (m) => m.id === tournamentId && load());
    return () => {
      window.clearInterval(id);
      off();
    };
  }, [load, tournamentId]);
  if (!c) return <p className="text-muted">{t('app.loading')}</p>;
  const remaining = c.clockMs !== null ? (c.paused ? c.clockMs : c.clockMs - (now - c.fetchedAt)) : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span>{t('tournament.level', { n: c.levelNumber })}</span>
        {remaining !== null && (
          <span className="font-mono text-2xl font-bold" role="timer">
            {mmss(remaining)}
          </span>
        )}
      </div>
      <div className="font-mono text-lg">{blinds(c.level)}</div>
      {c.onBreak && <span className="text-warning">{t('tournament.onBreak')}</span>}
      {c.paused && <span className="text-muted">{t('tournament.paused')}</span>}
      {c.nextLevel && (
        <div className="text-xs text-muted">
          {t('table.widget.nextLevel')}: {blinds(c.nextLevel)}
        </div>
      )}
      <div className="text-xs text-muted">
        {c.alive}/{c.players}
      </div>
    </div>
  );
}

function Widget({ id, title, state, setState, children }: { id: WidgetId; title: string; state: PanelState; setState: (s: PanelState) => void; children: ReactNode }) {
  const collapsed = state.collapsed.includes(id);
  return (
    <section className="tk-widget">
      <button className="tk-widget-head" aria-expanded={!collapsed} onClick={() => setState({ ...state, collapsed: collapsed ? state.collapsed.filter((x) => x !== id) : [...state.collapsed, id] })}>
        <span aria-hidden>{collapsed ? '▸' : '▾'}</span>
        <span className="flex-1">{title}</span>
        <span
          role="button"
          aria-label={t('table.widget.hidden')}
          className="text-muted"
          onClick={(e) => {
            e.stopPropagation();
            setState({ ...state, hidden: [...state.hidden, id] });
          }}
        >
          ×
        </span>
      </button>
      {!collapsed && <div className="tk-widget-body">{children}</div>}
    </section>
  );
}

/** Levý panel s widgety (hodiny, stůl, moje handa, šance, hráči, zvuky). Sbalení a skrytí se ukládá u hráče. */
export function TablePanel({ view, tableId, inBb }: { view: TableView | undefined; tableId: string; inBb: boolean }) {
  const [state, setState] = usePanelState();
  const { me } = useSession();
  const mine = view?.seats.find((s) => s.playerId === me?.user.id);
  const info = view?.info;
  const tournamentId = info?.tournamentId;
  const myOdds = view?.odds?.[0]?.entries.find((e) => e.seat === mine?.seat);
  const widgets: { id: WidgetId; title: string; show: boolean; body: ReactNode }[] = [
    { id: 'clock', title: t('table.widget.clock'), show: !!tournamentId, body: tournamentId ? <ClockWidget tournamentId={tournamentId} /> : null },
    {
      id: 'table',
      title: t('table.widget.table'),
      show: !!info,
      body: info && view && (
        <dl className="grid grid-cols-2 gap-x-2 gap-y-1">
          <dt className="text-muted">{t('table.widget.blinds')}</dt>
          <dd className="font-mono">
            {info.smallBlind}/{info.bigBlind}
          </dd>
          <dt className="text-muted">{t('table.pot')}</dt>
          <dd className="font-mono">{formatAmount(view.totalPot, info, inBb)}</dd>
          {!info.tournament && (
            <>
              <dt className="text-muted">{t('table.widget.buyIn')}</dt>
              <dd className="font-mono">
                {formatAmount(info.minBuyIn, info, false)} – {formatAmount(info.maxBuyIn, info, false)}
              </dd>
            </>
          )}
          <dt className="text-muted">{t('table.widget.players')}</dt>
          <dd className="font-mono">
            {view.seats.length}/{info.seatCount}
          </dd>
          {info.rake && (
            <>
              <dt className="text-muted">Rake</dt>
              <dd className="font-mono">{info.rake.percent} %</dd>
            </>
          )}
        </dl>
      ),
    },
    {
      id: 'hand',
      title: t('table.widget.hand'),
      show: true,
      body:
        mine && mine.hasCards && mine.cards ? (
          <div className="flex flex-col items-center gap-2">
            <div className="flex gap-1">
              {mine.cards.map((c) => (
                <CardView key={c} card={c} />
              ))}
            </div>
            {view?.winners?.find((w) => w.seat === mine.seat)?.hand && <span className="text-sm">{t(view.winners.find((w) => w.seat === mine.seat)!.hand!.key, view.winners.find((w) => w.seat === mine.seat)!.hand!.params)}</span>}
          </div>
        ) : (
          <p className="text-muted">{t('table.notInHand')}</p>
        ),
    },
    {
      id: 'odds',
      title: t('table.widget.odds'),
      show: true,
      body: myOdds ? (
        <div className="font-mono text-2xl">
          {(myOdds.win * 100).toFixed(1)} %{myOdds.tie > 0 && <span className="ml-2 text-sm text-muted">({(myOdds.tie * 100).toFixed(1)} %)</span>}
        </div>
      ) : (
        <p className="text-muted">{t('table.widget.oddsNone')}</p>
      ),
    },
    {
      id: 'players',
      title: t('table.widget.players'),
      show: !!view,
      body: view && (
        <ul className="flex flex-col gap-0.5">
          {[...view.seats]
            .sort((a, b) => b.stack - a.stack)
            .map((s) => (
              <li key={s.seat} className={`flex justify-between gap-2 ${s.seat === view.actingSeat ? 'font-bold' : ''} ${s.status === 'folded' || s.status === 'sittingOut' ? 'text-muted' : ''}`}>
                <span className="truncate">
                  {s.isDealer ? 'Ⓓ ' : ''}
                  {s.name}
                </span>
                <span className="font-mono">{formatAmount(s.stack, view.info, inBb)}</span>
              </li>
            ))}
        </ul>
      ),
    },
    { id: 'sounds', title: t('table.widget.sounds'), show: !!mine, body: <SoundPalette target={{ kind: 'table', id: tableId }} /> },
  ];
  const visible = widgets.filter((w) => w.show && !state.hidden.includes(w.id));
  const hidden = widgets.filter((w) => w.show && state.hidden.includes(w.id));
  return (
    <>
      {visible.map((w) => (
        <Widget key={w.id} id={w.id} title={w.title} state={state} setState={setState}>
          {w.body}
        </Widget>
      ))}
      {hidden.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
          <span>{t('table.widget.hidden')}:</span>
          {hidden.map((w) => (
            <button key={w.id} className="rounded-sm border border-line px-1" onClick={() => setState({ ...state, hidden: state.hidden.filter((x) => x !== w.id) })}>
              {w.title}
            </button>
          ))}
          <button className="rounded-sm border border-line px-1" onClick={() => setState({ collapsed: [], hidden: [] })}>
            {t('table.widget.reset')}
          </button>
        </div>
      )}
    </>
  );
}
