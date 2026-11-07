import { useRef, type RefObject } from 'react';
import { t } from '@kb/shared';
import type { SeatView, TableView } from '@kb/game-core';
import { useDialogTop } from './dialog-place';
import { formatAmount, tableMoney } from './format';
import type { BountyList, BountyRow, TournamentInfo } from './InfoCard';

/** Odměna vypsaná na hlavu hráče: součet, zadavatelé s částkami a stav (čeká na vyřazení, nebo připadne vítězi). */
export interface SeatBounty {
  total: number;
  posters: { name: string; amount: number }[];
  status: 'open' | 'pendingWinner';
  /** Co se stane, když hráč turnaj přežije (return / house / winner). */
  survivedRule: string;
}

/** Odměny na hlavu jednoho hráče z otevřených odměn turnaje; null, když na něj žádná není. */
export function seatBounty(list: BountyList | null | undefined, userId: string): SeatBounty | null {
  const mine: BountyRow[] = (list?.rows ?? []).filter((r) => r.targetId === userId);
  if (mine.length === 0) return null;
  const posters: { name: string; amount: number }[] = [];
  for (const r of mine) {
    const known = posters.find((x) => x.name === r.poster);
    if (known) known.amount += r.amount;
    else posters.push({ name: r.poster, amount: r.amount });
  }
  return { total: mine.reduce((n, r) => n + r.amount, 0), posters, status: mine.some((r) => r.status === 'pendingWinner') ? 'pendingWinner' : 'open', survivedRule: list!.survivedRule };
}

/** Řádky informací o hráči (po najetí myší na sedadlo): žetony, v turnaji pořadí, rebuy, add-on a odměna na hlavu. */
export function playerFacts(seat: SeatView, view: TableView, tour: TournamentInfo | null, inBb: boolean, bounty: SeatBounty | null = null): { label: string; value: string }[] {
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
  // Odměna, kterou na hráčovu hlavu vypsali ostatní: kolik, kdo ji vypsal a v jakém je stavu.
  if (bounty) {
    rows.push({ label: t('table.card.reward'), value: tableMoney(bounty.total, info) });
    rows.push({ label: t('table.card.rewardBy'), value: bounty.posters.map((x) => (bounty.posters.length > 1 ? `${x.name} (${tableMoney(x.amount, info)})` : x.name)).join(', ') });
    rows.push({ label: t('table.card.rewardState'), value: t(`table.card.rewardState.${bounty.status}`) });
    if (bounty.status === 'open') rows.push({ label: t('table.card.rewardSurvive'), value: t(`table.card.rewardSurvive.${bounty.survivedRule}`) });
  }
  return rows;
}

/**
 * Karta s informacemi o hráči u levého okraje stolu; nepřekáží myši. Svisle se umisťuje mimo střed stolu (board a pot),
 * takže ani s odměnou a dalšími řádky nezakrývá karty na stole (viz dialog-place.ts).
 */
export function PlayerCard({ seat, view, tour, inBb, bounty = null, roomRef, centerRef }: { seat: SeatView; view: TableView; tour: TournamentInfo | null; inBb: boolean; bounty?: SeatBounty | null; roomRef: RefObject<HTMLElement | null>; centerRef: RefObject<HTMLElement | null> }) {
  const rows = playerFacts(seat, view, tour, inBb, bounty);
  const boxRef = useRef<HTMLDivElement>(null);
  const top = useDialogTop(roomRef, centerRef, boxRef);
  return (
    <div ref={boxRef} role="status" style={{ top }} className="pointer-events-none absolute left-1 z-20 max-w-[45%] rounded-md border border-line bg-surface p-2 text-sm shadow-lg">
      <strong className="block truncate">{seat.name}</strong>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted">{r.label}</dt>
            <dd className={`text-right ${r.label === t('table.card.rewardState') || r.label === t('table.card.rewardSurvive') || r.label === t('table.card.rewardBy') ? 'text-xs' : 'font-mono'}`}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
