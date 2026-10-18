import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import type { TableView } from '@kb/game-core';
import { get } from '../api';
import { onSocket } from '../net';
import { DealPanel } from '../pages/deal';
import { Modal } from '../ui';
import { formatAmount } from './format';

interface TournamentInfo {
  status: string;
  prizePool: number;
  players: number;
  alive: number;
  payouts: { place: number; amount: number }[];
  bounty: { type: string; percent: number; pkoCash: number; bank: number };
  rebuy: { enabled: boolean };
  addon: { enabled: boolean };
  reentry: { enabled: boolean };
  standings: { chips: number | null; status: string }[];
  deal: { enabled: boolean; open: boolean; done: unknown | null };
}

const chip = 'rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs';

/**
 * Přehled hry vedle stolu: kolik je v banku, kolik je míst, bounty a jaké speciální varianty se hrají.
 * U turnaje navíc prize pool, kolik hráčů zbývá, placená místa a tlačítko pro návrh dohody.
 */
export function TableInfoCard({ view, tournamentId, inBb }: { view: TableView; tournamentId: string | null; inBb: boolean }) {
  const info = view.info;
  const [tour, setTour] = useState<TournamentInfo | null>(null);
  const [dealOpen, setDealOpen] = useState(false);
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
    <section className="flex flex-col gap-1.5 rounded-md border border-line bg-surface p-2 text-sm" aria-label={t('table.info.title')}>
      <h3 className="font-semibold">{t('table.info.title')}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted">{t('table.info.pot')}</dt>
        <dd className="text-right font-mono">{formatAmount(view.totalPot, info, inBb)}</dd>
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
      {tournamentId && tour?.deal.enabled && running && !tour.deal.done && (
        <button className="rounded-md border border-primary bg-primary px-2 py-1 text-on-primary" onClick={() => setDealOpen(true)}>
          {tour.deal.open ? t('table.info.dealOpen') : t('deal.propose')}
        </button>
      )}
      {dealOpen && tournamentId && (
        <Modal title={t('deal.title')} onClose={() => setDealOpen(false)} wide>
          <DealPanel id={tournamentId} />
        </Modal>
      )}
    </section>
  );
}
