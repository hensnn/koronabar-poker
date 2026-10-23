import { useEffect, useRef, useState } from 'react';
import type { TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { onSocket } from '../net';
import { useSettings } from '../settings';
import { seatPosition, tableMoney } from './format';
import { fireSfx } from './sfx';

/** Událost turnaje, jak ji server posílá pro animace (hodnoty rebuy a add-onu jsou z nastavení dané hry). */
export type FxEvent =
  | { type: 'rebuy' | 'addon' | 'reentry'; userId: string; name: string; chips: number; cost: number }
  | { type: 'knockout'; victim: string; victimId: string; by: string[]; byIds: string[]; amount: number; secret: boolean }
  | { type: 'eliminated'; userId: string; name: string; remaining: number }
  | { type: 'level'; level: number; smallBlind: number; bigBlind: number; ante: number }
  | { type: 'bubble' }
  | { type: 'finished'; results: { userId: string; name: string; place: number }[] };

export interface ActiveFx {
  key: number;
  e: FxEvent;
  /** Místa hráčů v okamžiku události (vyřazený hráč už u stolu nesedí). */
  seats: Record<string, number>;
  until: number;
}

/** Jak dlouho se který efekt ukazuje (ms). */
export const FX_MS: Record<FxEvent['type'], number> = { rebuy: 2600, addon: 2800, reentry: 2600, knockout: 2600, eliminated: 3000, level: 3200, bubble: 3200, finished: 6000 };

/** Která událost spouští který zvuk. */
const SOUND: Partial<Record<FxEvent['type'], 'rebuy' | 'addon' | 'knockout' | 'level' | 'bubble'>> = { rebuy: 'rebuy', reentry: 'rebuy', addon: 'addon', knockout: 'knockout', level: 'level', bubble: 'bubble' };

/** Krátká oznámení u stolu (7-2 bonus, bomb pot, jackpot): zobrazí se na pár sekund, aby je hráč nepřehlédl, i když má chat sbalený. */
export function useTableNotices(tableId: string): { key: number; text: string }[] {
  const values = useSettings().values;
  const showBonus = values['ui.tableNotices'] !== false;
  const showTimeout = values['ui.timeoutNotice'] !== false;
  const [list, setList] = useState<{ key: number; text: string }[]>([]);
  const counter = useRef(0);
  useEffect(() => {
    return onSocket<{ tableId: string; kind?: string; text: string }>('table:notice', (m) => {
      if (m.tableId !== tableId) return;
      if (m.kind === 'timeout' ? !showTimeout : !showBonus) return;
      const item = { key: ++counter.current, text: m.text };
      setList((l) => [...l.slice(-2), item]);
      window.setTimeout(() => setList((l) => l.filter((x) => x.key !== item.key)), 5000);
    });
  }, [tableId, showBonus, showTimeout]);
  return list;
}

/** Poslouchá animační události turnaje pro tento stůl; vrací právě běžící efekty. Vypnutelné osobním nastavením. */
export function useTournamentFx(tournamentId: string | null, view: TableView | undefined): ActiveFx[] {
  const fxValues = useSettings().values;
  const enabled = fxValues['ui.eventAnimations'] !== false && fxValues['ui.reducedMotion'] !== true;
  const [list, setList] = useState<ActiveFx[]>([]);
  const seatsRef = useRef<Record<string, number>>({});
  const counter = useRef(0);
  // Poslední známá místa hráčů (vyřazený hráč po události už u stolu nesedí).
  useEffect(() => {
    // Místa se jen doplňují, aby šlo najít i hráče, který už od stolu odešel.
    if (view) seatsRef.current = { ...seatsRef.current, ...Object.fromEntries(view.seats.map((s) => [s.playerId, s.seat])) };
  }, [view]);
  useEffect(() => {
    if (!tournamentId) return;
    return onSocket<{ id: string; e: FxEvent }>('tournament:fx', (m) => {
      if (m.id !== tournamentId) return;
      const sound = SOUND[m.e.type];
      if (sound) fireSfx(sound);
      if (!enabled) return;
      const item: ActiveFx = { key: ++counter.current, e: m.e, seats: { ...seatsRef.current }, until: Date.now() + FX_MS[m.e.type] };
      setList((l) => [...l.filter((x) => x.until > Date.now()), item]);
      window.setTimeout(() => setList((l) => l.filter((x) => x.key !== item.key)), FX_MS[m.e.type] + 100);
    });
  }, [tournamentId, enabled]);
  return enabled ? list : [];
}

const place = (active: ActiveFx, userId: string, view: TableView, viewerSeat: number) => {
  const seat = view.seats.find((s) => s.playerId === userId)?.seat ?? active.seats[userId];
  return seat === undefined ? null : seatPosition(seat, viewerSeat, view.info.seatCount);
};

/** Poloha prvku v procentech stolu (hodnoty se předávají do CSS proměnných, styl v JSX nemá nést pevné rozměry). */
const at = (p: { left: number; top: number }, from?: { left: number; top: number }) => {
  const style: Record<string, string> = { left: `${p.left}%`, top: `${p.top}%` };
  if (from) {
    style['--from-left'] = `${from.left}%`;
    style['--from-top'] = `${from.top}%`;
  }
  return style as React.CSSProperties;
};

/**
 * Animace událostí turnaje u stolu: rebuy a add-on (žetony letí na stack a vyskočí přírůstek), vyřazení (razítko),
 * bounty (lebka letí od poraženého k vítězi s částkou), nový level, bublina a vítěz. Hodnoty jsou z nastavení hry.
 */
export function TableFx({ fx, view, viewerSeat }: { fx: ActiveFx[]; view: TableView; viewerSeat: number }) {
  const money = (n: number) => tableMoney(n, view.info);
  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" aria-hidden="true">
      {fx.map((a) => {
        const e = a.e;
        if (e.type === 'rebuy' || e.type === 'addon' || e.type === 'reentry') {
          const p = place(a, e.userId, view, viewerSeat);
          if (!p) return null;
          const tone = e.type === 'addon' ? 'text-warning' : e.type === 'reentry' ? 'text-accent' : 'text-success';
          const ring = e.type === 'addon' ? 'border-warning' : e.type === 'reentry' ? 'border-accent' : 'border-success';
          const chip = e.type === 'addon' ? 'bg-warning' : e.type === 'reentry' ? 'bg-accent' : 'bg-success';
          return (
            <div key={a.key} className="absolute -translate-x-1/2 -translate-y-1/2" style={at(p)}>
              <span className={`tk-fx-ring absolute left-1/2 top-1/2 h-16 w-16 rounded-full border-2 ${ring}`} />
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className={`tk-fx-chip tk-fx-chip-${i} absolute left-1/2 top-1/2 h-3 w-3 rounded-full border border-line ${chip}`} />
              ))}
              <div className={`tk-fx-float absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap rounded-md bg-surface px-2 py-0.5 font-mono text-sm font-bold shadow-lg ${tone}`}>
                +{e.chips.toLocaleString('cs-CZ')} · {t(e.type === 'addon' ? 'fx.addon' : e.type === 'reentry' ? 'fx.reentry' : 'fx.rebuy')}
              </div>
            </div>
          );
        }
        if (e.type === 'eliminated') {
          const p = place(a, e.userId, view, viewerSeat);
          if (!p) return null;
          return (
            <div key={a.key} className="tk-fx-stamp absolute -translate-x-1/2 -translate-y-1/2 -rotate-12 rounded-md border-2 border-danger bg-surface px-2 py-0.5 text-sm font-extrabold uppercase text-danger" style={at(p)}>
              {t('fx.eliminated')}
            </div>
          );
        }
        if (e.type === 'knockout') {
          const from = place(a, e.victimId, view, viewerSeat);
          if (!from) return null;
          return (
            <div key={a.key}>
              {e.byIds.map((id) => {
                const to = place(a, id, view, viewerSeat);
                if (!to) return null;
                return (
                  <div key={id}>
                    <span className="tk-fx-skull absolute -translate-x-1/2 -translate-y-1/2 text-2xl" style={at(to, from)}>
                      ☠
                    </span>
                    <div className="tk-fx-float absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md bg-surface px-2 py-0.5 font-mono text-sm font-bold text-danger shadow-lg" style={at(to)}>
                      {e.secret ? t('fx.bountyWon') : `+${money(e.amount)} · ${t('fx.bounty')}`}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        }
        if (e.type === 'level' || e.type === 'bubble') {
          return (
            <div key={a.key} className="tk-fx-banner absolute left-1/2 top-2 -translate-x-1/2 whitespace-nowrap rounded-md border-2 border-info bg-surface px-3 py-1 text-center text-sm font-bold shadow-lg">
              {e.type === 'level' ? `${t('tournament.level', { n: e.level })} · ${e.smallBlind}/${e.bigBlind}${e.ante ? ` (${e.ante})` : ''}` : t('fx.bubble')}
            </div>
          );
        }
        if (e.type !== 'finished') return null;
        return (
          <div key={a.key}>
            <div className="tk-fx-banner absolute left-1/2 top-2 -translate-x-1/2 whitespace-nowrap rounded-md border-2 border-warning bg-surface px-3 py-1 text-center text-sm font-bold shadow-lg">
              🏆 {t('fx.winner', { name: e.results[0]?.name ?? '' })}
            </div>
            {Array.from({ length: 14 }, (_, i) => (
              <span key={i} className={`tk-fx-confetti tk-fx-confetti-${i % 7} absolute h-2 w-1 rounded-sm ${['bg-success', 'bg-warning', 'bg-accent', 'bg-info', 'bg-danger'][i % 5]}`} style={at({ left: (i * 7 + 4) % 96, top: 0 })} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
