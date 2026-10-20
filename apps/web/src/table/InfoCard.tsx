import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import type { TableView } from '@kb/game-core';
import { errorText, get, post } from '../api';
import { onSocket } from '../net';
import { DealPanel } from '../pages/deal';
import { useSession } from '../session';
import { Button, Modal } from '../ui';
import { actionOffSm, actionTone, actionToneSm } from './buttons';
import { formatAmount, tableMoney } from './format';

export interface TournamentInfo {
  status: string;
  prizePool: number;
  players: number;
  alive: number;
  payouts: { place: number; amount: number }[];
  bounty: { type: string; percent: number; pkoCash: number; bank: number };
  buyIn: number;
  fee: number;
  serverTime: number;
  rebuy: { enabled: boolean; cost: number; chips: number; max?: number; untilLevel?: number };
  levelNumber?: number;
  addon: { enabled: boolean; cost: number; chips: number };
  me: { status: string | null; decideUntil: number | null; canRebuy: boolean; canAddon: boolean; addonOfferUntil?: number | null; canReenter: boolean };
  reentry: { enabled: boolean };
  standings: { userId: string; place: number; chips: number | null; status: string; entries?: number; rebuys?: number; addon?: boolean; head?: number | null; bounty?: number }[];
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
  const money = (n: number) => tableMoney(n, info);
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
  if (!tournamentId || !tour || !tour.deal.enabled) return null;
  // Tlačítko je v turnaji s dohodou stále na místě; jde použít, jen když turnaj běží a dohoda ještě neproběhla.
  const active = tour.status === 'running' && !tour.deal.done;
  return (
    <>
      <button className={active ? actionToneSm.special : actionOffSm} disabled={!active} onClick={() => setOpen(true)}>
        {tour.deal.done ? t('table.info.dealDone') : tour.deal.open ? t('table.info.dealOpen') : t('deal.propose')}
      </button>
      {open && (
        <Modal title={t('deal.title')} onClose={() => setOpen(false)} wide>
          <DealPanel id={tournamentId} />
        </Modal>
      )}
    </>
  );
}

/** Rebuy, add-on a re-entry přímo u stolu (vyřazený hráč v rozhodovací době je nemusí hledat na stránce turnaje). */
/** Tlačítka jsou v turnaji, který rebuy / add-on / nový vstup má, vždy na svém místě; `active` říká, jestli je hráč teď smí použít. */
export function entryActions(tour: TournamentInfo | null): { kind: 'rebuy' | 'addon' | 'reenter'; label: string; confirm: string; active: boolean }[] {
  if (!tour || tour.me.status === null) return [];
  const running = tour.status === 'running';
  const out: { kind: 'rebuy' | 'addon' | 'reenter'; label: string; confirm: string; active: boolean }[] = [];
  if (tour.rebuy.enabled) out.push({ kind: 'rebuy', label: `${t('tournament.rebuy')} (${tour.rebuy.cost})`, confirm: t('tournament.confirmRebuy', { cost: tour.rebuy.cost, chips: tour.rebuy.chips }), active: running && tour.me.canRebuy });
  if (tour.addon.enabled) out.push({ kind: 'addon', label: `${t('tournament.addon')} (${tour.addon.cost})`, confirm: t('tournament.confirmAddon', { cost: tour.addon.cost, chips: tour.addon.chips }), active: running && tour.me.canAddon });
  if (tour.reentry.enabled) out.push({ kind: 'reenter', label: `${t('tournament.reenter')} (${tour.buyIn + tour.fee})`, confirm: t('tournament.confirmRegister', { cost: tour.buyIn, fee: tour.fee }), active: running && tour.me.canReenter });
  return out;
}

export function EntryActions({ tour, tournamentId }: { tour: TournamentInfo | null; tournamentId: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = entryActions(tour);
  if (!tournamentId || list.length === 0) return null;
  return (
    <div className="contents">
      {list.map((a) => (
        <button
          key={a.kind}
          className={a.active ? (a.kind === 'reenter' ? actionToneSm.special : actionToneSm.add) : actionOffSm}
          disabled={busy || !a.active}
          onClick={async () => {
            if (!confirm(a.confirm)) return;
            setBusy(true);
            try {
              setError('');
              await post(`/api/tournaments/${tournamentId}/${a.kind}`);
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {a.label}
        </button>
      ))}
      {error && (
        <p role="alert" className="w-full text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Jednorázová nabídka add-onu po skončení levelu: okno ano/ne s odpočtem. Zavře se odpovědí, vypršením času nebo křížkem (tlačítko u stolu zůstane). */
export function AddonOfferDialog({ tour, tournamentId }: { tour: TournamentInfo | null; tournamentId: string | null }) {
  const until = tour?.me.addonOfferUntil ?? null;
  const [hidden, setHidden] = useState<number | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Zbývající čas podle hodin serveru, od okamžiku načtení.
  const base = tour && until ? { ms: until - tour.serverTime, at: Date.now() } : null;
  const baseMs = base?.ms ?? 0;
  useEffect(() => {
    if (!until) return;
    const at = Date.now();
    const tick = () => setLeft(Math.max(0, baseMs - (Date.now() - at)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [until, baseMs]);
  if (!tour || !tournamentId || !until || hidden === until || left <= 0 || !tour.me.canAddon) return null;
  const answer = async (what: 'addon' | 'addon/decline') => {
    setBusy(true);
    try {
      setError('');
      await post(`/api/tournaments/${tournamentId}/${what}`);
      setHidden(until);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('tournament.addon')} onClose={() => setHidden(until)}>
      <div className="flex flex-col gap-3">
        <p>{t('tournament.addonOfferText', { cost: tour.addon.cost, chips: tour.addon.chips, seconds: Math.ceil(left / 1000) })}</p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button disabled={busy} onClick={() => void answer('addon/decline')}>
            {t('tournament.addonOfferNo')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void answer('addon')}>
            {t('tournament.addonOfferYes')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Vypadl jsem a běží čas na rebuy / nový vstup: okno s odpočtem hned u stolu, aby o šanci nikdo nepřišel, ani když má panely schované. */
export function RebuyDecisionDialog({ tour, tournamentId }: { tour: TournamentInfo | null; tournamentId: string | null }) {
  const until = tour?.me.status === 'deciding' ? (tour.me.decideUntil ?? null) : null;
  const [hidden, setHidden] = useState<number | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const baseMs = tour && until ? until - tour.serverTime : 0;
  useEffect(() => {
    if (!until) return;
    const at = Date.now();
    const tick = () => setLeft(Math.max(0, baseMs - (Date.now() - at)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [until, baseMs]);
  if (!tour || !tournamentId || !until || hidden === until || left <= 0 || !(tour.me.canRebuy || tour.me.canReenter)) return null;
  const act = async (what: 'rebuy' | 'reenter') => {
    setBusy(true);
    try {
      setError('');
      await post(`/api/tournaments/${tournamentId}/${what}`);
      setHidden(until);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('tournament.rebuy')} onClose={() => setHidden(until)}>
      <div className="flex flex-col gap-3">
        <p>{t('tournament.decide', { time: `${Math.ceil(left / 1000)} s` })}</p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {tour.me.canReenter && (
            <button className={actionTone.special} disabled={busy} onClick={() => void act('reenter')}>
              {t('tournament.reenter')} ({tour.buyIn + tour.fee})
            </button>
          )}
          {tour.me.canRebuy && (
            <button className={actionTone.add} disabled={busy} onClick={() => void act('rebuy')}>
              {t('tournament.rebuy')} ({tour.rebuy.cost})
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
