import { useEffect, useState } from 'react';
import { onSocket } from '../net';
import { RankBadge } from '../progress-client';
import { useSettings } from '../settings';
import { SoundPalette } from '../pages/sounds';
import { NoteDialog, NoteDot } from '../pages/notes';
import type { SoundPlayEvent } from '../sound-client';
import type { SeatView, TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { table, useNet } from '../net';
import { useSession } from '../session';
import { ActionBar } from './ActionBar';
import { CardView } from './CardView';
import { formatAmount, seatPosition } from './format';
import { Amount } from './Chips';
import { Countdown, TimerBar, TimerRing } from './TimerRing';
import { useThemeToken } from '../theme/ThemeProvider';
import { useTableSfx } from './sfx';
import { avatarClasses, LookName, useLook, useMyTableLook } from '../cosmetics-client';

interface Props {
  tableId: string;
  inBb: boolean;
  quickPost: string;
  quickPre: string;
}

const btn = 'rounded-md border border-line bg-surface px-3 py-1';

export function TableScreen({ tableId, inBb, quickPost, quickPre }: Props) {
  const net = useNet();
  const logoTextToken = useThemeToken('table.logoText');
  const logoImageToken = useThemeToken('image.logo');
  const { me } = useSession();
  const userId = me?.user.id;
  const view = net.views[tableId];
  useTableSfx(view, net.clockOffset);
  const myLook = useMyTableLook();
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'join'; seat: number } | { kind: 'topUp' } | null>(null);

  useEffect(() => {
    if (net.status === 'online') void table.subscribe(tableId);
  }, [net.status, tableId]);

  // Zvukové emotikony u stolu: bublina u avataru na pár vteřin.
  const [bubbles, setBubbles] = useState<Record<string, { emoji: string; name: string }>>({});
  useEffect(
    () =>
      onSocket<SoundPlayEvent>('sound', (e) => {
        if (e.target.kind !== 'table' || e.target.id !== tableId) return;
        const who = e.from.userId;
        setBubbles((b) => ({ ...b, [who]: { emoji: e.emoji, name: e.name } }));
        window.setTimeout(() => setBubbles((b) => (b[who]?.name === e.name ? Object.fromEntries(Object.entries(b).filter(([k]) => k !== who)) : b)), 3500);
      }),
    [tableId],
  );

  if (!view) return <p className="text-muted">{t('table.loading')}</p>;
  const info = view.info;
  const mine = view.seats.find((s) => s.playerId === userId);
  const seated = !!mine;
  const run = async (p: Promise<{ ok: boolean; code?: string; params?: Record<string, unknown> }>) => {
    const r = await p;
    setError(r.ok ? '' : t(`error.${r.code}`, r.params));
    return r.ok;
  };

  const seatNumbers = Array.from({ length: info.seatCount }, (_, i) => i);
  const logoText = logoTextToken;
  const logoImage = logoImageToken;
  const odds = view.odds;
  const mainOdds = odds?.[0];

  return (
    <div className="flex flex-col gap-3">
      <div className="tk-room" {...myLook}>
      <div className="tk-table relative mx-auto w-full max-w-3xl">
        <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-center">
          {(logoText || logoImage !== 'none') && (
            <div className="tk-table-logo flex items-center justify-center text-sm font-heading text-on-primary">{logoText}</div>
          )}
          {view.runs && view.runs.length > 1 ? (
            <div className="flex flex-col gap-1">
              {view.runs.map((r, n) => (
                <div key={n} className="flex items-center gap-2">
                  <span className="w-12 text-xs text-muted">{t('table.run', { n: n + 1 })}</span>
                  <div className="flex gap-1">
                    {r.board.map((c, i) => (
                      <CardView key={i} card={c} small />
                    ))}
                  </div>
                  <span className="text-xs">
                    {r.winners.map((w) => t('table.runWon', { nick: view.seats.find((s) => s.seat === w.seat)?.name ?? '', amount: formatAmount(w.amount, info, inBb) })).join(' · ')}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex gap-1">
              {Array.from({ length: 5 }, (_, i) =>
                view.board[i] ? <CardView key={i} card={view.board[i]!} delay={Math.min(4, Math.max(0, i - (view.street === 'TURN' ? 3 : view.street === 'RIVER' ? 4 : 0)) + 1)} /> : <span key={i} className="tk-card border border-line opacity-30" />,
              )}
            </div>
          )}
          {view.bombPot && <div className="rounded-md bg-accent px-3 py-1 text-on-act">{t('table.bombPot')}</div>}
          {view.rabbit && (
            <div className="flex items-center gap-1 text-xs text-muted">
              {t('table.rabbit')}:
              {view.rabbit.map((c) => (
                <CardView key={c} card={c} small />
              ))}
            </div>
          )}
          <div className="rounded-md bg-surface px-3 py-1 font-mono" aria-label={t('table.pot')}>
            {t('table.pot')}: {formatAmount(view.totalPot, info, inBb)}
          </div>
          {(info.rake || info.jackpot !== undefined) && (
            <div className="flex flex-wrap justify-center gap-2 text-xs text-muted">
              {info.rake && <span>{info.rake.capChips > 0 ? t('table.rakeInfo', { percent: info.rake.percent, cap: formatAmount(info.rake.capChips, info, false) }) : t('table.rakeInfoNoCap', { percent: info.rake.percent })}</span>}
              {info.jackpot !== undefined && (
                <span>
                  {t('table.jackpot')}: {info.jackpot} {info.currencySymbol}
                </span>
              )}
            </div>
          )}
          {odds && odds.length > 1 && (
            <ul className="text-sm text-on-act">
              {odds.slice(1).map((o) => (
                <li key={o.pot}>
                  {t('table.sidePot')} {o.pot}: {formatAmount(o.amount, info, inBb)}
                </li>
              ))}
            </ul>
          )}
          {view.winners && (
            <div role="status" className="rounded-md bg-primary px-3 py-1 text-on-primary">
              {view.winners
                .map((w) => `${view.seats.find((s) => s.seat === w.seat)?.name ?? ''}: +${formatAmount(w.amount, info, inBb)}${w.hand ? ` (${t(w.hand.key, w.hand.params)})` : ''}`)
                .join(' · ')}
            </div>
          )}
        </div>
        {seatNumbers.map((n) => {
          const seat = view.seats.find((s) => s.seat === n);
          const pos = seatPosition(n, view.viewerSeat ?? mine?.seat ?? 0, info.seatCount);
          return (
            <div key={n} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${pos.left}%`, top: `${pos.top}%` }}>
              {seat ? (
                <Seat
                  seat={seat}
                  view={view}
                  mine={seat.playerId === userId}
                  offset={net.clockOffset}
                  inBb={inBb}
                  oddsPct={mainOdds?.entries.find((e) => e.seat === seat.seat)}
                  bubble={bubbles[seat.playerId]}
                />
              ) : info.tournament ? null : (
                <button
                  className="rounded-full border border-line bg-surface px-3 py-2 text-sm opacity-80"
                  disabled={seated}
                  onClick={() => setDialog({ kind: 'join', seat: n })}
                >
                  {t('table.sit')}
                </button>
              )}
            </div>
          );
        })}
      </div>
      </div>

      {view.actingSeat !== null && (
        <p className="text-center text-muted">
          {view.seats.find((s) => s.seat === view.actingSeat)?.name} · <Countdown deadline={view.deadline} offset={net.clockOffset} />{' '}
          {view.bankActive && `(${t('table.timeBank')})`}
          {view.clockCalled && ` · ${t('table.clockCalled')}`}
        </p>
      )}

      {mine && view.vote && view.vote.kind === 'runit' && view.vote.status === 'open' && (
        <div role="dialog" aria-label={t('table.runIt.title', { times: String((view.vote.payload as { times: number }).times) })} className="mx-auto flex max-w-md flex-col gap-2 rounded-md border border-primary bg-surface p-3">
          <strong>{t('table.runIt.title', { times: String((view.vote.payload as { times: number }).times) })}</strong>
          <p>{t('table.runIt.text', { times: String((view.vote.payload as { times: number }).times) })}</p>
          <p className="text-sm text-muted">
            {t('table.runIt.votes', { voted: view.vote.tally.voted, total: view.vote.tally.total })} · <Countdown deadline={view.vote.deadline} offset={net.clockOffset} />
          </p>
          {view.vote.canVote && (
            <div className="flex gap-2">
              <button className={`${btn} bg-primary text-on-primary`} disabled={view.vote.myVote === true} onClick={() => void run(table.vote(tableId, true))}>
                {t('table.runIt.agree', { times: String((view.vote.payload as { times: number }).times) })}
              </button>
              <button className={btn} disabled={view.vote.myVote === false} onClick={() => void run(table.vote(tableId, false))}>
                {t('table.runIt.disagree')}
              </button>
            </div>
          )}
        </div>
      )}

      {mine && view.legal && (
        <ActionBar view={view} legal={view.legal} inBb={inBb} quickPost={quickPost} quickPre={quickPre} onAct={(a) => void run(table.act(tableId, a))} />
      )}

      {mine && (
        <div className="flex flex-wrap gap-2">
          <SoundPalette target={{ kind: 'table', id: tableId }} />
          {view.winners && mine.hasCards && info.showCards && !view.seats.some((s) => s.playerId !== userId && s.cards) && (
            <>
              <button className={btn} onClick={() => void run(table.show(tableId, 'both'))}>
                {t('table.showCards')}
              </button>
              <button className={btn} onClick={() => void run(table.show(tableId, 0))}>
                {t('table.showCard1')}
              </button>
              <button className={btn} onClick={() => void run(table.show(tableId, 1))}>
                {t('table.showCard2')}
              </button>
            </>
          )}
          {view.winners && mine.hasCards && info.rabbitHunt && view.board.length < 5 && !view.rabbit && (
            <button className={btn} onClick={() => void run(table.rabbit(tableId))}>
              {t('table.rabbit')}
            </button>
          )}
          {info.callClock && view.actingSeat !== null && view.actingSeat !== mine.seat && mine.status !== 'folded' && !view.clockCalled && (
            <button className={btn} onClick={() => void run(table.callClock(tableId))}>
              {t('table.callClock')}
            </button>
          )}
          {mine.status === 'sittingOut' ? (
            <button className={btn} onClick={() => void run(table.sitIn(tableId))}>
              {t('table.sitIn')}
            </button>
          ) : (
            <button className={btn} onClick={() => void run(table.sitOut(tableId))}>
              {t('table.sitOut')}
            </button>
          )}
          {info.straddle === 'optional' && (
            <button className={btn} aria-pressed={view.myStraddle} onClick={() => void run(table.straddle(tableId, !view.myStraddle))}>
              {view.myStraddle ? t('table.straddleOff') : t('table.straddleOn')}
            </button>
          )}
          {!info.tournament && (info.topUpEnabled || (mine.stack === 0 && info.rebuyEnabled)) && (
            <button className={btn} onClick={() => setDialog({ kind: 'topUp' })}>
              {mine.stack === 0 ? t('table.rebuy') : t('table.topUp')}
            </button>
          )}
          {!info.tournament && (
            <button className={btn} onClick={() => void run(table.leave(tableId))}>
              {t('table.leave')}
            </button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}

      {dialog && (
        <AmountDialog
          title={dialog.kind === 'join' ? t('table.buyIn') : t('table.topUp')}
          view={view}
          balance={me?.balance ?? 0}
          onCancel={() => setDialog(null)}
          onOk={async (amount) => {
            const ok = await run(dialog.kind === 'join' ? table.join(tableId, dialog.seat, amount) : table.topUp(tableId, amount));
            if (ok) setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function Seat({
  seat,
  view,
  mine,
  offset,
  inBb,
  oddsPct,
  bubble,
}: {
  bubble?: { emoji: string; name: string };
  seat: SeatView;
  view: TableView;
  mine: boolean;
  offset: number;
  inBb: boolean;
  oddsPct?: { win: number; tie: number };
}) {
  const showRank = useSettings().values['xp.showAtTable'] !== false;
  const [noteOpen, setNoteOpen] = useState(false);
  const timerStyle = useThemeToken('timer.style');
  const look = useLook(seat.playerId);
  const frame = avatarClasses(look, 'border-2 border-line');
  const won = view.winners?.find((w) => w.seat === seat.seat);
  const acting = view.actingSeat === seat.seat;
  const dim = seat.status === 'folded' || seat.status === 'sittingOut' || seat.status === 'waiting';
  const pct = oddsPct ? `${(oddsPct.win * 100).toFixed(1)} %` : null;
  return (
    <div className={`flex w-20 flex-col items-center gap-1 text-center sm:w-28 ${dim ? 'opacity-60' : ''}`}>
      <div className="flex gap-1">
        {seat.hasCards && (seat.cards ? seat.cards.map((c) => <CardView key={c} card={c} small />) : [0, 1].map((i) => <CardView key={i} card={seat.exposed?.[i] ?? null} small />))}
      </div>
      <div className={`tk-avatar relative flex items-center justify-center bg-surface ${acting ? 'border-2 tk-turn' : won ? 'border-2 tk-winner' : frame.cls}`}>
        {acting && timerStyle !== 'bar' && <TimerRing deadline={view.deadline} offset={offset} bank={view.bankActive} />}
        <span className="truncate px-1 text-xs font-medium max-sm:hidden">
          {showRank && <RankBadge userId={seat.playerId} />} <LookName userId={seat.playerId}>{seat.name}</LookName>
        </span>
        {frame.sparkle && (
          <span aria-hidden className="absolute -right-2 -top-2 text-xs">
            ✨
          </span>
        )}
        {!mine && <NoteDot userId={seat.playerId} onOpen={() => setNoteOpen(true)} />}
        {noteOpen && <NoteDialog userId={seat.playerId} nickname={seat.name} onClose={() => setNoteOpen(false)} />}
        {bubble && (
          <span role="status" className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-surface px-2 py-0.5 text-sm shadow-lg">
            {bubble.emoji} {bubble.name}
          </span>
        )}
        {view.straddleSeat === seat.seat && <span className="absolute -left-1 -top-1 rounded-full bg-accent px-1 text-xs text-on-act">S</span>}
        {seat.isDealer && <span className="absolute -right-1 -top-1 rounded-full bg-dealer px-1 text-xs text-on-primary">D</span>}
      </div>
      {/* Na telefonu je jméno pod avatarem, uvnitř by se nevešlo. */}
      <span className="max-w-full truncate rounded-md bg-surface px-1 text-xs font-medium sm:hidden">
        <LookName userId={seat.playerId}>{seat.name}</LookName>
      </span>
      <div className={`rounded-md px-2 text-xs ${mine ? 'bg-primary text-on-primary' : 'bg-surface'}`}>
        <Amount amount={seat.stack} text={formatAmount(seat.stack, view.info, inBb)} />
      </div>
      {seat.wanted !== undefined && seat.wanted > 0 && (
        <div className="rounded-md bg-danger px-2 font-mono text-xs text-on-primary" title={t('tournament.wanted')}>
          ⚑ {seat.wanted}
        </div>
      )}
      {seat.bounty !== undefined && seat.bounty > 0 && (
        <div className="rounded-md bg-accent px-2 font-mono text-xs text-on-act" title={t('tournament.head')}>
          ☠ {seat.bounty}
        </div>
      )}
      {acting && timerStyle === 'bar' && <TimerBar deadline={view.deadline} offset={offset} bank={view.bankActive} />}
      {won && (
        <span key={view.handId} aria-hidden className="tk-float absolute -top-2 font-mono text-sm font-bold text-accent">
          +{formatAmount(won.amount, view.info, inBb)}
        </span>
      )}
      {seat.bet > 0 && (
        <div key={seat.bet} className="tk-pop rounded-md bg-raised px-2 text-xs">
          <Amount amount={seat.bet} text={formatAmount(seat.bet, view.info, inBb)} />
        </div>
      )}
      {seat.status === 'allIn' && <div className="text-xs text-accent">{t('table.allIn')}</div>}
      {seat.status === 'folded' && <div className="text-xs text-muted">{t('table.fold')}</div>}
      {seat.status === 'sittingOut' && <div className="text-xs text-muted">{t('table.sittingOut')}</div>}
      {seat.status === 'waiting' && <div className="text-xs text-muted">{t('table.waiting')}</div>}
      {pct && <div className="rounded-md bg-info px-2 font-mono text-xs text-on-act">{pct}</div>}
    </div>
  );
}

function AmountDialog({
  title,
  view,
  balance,
  onCancel,
  onOk,
}: {
  title: string;
  view: TableView;
  balance: number;
  onCancel: () => void;
  onOk: (currency: number) => void;
}) {
  const info = view.info;
  const rate = info.chipsPerCurrencyUnit;
  const min = Math.ceil(info.minBuyIn / rate);
  const max = Math.min(Math.floor(info.maxBuyIn / rate), balance);
  const [v, setV] = useState(Math.min(max, Math.max(min, Math.floor((min + max) / 2))));
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
      <h2 className="font-heading text-lg font-bold">{title}</h2>
      <p className="text-sm text-muted">
        {t('table.wallet')}:{' '}
        <span className="font-mono">
          {balance} {info.currencySymbol}
        </span>
      </p>
      <div className="flex items-center gap-3">
        <input aria-label={t('table.amount')} type="range" className="flex-1" min={min} max={Math.max(min, max)} value={v} onChange={(e) => setV(Number(e.target.value))} />
        <input
          aria-label={t('table.amountExact')}
          type="number"
          className="w-28 rounded-sm border border-line bg-surface px-2 py-1 font-mono"
          min={min}
          max={max}
          value={v}
          onChange={(e) => setV(Number(e.target.value))}
        />
      </div>
      <div className="flex gap-2">
        <button className={`${btn} bg-primary text-on-primary`} onClick={() => onOk(v)}>
          {t('table.confirm')}
        </button>
        <button className={btn} onClick={onCancel}>
          {t('table.cancel')}
        </button>
      </div>
    </div>
  );
}
