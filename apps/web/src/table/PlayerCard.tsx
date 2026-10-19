import { t } from '@kb/shared';
import type { SeatView, TableView } from '@kb/game-core';
import { formatAmount } from './format';
import type { TournamentInfo } from './InfoCard';

/** Řádky informací o hráči (po najetí myší na sedadlo): žetony, v turnaji pořadí, rebuy, add-on a odměna na hlavu. */
export function playerFacts(seat: SeatView, view: TableView, tour: TournamentInfo | null, inBb: boolean): { label: string; value: string }[] {
  const info = view.info;
  const rows: { label: string; value: string }[] = [{ label: t('table.card.stack'), value: formatAmount(seat.stack, info, inBb) }];
  if (!info.tournament) rows.push({ label: t('table.card.stackBb'), value: `${(seat.stack / Math.max(1, info.bigBlind)).toFixed(1)} BB` });
  const status = seat.sitOut || seat.status === 'sittingOut' ? t('table.sittingOut') : seat.status === 'allIn' ? t('table.allIn') : seat.status === 'folded' ? t('table.fold') : null;
  if (status) rows.push({ label: t('table.card.status'), value: status });
  const p = tour?.standings.find((x) => x.userId === seat.playerId);
  if (tour && p) {
    rows.push({ label: t('table.card.place'), value: `${p.place}. / ${tour.alive}` });
    if (tour.rebuy.enabled) {
      const max = tour.rebuy.max ?? 0;
      const used = p.rebuys ?? 0;
      const open = tour.rebuy.untilLevel === undefined || tour.levelNumber === undefined || tour.levelNumber <= tour.rebuy.untilLevel;
      rows.push({ label: t('table.card.rebuys'), value: open ? (max > 0 ? t('table.card.rebuysLeft', { used, max, left: Math.max(0, max - used) }) : String(used)) : t('table.card.rebuysClosed', { used }) });
    }
    if (tour.addon.enabled) rows.push({ label: t('table.card.addon'), value: p.addon ? t('table.card.yes') : t('table.card.no') });
    if ((p.entries ?? 1) > 1) rows.push({ label: t('table.card.entries'), value: String(p.entries) });
    if ((p.head ?? 0) > 0) rows.push({ label: t('table.card.head'), value: formatAmount(p.head!, info, false) });
    if ((p.bounty ?? 0) > 0) rows.push({ label: t('table.card.bounty'), value: formatAmount(p.bounty!, info, false) });
  }
  return rows;
}

/** Karta s informacemi o hráči v rohu u stolu (využívá volné místo mimo ovál); nepřekáží myši. */
export function PlayerCard({ seat, view, tour, inBb, corner }: { seat: SeatView; view: TableView; tour: TournamentInfo | null; inBb: boolean; corner: 'left' | 'right' }) {
  const rows = playerFacts(seat, view, tour, inBb);
  return (
    <div role="status" className={`pointer-events-none absolute top-1 z-20 max-w-[45%] rounded-md border border-line bg-surface p-2 text-sm shadow-lg ${corner === 'left' ? 'left-1' : 'right-1'}`}>
      <strong className="block truncate">{seat.name}</strong>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted">{r.label}</dt>
            <dd className="text-right font-mono">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
