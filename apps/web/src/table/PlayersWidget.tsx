import { useEffect, useRef, useState } from 'react';
import type { SeatView, TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { onSocket } from '../net';
import { formatAmount } from './format';
import type { TournamentInfo } from './InfoCard';

/** Diváci stolu (přihlášení k odběru, kteří u něj nesedí); seznam posílá server. */
export function useObservers(tableId: string): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    setNames([]);
    return onSocket<{ tableId: string; names: string[] }>('table:observers', (m) => m.tableId === tableId && setNames(m.names));
  }, [tableId]);
  return names;
}

/** Stav sedícího hráče jako krátký text (nic, když prostě hraje). */
export function seatStatusLabel(s: SeatView): { text: string; tone: string } | null {
  if (s.status === 'sittingOut' || s.sitOut === true) return { text: `⏸ ${t('table.players.sitOut')}`, tone: 'text-warning' };
  if (s.status === 'allIn') return { text: t('table.players.allIn'), tone: 'text-accent' };
  if (s.status === 'folded') return { text: t('table.players.folded'), tone: 'text-muted' };
  if (s.status === 'waiting') return { text: t('table.players.waiting'), tone: 'text-muted' };
  return null;
}

/**
 * Widget Hráči: sedící hráči se stavem (složil, all-in, sit out, čeká), pak vyřazení (s umístěním) a ti, kdo odešli od stolu,
 * a nakonec diváci. Odchozí hráče si pamatuje jen tahle relace (server o nich po odchodu nic nedrží).
 */
export function PlayersBody({ view, tableId, tour, inBb }: { view: TableView; tableId: string; tour: TournamentInfo | null; inBb: boolean }) {
  const observers = useObservers(tableId);
  const known = useRef(new Map<string, string>());
  const lastTable = useRef(tableId);
  if (lastTable.current !== tableId) {
    known.current = new Map();
    lastTable.current = tableId;
  }
  for (const s of view.seats) known.current.set(s.playerId, s.name);
  const seatedIds = new Set(view.seats.map((s) => s.playerId));
  const out = (tour?.standings ?? []).filter((p) => p.status === 'out' && !seatedIds.has(p.userId)).sort((a, b) => a.place - b.place);
  const deciding = (tour?.standings ?? []).filter((p) => p.status === 'deciding' && !seatedIds.has(p.userId));
  const outIds = new Set(out.map((p) => p.userId));
  const decidingIds = new Set(deciding.map((p) => p.userId));
  const left = [...known.current.entries()].filter(([id]) => !seatedIds.has(id) && !outIds.has(id) && !decidingIds.has(id));
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-0.5">
        {[...view.seats]
          .sort((a, b) => b.stack - a.stack)
          .map((s) => {
            const st = seatStatusLabel(s);
            return (
              <li key={s.seat} className={`flex items-baseline justify-between gap-2 ${s.seat === view.actingSeat ? 'font-bold' : ''} ${s.status === 'folded' || s.status === 'sittingOut' ? 'text-muted' : ''}`}>
                <span className="truncate">
                  {s.isDealer ? 'Ⓓ ' : ''}
                  {s.name}
                  {st && <span className={`ml-1 text-xs font-normal ${st.tone}`}>{st.text}</span>}
                </span>
                <span className="font-mono">{formatAmount(s.stack, view.info, inBb)}</span>
              </li>
            );
          })}
      </ul>
      {(out.length > 0 || deciding.length > 0 || left.length > 0) && (
        <ul className="flex flex-col gap-0.5 border-t border-line pt-1 text-sm text-muted">
          {deciding.map((p) => (
            <li key={p.userId} className="flex justify-between gap-2">
              <span className="truncate">{p.name ?? ''}</span>
              <span className="text-xs text-warning">{t('table.players.deciding')}</span>
            </li>
          ))}
          {out.map((p) => (
            <li key={p.userId} className="flex justify-between gap-2">
              <span className="truncate">{p.name ?? ''}</span>
              <span className="text-xs">{t('table.players.out', { place: p.place })}</span>
            </li>
          ))}
          {left.map(([id, name]) => (
            <li key={id} className="flex justify-between gap-2">
              <span className="truncate">{name}</span>
              <span className="text-xs">{t('table.players.left')}</span>
            </li>
          ))}
        </ul>
      )}
      {observers.length > 0 && (
        <p className="border-t border-line pt-1 text-xs text-muted" title={t('table.players.observersHelp')}>
          👁 {t('table.players.observers', { n: observers.length })}: {observers.join(', ')}
        </p>
      )}
    </div>
  );
}
