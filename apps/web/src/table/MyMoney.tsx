import { useEffect, useState } from 'react';
import type { TableInfo, TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { get } from '../api';
import { useSession } from '../session';
import { Button, Modal } from '../ui';
import { formatAmount, tableMoney } from './format';
import { useTournamentInfo, type TournamentInfo } from './InfoCard';
import { cashMoney, currentLadderRow, payoutLadder, signOf, stackValue } from './my-money';

/** Plus zeleně, mínus červeně, nula beze změny. */
const tone = (n: number) => (n > 0 ? 'text-success' : n < 0 ? 'text-danger' : '');

/** Jeden řádek „popisek … částka“; volitelný popisek vysvětlí, co číslo znamená. */
function Line({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${strong ? 'text-lg font-semibold' : ''}`} title={hint}>
      <span className={strong ? '' : 'text-muted'}>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

/**
 * Okno „Moje peníze“: kolik jsem do hry vložil, kolik mám a kolik je to v plusu nebo v mínusu; v turnaji navíc bounty a přehled,
 * kolik budu v plusu nebo v mínusu podle toho, na kterém místě skončím. Záměrně stručné.
 */
export function MyMoneyDialog({ view, tableId, tournamentId, onClose }: { view: TableView; tableId: string; tournamentId: string | null; onClose: () => void }) {
  const { me } = useSession();
  const tour = useTournamentInfo(tournamentId);
  const info = view.info;
  return (
    <Modal title={t('table.money.title')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {tournamentId ? <TournamentMoney view={view} info={info} tour={tour} userId={me?.user.id} /> : <CashMoneyBody view={view} info={info} tableId={tableId} userId={me?.user.id} />}
        <Button onClick={onClose}>{t('table.close')}</Button>
      </div>
    </Modal>
  );
}

function CashMoneyBody({ view, info, tableId, userId }: { view: TableView; info: TableInfo; tableId: string; userId?: string }) {
  const [bought, setBought] = useState<{ bought: number; cashedOut: number } | null>(null);
  // Znovu se načte po každé handě: dokoupení nebo odchod mění, kolik jsem vložil.
  useEffect(() => {
    get<{ bought: number; cashedOut: number }>(`/api/tables/${tableId}/my-money`).then(setBought).catch(() => undefined);
  }, [tableId, view.handNumber]);
  const mine = view.seats.find((s) => s.playerId === userId);
  const cpu = info.chipsPerCurrencyUnit;
  const money = (n: number) => formatAmount(n * cpu, info, false);
  const signed = (n: number) => `${signOf(n)}${money(Math.abs(n))}`;
  if (!bought) return <p className="text-muted">…</p>;
  if (!mine && bought.bought === 0) return <p className="text-muted">{t('table.money.notIn')}</p>;
  const m = cashMoney(bought.bought, bought.cashedOut, mine ? stackValue(mine.stack, cpu) : 0);
  return (
    <>
      <div className="flex flex-col gap-1">
        <Line label={t('table.money.invested')} value={money(m.invested)} hint={t('table.money.investedCash')} />
        {mine && <Line label={t('table.money.atTable')} value={money(m.atTable)} />}
        {m.cashedOut > 0 && <Line label={t('table.money.cashedOut')} value={money(m.cashedOut)} />}
      </div>
      <div className="border-t border-line pt-2">
        <div className={`flex items-baseline justify-between gap-3 text-lg font-semibold ${tone(m.net)}`}>
          <span>{m.net > 0 ? t('table.money.nowPlus') : m.net < 0 ? t('table.money.nowMinus') : t('table.money.nowZero')}</span>
          <span className="font-mono">{signed(m.net)}</span>
        </div>
      </div>
    </>
  );
}

function TournamentMoney({ view, info, tour, userId }: { view: TableView; info: TableInfo; tour: TournamentInfo | null; userId?: string }) {
  if (!tour) return <p className="text-muted">…</p>;
  const mine = tour.standings.find((p) => p.userId === userId);
  if (!mine || tour.me.status === null) return <p className="text-muted">{t('table.money.notIn')}</p>;
  const money = (n: number) => tableMoney(n, info);
  const signed = (n: number) => `${signOf(n)}${money(Math.abs(n))}`;
  const invested = tour.me.invested ?? 0;
  const out = mine.status === 'out';
  const bountyOn = tour.bounty.type !== 'none';
  const earned = mine.bounty ?? 0;
  const head = mine.head ?? 0;
  const wanted = view.seats.find((s) => s.playerId === userId)?.wanted ?? 0;
  const alive = tour.standings.filter((p) => p.status === 'playing' || p.status === 'deciding').length;
  const ladder = payoutLadder(tour.payouts, invested, earned);
  const here = currentLadderRow(ladder, mine.place);
  const best = ladder[0]!;
  const mineRow = out ? (ladder.find((r) => r.place === mine.place) ?? ladder.find((r) => r.place === null)!) : null;
  return (
    <>
      <div className="flex flex-col gap-1">
        <Line label={t('table.money.invested')} value={money(invested)} hint={t('table.money.investedTour')} />
        {bountyOn && earned > 0 && <Line label={t('table.money.bountyEarned')} value={`+${money(earned)}`} />}
        {bountyOn && !out && head > 0 && <Line label={t('table.money.bountyHead')} value={money(head)} hint={t('table.money.bountyHeadTip')} />}
        {!out && wanted > 0 && <Line label={t('table.money.wanted')} value={money(wanted)} hint={t('table.money.wantedTip')} />}
      </div>
      {out && mineRow ? (
        <div className="border-t border-line pt-2">
          <p className="text-muted">{t('table.money.out', { place: mine.place })}</p>
          <div className={`flex items-baseline justify-between gap-3 text-lg font-semibold ${tone(mineRow.net)}`}>
            <span>{t('table.money.result')}</span>
            <span className="font-mono">{signed(mineRow.net)}</span>
          </div>
          <p className="text-xs text-muted">{t('table.money.outNote')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-t border-line pt-2">
          <p className="text-muted">{t('table.money.position', { place: mine.place, total: alive })}</p>
          {tour.payouts.length === 0 ? (
            <p className="text-sm text-muted">{t('table.money.noPool')}</p>
          ) : (
            <>
              <div className={`flex items-baseline justify-between gap-3 text-lg font-semibold ${tone(best.net)}`}>
                <span>{t('table.money.best')}</span>
                <span className="font-mono">{signed(best.net)}</span>
              </div>
              <table className="w-full text-sm" aria-label={t('table.money.ladder')}>
                <thead>
                  <tr className="text-left text-muted">
                    <th className="font-normal">{t('table.money.ladder')}</th>
                    <th className="text-right font-normal">{t('table.money.prize')}</th>
                    <th className="text-right font-normal">{t('table.money.total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ladder.map((r, i) => (
                    <tr key={r.place ?? 'out'} className={i === here ? 'bg-raised font-semibold' : ''} aria-current={i === here ? 'true' : undefined}>
                      <td className="py-0.5">{r.place === null ? t('table.money.noPrize') : t('table.money.place', { place: r.place })}</td>
                      <td className="text-right font-mono">{r.prize > 0 ? money(r.prize) : '–'}</td>
                      <td className={`text-right font-mono ${tone(r.net)}`}>{signed(r.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted">{t('table.money.note')}</p>
            </>
          )}
        </div>
      )}
    </>
  );
}
