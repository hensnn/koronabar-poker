import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import type { TableView } from '@kb/game-core';
import { get } from '../api';
import { onSocket } from '../net';
import { DealPanel } from '../pages/deal';
import { useSession } from '../session';
import { Modal } from '../ui';
import { formatAmount } from './format';

export interface TournamentInfo {
  status: string;
  prizePool: number;
  players: number;
  alive: number;
  payouts: { place: number; amount: number }[];
  bounty: { type: string; percent: number; pkoCash: number; bank: number };
  rebuy: { enabled: boolean };
  addon: { enabled: boolean };
  reentry: { enabled: boolean };
  standings: { userId: string; place: number; chips: number | null; status: string }[];
  deal: { enabled: boolean; open: boolean; done: unknown | null };
}

const chip = 'rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs';

/** Údaje o turnaji pro boční panel; obnovují se po změně turnaje a jednou za chvíli. */
export function useTournamentInfo(tournamentId: string | null): TournamentInfo | null {
  const [tour, setTour] = useState<TournamentInfo | null>(null);
  const load = useCallback(() => {
    if (!tournamentId) return;
    get<TournamentInfo>(`/api/tournaments/${tournamentId}`)
      .then(setTour)
      .catch(() => undefined);
  }, [tournamentId]);
  useEffect(() => {
    load();
    if (!tournamentId) return;
    const off = onSocket<{ id: string }>('tournament:changed', (m) => m.id === tournamentId && load());
    const poll = setInterval(load, 15_000);
    return () => {
      off();
      clearInterval(poll);
    };
  }, [tournamentId, load]);
  return tournamentId ? tour : null;
}

/** Moje pozice v turnaji: místo mezi zbývajícími a kolik hráčů zbývá vyřadit do peněz (bubliny). */
export function positionText(tour: TournamentInfo | null, userId: string | undefined): string | null {
  if (!tour || tour.status !== 'running') return null;
  const mine = tour.standings.find((p) => p.userId === userId);
  if (!mine) return null;
  if (mine.status === 'out') return t('table.info.positionOut', { place: mine.place });
  const alive = tour.standings.filter((p) => p.status === 'playing' || p.status === 'deciding').length;
  const paid = tour.payouts.length;
  return t('table.info.position', { place: mine.place, total: alive }) + (paid > 0 ? ' · ' + (alive > paid ? t('table.info.toMoney', { n: alive - paid }) : t('table.info.inMoney')) : '');
}

/** Základní údaje o hře: místa, prize pool, hráči, placená místa, bounty a speciální varianty. */
export function InfoBody({ view, tour, tournamentId, inBb }: { view: TableView; tour: TournamentInfo | null; tournamentId: string | null; inBb: boolean }) {
  const info = view.info;
  const { me } = useSession();
  const seated = view.seats.length;
  const money = (n: number) => `${n.toLocaleString('cs-CZ')} ${info.currencySymbol}`;
  const bountyLine = tour
    ? tour.bounty.type === 'fixed'
      ? t('table.info.bountyFixed', { percent: tour.bounty.percent })
      : tour.bounty.type === 'pko'
        ? t('table.info.bountyPko', { percent: tour.bounty.percent })
        : tour.bounty.type === 'mystery'
          ? t('table.info.bountyMystery')
          : null
    : null;
  const running = tour?.status === 'running';
  const alive = tour?.standings.filter((p) => p.status === 'playing' || p.status === 'deciding') ?? [];
  const chipsKnown = alive.length > 0 && alive.every((p) => p.chips !== null);
  const avgStack = chipsKnown ? Math.round(alive.reduce((n, p) => n + (p.chips ?? 0), 0) / alive.length) : null;
  const position = positionText(tour, me?.user.id);

  const tags: string[] = [];
  if (info.bettingLimit === 'potLimit') tags.push(t('table.info.limitPot'));
  if (info.bettingLimit === 'fixedLimit') tags.push(t('table.info.limitFixed'));
  if ((info.ante ?? 0) > 0) tags.push(t(info.bbAnte ? 'table.info.bbAnte' : 'table.info.ante', { amount: formatAmount(info.ante!, info, inBb) }));
  if (info.straddle === 'mandatory') tags.push(t('table.info.straddleMandatory'));
  if (info.straddle === 'optional') tags.push(t('table.info.straddleOptional'));
  if ((info.runIt ?? 0) > 0) tags.push(t('table.info.runIt', { times: info.runIt! }));
  if ((info.bombPotEvery ?? 0) > 0) tags.push(t('table.info.bombPot', { n: info.bombPotEvery! }));
  if ((info.sevenTwoBb ?? 0) > 0) tags.push(t('table.info.sevenTwo', { bb: info.sevenTwoBb! }));
  if (info.rake) tags.push(t('table.info.rake', { percent: info.rake.percent }));
  if (info.jackpot !== undefined) tags.push(t('table.info.jackpot', { amount: money(info.jackpot) }));
  if (info.callClock) tags.push(t('table.info.callClock'));
  if (info.rabbitHunt) tags.push(t('table.info.rabbit'));
  if (tour?.rebuy.enabled) tags.push(t('table.info.rebuy'));
  if (tour?.addon.enabled) tags.push(t('table.info.addon'));
  if (tour?.reentry.enabled) tags.push(t('table.info.reentry'));

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {position && <p className="rounded-md bg-raised px-2 py-1 text-xs font-semibold">{position}</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        {!tournamentId && (
          <>
            <dt className="text-muted">{t('table.info.seats')}</dt>
            <dd className="text-right font-mono" title={t('table.info.seatsValue', { taken: seated, total: info.seatCount, free: Math.max(0, info.seatCount - seated) })}>
              {seated}/{info.seatCount}
            </dd>
          </>
        )}
        {tour && (
          <>
            <dt className="text-muted">{t('table.info.prizePool')}</dt>
            <dd className="text-right font-mono">{money(tour.prizePool)}</dd>
            <dt className="text-muted">{t('table.info.players')}</dt>
            <dd className="text-right font-mono">
              {tour.alive}/{tour.players}
            </dd>
            {tour.payouts.length > 0 && (
              <>
                <dt className="text-muted">{t('table.info.placesPaid')}</dt>
                <dd className="text-right font-mono">{tour.payouts.length}</dd>
              </>
            )}
            {avgStack !== null && running && (
              <>
                <dt className="text-muted">{t('table.info.avgStack')}</dt>
                <dd className="text-right font-mono">{avgStack}</dd>
              </>
            )}
          </>
        )}
      </dl>
      {tour && (
        <p className="text-xs">
          <span className="text-muted">{t('table.info.bounty')}: </span>
          {bountyLine ?? t('table.info.bountyNone')}
          {bountyLine && tour.bounty.bank > 0 && <span className="block text-muted">{t('table.info.bountyBank', { amount: money(tour.bounty.bank) })}</span>}
        </p>
      )}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((x) => (
            <span key={x} className={chip}>
              {x}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Odměny na hlavu: kdo je „hledaný“ a kolik za něj někdo vypsal. */
export function wantedList(view: TableView): { seat: number; name: string; amount: number }[] {
  return view.seats
    .filter((s) => (s.wanted ?? 0) > 0)
    .map((s) => ({ seat: s.seat, name: s.name, amount: s.wanted ?? 0 }))
    .sort((a, b) => b.amount - a.amount);
}

export function BountiesBody({ view }: { view: TableView }) {
  const list = wantedList(view);
  const { me } = useSession();
  if (list.length === 0) return <p className="text-sm text-muted">{t('table.info.noRewards')}</p>;
  const mineId = view.seats.find((s) => s.playerId === me?.user.id)?.seat;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {list.map((w) => (
        <li key={w.seat} className="flex items-center justify-between gap-2">
          <span className="truncate" title={t('tournament.wanted')}>
            ⚑ {w.name}
            {w.seat === mineId ? ` (${t('table.info.you')})` : ''}
          </span>
          <span className="font-mono font-semibold">{w.amount}</span>
        </li>
      ))}
    </ul>
  );
}

/** Tlačítko pro návrh dohody (turnaj, který běží, má dohodu povolenou a žádná ještě neproběhla); otevře okno s dohodou. */
export function DealButton({ tour, tournamentId }: { tour: TournamentInfo | null; tournamentId: string | null }) {
  const [open, setOpen] = useState(false);
  if (!tournamentId || !tour || !tour.deal.enabled || tour.status !== 'running' || tour.deal.done) return null;
  return (
    <>
      <button className="w-full rounded-md border border-primary bg-primary px-2 py-1 text-on-primary" onClick={() => setOpen(true)}>
        {tour.deal.open ? t('table.info.dealOpen') : t('deal.propose')}
      </button>
      {open && (
        <Modal title={t('deal.title')} onClose={() => setOpen(false)} wide>
          <DealPanel id={tournamentId} />
        </Modal>
      )}
    </>
  );
}
