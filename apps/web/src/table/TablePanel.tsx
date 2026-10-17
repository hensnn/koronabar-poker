import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { get } from '../api';
import { onSocket } from '../net';
import { useSession } from '../session';
import { saveUserSetting, useSettings } from '../settings';
import { SoundPalette } from '../pages/sounds';
import { Button, Modal } from '../ui';
import { CardView } from './CardView';
import { formatAmount } from './format';
import { setPlan, usePlan, type Plan } from './plan';

/** Widgety panelu u stolu; pořadí je výchozí pořadí zobrazení. */
export const WIDGETS = ['clock', 'plan', 'table', 'hand', 'players', 'sounds'] as const;
export type WidgetId = (typeof WIDGETS)[number];

interface PanelState {
  collapsed: WidgetId[];
  hidden: WidgetId[];
  order: WidgetId[];
}

const isIds = (x: unknown): x is WidgetId[] => Array.isArray(x) && x.every((v) => (WIDGETS as readonly string[]).includes(String(v)));

function parseState(raw: unknown): PanelState {
  try {
    const p = JSON.parse(String(raw || '{}')) as Partial<PanelState>;
    const order = isIds(p.order) ? [...new Set(p.order)] : [];
    return { collapsed: isIds(p.collapsed) ? p.collapsed : [], hidden: isIds(p.hidden) ? p.hidden : [], order: [...order, ...WIDGETS.filter((w) => !order.includes(w))] };
  } catch {
    return { collapsed: [], hidden: [], order: [...WIDGETS] };
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
  paused: boolean;
  onBreak: boolean;
  levelNumber: number;
  level: { smallBlind: number; bigBlind: number; ante: number } | null;
  nextLevel: { smallBlind: number; bigBlind: number; ante: number } | null;
  clockKind: 'level' | 'break' | null;
  clockMs: number | null;
  alive: number;
  players: number;
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

/** Plánovaný tah: zvolí se dopředu, provede se automaticky na tahu. */
export function PlanBar({ view }: { view: TableView }) {
  const plan = usePlan();
  const opts: Plan[] = ['fold', 'checkFold', 'check', 'call'];
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('table.widget.plan')}>
      {opts.map((p) => (
        <button key={p} className={`rounded-md border px-2 py-1 text-sm ${plan === p ? 'border-primary bg-primary text-on-primary' : 'border-line bg-surface'}`} aria-pressed={plan === p} onClick={() => setPlan(plan === p ? null : p, view.handId)}>
          {t(`table.plan.${p}`)}
        </button>
      ))}
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
      </button>
      {!collapsed && <div className="tk-widget-body">{children}</div>}
    </section>
  );
}

/** Ozubené kolečko: které widgety a v jakém pořadí, plus volby zobrazení u stolu. */
function PanelSettings({ state, setState, titles, onClose }: { state: PanelState; setState: (s: PanelState) => void; titles: Record<WidgetId, string>; onClose: () => void }) {
  const settings = useSettings();
  const move = (id: WidgetId, dir: -1 | 1) => {
    const order = [...state.order];
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    setState({ ...state, order });
  };
  const toggle = (key: string, value: boolean) => void saveUserSetting(key, value).catch(() => undefined);
  const flags: { key: string; label: string; def: boolean }[] = [
    { key: 'ui.showInBb', label: t('settings.ui.showInBb.label'), def: false },
    { key: 'ui.showSymbolAtTable', label: t('settings.ui.showSymbolAtTable.label'), def: false },
    { key: 'xp.showAtTable', label: t('settings.xp.showAtTable.label'), def: true },
  ];
  return (
    <Modal title={t('table.panelSettings')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <h3 className="font-bold">{t('table.panelWidgets')}</h3>
        <ul className="flex flex-col gap-1">
          {state.order.map((id, i) => (
            <li key={id} className="flex items-center gap-2">
              <label className="flex flex-1 items-center gap-2">
                <input type="checkbox" checked={!state.hidden.includes(id)} onChange={(e) => setState({ ...state, hidden: e.target.checked ? state.hidden.filter((x) => x !== id) : [...state.hidden, id] })} />
                {titles[id]}
              </label>
              <Button aria-label={t('table.moveUp')} disabled={i === 0} onClick={() => move(id, -1)}>
                ↑
              </Button>
              <Button aria-label={t('table.moveDown')} disabled={i === state.order.length - 1} onClick={() => move(id, 1)}>
                ↓
              </Button>
            </li>
          ))}
        </ul>
        <h3 className="font-bold">{t('table.panelDisplay')}</h3>
        {flags.map((f) => (
          <label key={f.key} className="flex items-center gap-2">
            <input type="checkbox" checked={Boolean(settings.values[f.key] ?? f.def)} onChange={(e) => toggle(f.key, e.target.checked)} />
            {f.label}
          </label>
        ))}
        <div className="flex gap-2">
          <Button onClick={() => setState({ collapsed: [], hidden: [], order: [...WIDGETS] })}>{t('table.widget.reset')}</Button>
          <Button variant="primary" onClick={onClose}>
            {t('table.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Levý panel s widgety (hodiny, plánovaný tah, stůl, moje handa, hráči, zvuky). Nastavení pod ozubeným kolečkem. */
export function TablePanel({ view, tableId, inBb }: { view: TableView | undefined; tableId: string; inBb: boolean }) {
  const [state, setState] = usePanelState();
  const [open, setOpen] = useState(false);
  const { me } = useSession();
  const mine = view?.seats.find((s) => s.playerId === me?.user.id);
  const info = view?.info;
  const tournamentId = info?.tournamentId;
  const myWin = view?.winners?.find((w) => w.seat === mine?.seat);
  const titles: Record<WidgetId, string> = { clock: t('table.widget.clock'), plan: t('table.widget.plan'), table: t('table.widget.table'), hand: t('table.widget.hand'), players: t('table.widget.players'), sounds: t('table.widget.sounds') };
  const bodies: Record<WidgetId, { show: boolean; body: ReactNode }> = {
    clock: { show: !!tournamentId, body: tournamentId ? <ClockWidget tournamentId={tournamentId} /> : null },
    plan: {
      show: !!mine && !!view,
      body: view && (
        <div className="flex flex-col gap-2">
          <PlanBar view={view} />
          <p className="text-xs text-muted">{t('table.plan.help')}</p>
        </div>
      ),
    },
    table: {
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
    hand: {
      show: true,
      body:
        mine && mine.hasCards && mine.cards ? (
          <div className="flex flex-col items-center gap-2">
            <div className="flex gap-1">
              {mine.cards.map((c) => (
                <CardView key={c} card={c} />
              ))}
            </div>
            {myWin?.hand && <span className="text-sm">{t(myWin.hand.key, myWin.hand.params)}</span>}
          </div>
        ) : (
          <p className="text-muted">{t('table.notInHand')}</p>
        ),
    },
    players: {
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
    sounds: { show: !!mine, body: <SoundPalette target={{ kind: 'table', id: tableId }} /> },
  };
  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-muted">{t('table.panel')}</span>
        <button className="rounded-md border border-line bg-surface px-2 py-0.5 text-sm" aria-label={t('table.panelSettings')} title={t('table.panelSettings')} onClick={() => setOpen(true)}>
          ⚙
        </button>
      </div>
      {state.order
        .filter((id) => bodies[id].show && !state.hidden.includes(id))
        .map((id) => (
          <Widget key={id} id={id} title={titles[id]} state={state} setState={setState}>
            {bodies[id].body}
          </Widget>
        ))}
      {open && <PanelSettings state={state} setState={setState} titles={titles} onClose={() => setOpen(false)} />}
    </>
  );
}
