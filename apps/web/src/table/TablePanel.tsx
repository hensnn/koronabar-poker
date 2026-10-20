import { useCallback, useEffect, useState } from 'react';
import type { TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { get } from '../api';
import { onSocket } from '../net';
import { useSession } from '../session';
import { saveUserSetting, useSettings } from '../settings';
import { setPlan, usePlan, type Plan } from './plan';

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
  name?: string;
  standings?: { userId: string; place: number; status: string }[];
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const blinds = (l: { smallBlind: number; bigBlind: number; ante: number } | null) => (l ? `${l.smallBlind}/${l.bigBlind}${l.ante ? ` (${l.ante})` : ''}` : '-');

/**
 * Pruh nad stolem, který říká, že hraju turnaj: název, level, blindy, čas do dalšího levelu, kolik hráčů zbývá a moje místo.
 * Totéž se píše do titulku záložky. Je vidět i při vypnutých panelech.
 */
export function TournamentBanner({ tournamentId }: { tournamentId: string }) {
  const { me } = useSession();
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
    const poll = window.setInterval(load, 30_000);
    const off = onSocket<{ id: string }>('tournament:changed', (m) => m.id === tournamentId && load());
    return () => {
      window.clearInterval(id);
      window.clearInterval(poll);
      off();
    };
  }, [load, tournamentId]);
  const name = c?.name;
  const alive = c?.alive;
  const total = c?.players;
  useEffect(() => {
    if (!name) return;
    const before = document.title;
    document.title = `🏆 ${name} · ${alive}/${total}`;
    return () => {
      document.title = before;
    };
  }, [name, alive, total]);
  if (!c) return null;
  const remaining = c.clockMs !== null ? (c.paused ? c.clockMs : c.clockMs - (now - c.fetchedAt)) : null;
  const place = c.standings?.find((p) => p.userId === me?.user.id)?.place;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md border border-accent bg-accent/10 px-3 py-1 text-sm">
      <span aria-hidden="true">🏆</span>
      <strong className="truncate">{c.name}</strong>
      <span>{t('tournament.level', { n: c.levelNumber })}</span>
      <span className="font-mono">{blinds(c.level)}</span>
      {remaining !== null && (
        <span className="font-mono font-bold" role="timer">
          {mmss(remaining)}
        </span>
      )}
      {c.paused && <span className="font-semibold text-warning">{t('tournament.paused')}</span>}
      {c.onBreak && <span className="font-semibold text-warning">{t('tournament.onBreak')}</span>}
      <span className="text-muted">{t('table.tbanner.players', { alive: c.alive, total: c.players })}</span>
      {place !== undefined && <span>{t('table.tbanner.place', { n: place })}</span>}
    </div>
  );
}

/** Hodiny turnaje: level, blindy, zbývající čas; data z turnaje, odpočet lokálně. */
export function ClockWidget({ tournamentId }: { tournamentId: string }) {
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
export function PlanBar({ view, onStraddle }: { view: TableView; /** Přepnutí dobrovolného straddle (jen u stolu s dobrovolným straddle). */ onStraddle?: (want: boolean) => void }) {
  const plan = usePlan();
  const opts: Plan[] = ['fold', 'checkFold', 'check', 'call'];
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('table.widget.plan')} title={t('table.plan.help')}>
      {opts.map((p) => (
        <button key={p} className={`rounded-md border px-1.5 py-0.5 text-xs ${plan === p ? 'border-primary bg-primary text-on-primary' : 'border-line bg-surface'}`} aria-pressed={plan === p} onClick={() => setPlan(plan === p ? null : p, view.handId)}>
          {t(`table.plan.${p}`)}
        </button>
      ))}
      {view.info.straddle === 'optional' && onStraddle && (
        <label className="ml-2 flex items-center gap-1 text-xs" title={t('table.straddleTip')}>
          <input type="checkbox" role="switch" aria-label={t('table.straddle')} checked={view.myStraddle} onChange={(e) => onStraddle(e.target.checked)} />
          <span className={view.myStraddle ? 'font-semibold text-accent' : ''}>{t('table.straddle')}</span>
        </label>
      )}
    </div>
  );
}

/** Co dělat s kartami: Win = výherní bez showdownu, Lose = poražené na showdownu. Osobní nastavení, platí u všech stolů. */
export function ShowdownPrefs() {
  const settings = useSettings();
  const rows: { key: string; label: string; title: string; options: [string, string][]; def: string }[] = [
    { key: 'ui.showdownWinning', label: t('table.plan.win'), title: t('table.plan.showWinning'), options: [['never', 'muck'], ['ask', 'ask'], ['always', 'show']], def: 'never' },
    { key: 'ui.showdownLosing', label: t('table.plan.lose'), title: t('table.plan.showLosing'), options: [['show', 'show'], ['ask', 'ask'], ['muck', 'muck']], def: 'show' },
  ];
  return (
    <>
      {rows.map((r) => (
        <label key={r.key} className="flex items-center gap-1 text-xs" title={r.title}>
          <span className="text-muted">{r.label}</span>
          <select className="rounded-md border border-line bg-surface px-0.5 py-0 text-xs" value={String(settings.values[r.key] ?? r.def)} onChange={(e) => void saveUserSetting(r.key, e.target.value).catch(() => undefined)}>
            {r.options.map(([value, word]) => (
              <option key={value} value={value}>
                {t(`table.plan.opt.${word}`)}
              </option>
            ))}
          </select>
        </label>
      ))}
    </>
  );
}

