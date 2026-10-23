import { useCallback, useEffect, useState } from 'react';
import type { TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { get } from '../api';
import { onSocket } from '../net';
import { useSession } from '../session';
import { saveUserSetting, useSettings } from '../settings';
import { PLAN_OPTIONS, setPlan, usePlan } from './plan';
import { tournamentWaitLines, type TournamentInfo } from './InfoCard';

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

export const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const blinds = (l: { smallBlind: number; bigBlind: number; ante: number } | null) => (l ? `${l.smallBlind}/${l.bigBlind}${l.ante ? ` (${l.ante})` : ''}` : '-');

/**
 * Pruh nad stolem, který říká, že hraju turnaj: název, na co se právě čeká (přestávka, pauza, rebuy), kolik hráčů zbývá a moje místo. Level, blindy a čas jsou v hodinách turnaje.
 * Totéž se píše do titulku záložky. Je vidět i při vypnutých panelech.
 */
export function TournamentBanner({ tournamentId, handRunning = false }: { tournamentId: string; /** U stolu právě běží handa (pauza turnaje začne až po jejím dohrání). */ handRunning?: boolean }) {
  const { me } = useSession();
  const settings = useSettings();
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
  const place = c.standings?.find((p) => p.userId === me?.user.id)?.place;
  const waits = settings.values['ui.tournamentWaitBanner'] !== false ? tournamentWaitLines(c as unknown as TournamentInfo, me?.user.id, now - c.fetchedAt, handRunning) : [];
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-3 py-1 text-sm border border-accent bg-accent/10">
      <span aria-hidden="true">🏆</span>
      <strong className="truncate">{c.name}</strong>
      {waits.map((l, i) => (
        <span key={i} className="font-semibold text-warning">
          ⏳ {l}
        </span>
      ))}
      <span className="ml-auto text-muted">{t('table.tbanner.players', { alive: c.alive, total: c.players })}</span>
      {place !== undefined && <span>{t('table.tbanner.place', { n: place })}</span>}
    </div>
  );
}

/** Hodiny turnaje: level, blindy, zbývající čas; data z turnaje, odpočet lokálně. */
export function ClockWidget({ tournamentId, timeBank }: { tournamentId: string; /** Moje zbývající rezerva času v sekundách; undefined = nesedím nebo se rezerva nepoužívá. */ timeBank?: number }) {
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
      {c.onBreak && (
        <div role="status" className="rounded-md bg-warning px-2 py-1 text-center text-lg font-bold text-on-act">
          ☕ {t('tournament.breakBanner')}
        </div>
      )}
      <div className="flex items-baseline justify-between">
        <span className={c.onBreak ? 'text-muted' : ''}>{t(c.onBreak ? 'tournament.lastLevel' : 'tournament.level', { n: c.levelNumber })}</span>
        {remaining !== null && (
          <span className="font-mono text-2xl font-bold" role="timer">
            {mmss(remaining)}
          </span>
        )}
      </div>
      <div className={`font-mono text-lg ${c.onBreak ? 'text-muted' : ''}`}>{blinds(c.level)}</div>
      {c.paused && <span className="text-muted">{t('tournament.paused')}</span>}
      {c.nextLevel && (
        <div className={c.onBreak ? 'rounded-md border border-warning px-2 py-1 text-base font-semibold' : 'text-xs text-muted'}>
          {t('tournament.nextLevelN', { n: c.levelNumber + 1 })}: <span className="font-mono">{blinds(c.nextLevel)}</span>
        </div>
      )}
      <div className="text-xs text-muted">
        {c.alive}/{c.players}
      </div>
      {timeBank !== undefined && (
        <div className="text-sm" title={t('table.widget.timeBankHelp')}>
          ⏱ {t('table.widget.timeBank')}: <span className="font-mono font-semibold">{mmss(timeBank * 1000)}</span>
        </div>
      )}
    </div>
  );
}

/** Plánovaný tah: zvolí se dopředu, provede se automaticky na tahu. */
export function PlanBar({ view, onStraddle }: { view: TableView; /** Přepnutí dobrovolného straddle (jen u stolu s dobrovolným straddle). */ onStraddle?: (want: boolean) => void }) {
  const plan = usePlan();
  const values = useSettings().values;
  const opts = PLAN_OPTIONS.filter((o) => values[o.setting] !== false).map((o) => o.plan);
  return (
    <div className="tk-planbar flex flex-wrap items-center gap-1" role="group" aria-label={t('table.widget.plan')} title={t('table.plan.help')}>
      {opts.map((p) => (
        <button key={p} className={`tk-plan-btn rounded-md border px-1.5 py-0.5 text-xs ${plan === p ? 'border-primary bg-primary text-on-primary' : 'border-line bg-surface'}`} aria-pressed={plan === p} onClick={() => setPlan(plan === p ? null : p, view.handId)}>
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
    { key: 'ui.runItResponse', label: t('table.plan.runIt'), title: t('table.plan.showRunIt'), options: [['ask', 'ask'], ['never', 'never'], ['always', 'always']], def: 'ask' },
    { key: 'ui.showdownLosing', label: t('table.plan.lose'), title: t('table.plan.showLosing'), options: [['show', 'show'], ['ask', 'ask'], ['muck', 'muck']], def: 'show' },
  ];
  return (
    <>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted" title={t('table.plan.showHelp')}>{t('table.plan.show')}</summary>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {PLAN_OPTIONS.map((o) => (
            <label key={o.setting} className="flex items-center gap-1" title={t(`settings.${o.setting}.help`)}>
              <input type="checkbox" role="switch" checked={settings.values[o.setting] !== false} onChange={(e) => void saveUserSetting(o.setting, e.target.checked, true).catch(() => undefined)} />
              {t(`table.plan.${o.plan}`)}
            </label>
          ))}
        </div>
      </details>
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

