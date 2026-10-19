import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { onSocket } from '../net';
import { RankBadge } from '../progress-client';
import { useSettings } from '../settings';
import { NoteDialog, NoteDot } from '../pages/notes';
import type { SoundPlayEvent } from '../sound-client';
import type { SeatView, TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { table, useNet } from '../net';
import { useSession } from '../session';
import { ActionBar } from './ActionBar';
import { CardView } from './CardView';
import { formatAmount, seatPosition } from './format';
import { Panel } from './Panel';
import { Resizable } from './resizable';
import { useTableWidgets } from './widgets';
import { defaultOf, saveUserSetting } from '../settings';
import { flyOffset, useDealAnimation, type DealState } from './deal';
import { Amount } from './Chips';
import { Countdown, TimerBar } from './TimerRing';
import { useThemeToken } from '../theme/ThemeProvider';
import { useTableSfx } from './sfx';
import { useActionBubbles, type Bubble } from './actions-feed';
import { avatarClasses, LookName, useLook, useMyTableLook } from '../cosmetics-client';
import { Modal } from '../ui';
import { usePlanExecutor } from './plan';
import { useMobileLayout } from './mobile';
import { actionOff, actionTone } from './buttons';
import { PlayerCard } from './PlayerCard';

interface Props {
  tableId: string;
  inBb: boolean;
  quickPost: string;
  quickPre: string;
  /** Doplňková tlačítka pod akční lištou (zvuky, ankety…). */
  extra?: React.ReactNode;
}

const btn = 'rounded-md border border-line bg-surface px-3 py-1';
const btnPrimary = 'rounded-md border border-primary bg-primary px-3 py-1 text-on-primary';

/** Run it: karty dalšího běhu se rozdávají postupně; výherce se ukáže až po nich. */
const RUN_FIRST_MS = 250;
const RUN_STEP_MS = 450;
const runCardDelay = (index: number) => RUN_FIRST_MS + index * RUN_STEP_MS;
const runDelayStyle = (fresh: number) => ({ animationDelay: `${fresh === 0 ? 0 : runCardDelay(fresh)}ms` });

/** Sázka hráče leží mezi jeho sedadlem a středem stolu; na telefonu blíž ke středu, aby ji nezakrývaly karty. */
function betPosition(seat: number, viewerSeat: number | null, count: number, mobile: boolean) {
  const p = seatPosition(seat, viewerSeat, count);
  const fx = mobile ? 0.5 : 0.52;
  const fy = mobile ? 0.4 : 0.6;
  return { left: 50 + (p.left - 50) * fx, top: 50 + (p.top - 50) * fy };
}

export function TableScreen({ tableId, inBb, quickPost, quickPre, extra }: Props) {
  const net = useNet();
  const logoTextToken = useThemeToken('table.logoText');
  const logoImageToken = useThemeToken('image.logo');
  const { me } = useSession();
  const userId = me?.user.id;
  const view = net.views[tableId];
  useTableSfx(view, net.clockOffset);
  const myLook = useMyTableLook();
  const deal = useDealAnimation(view);
  const actionBubbles = useActionBubbles(view, inBb);
  const rotate = useSettings().values['ui.rotateToMe'] !== false;
  const winnerPref = String(useSettings().values['ui.showdownWinning'] ?? 'never');
  const mobile = useMobileLayout();
  usePlanExecutor(view, tableId);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'join'; seat: number } | { kind: 'topUp' } | null>(null);

  // Dokoupení žetonů lze vyvolat i z panelu vlevo (widget Akce).
  useEffect(() => {
    const open = () => setDialog({ kind: 'topUp' });
    window.addEventListener('kb:topup', open);
    return () => window.removeEventListener('kb:topup', open);
  }, []);

  useEffect(() => {
    if (net.status === 'online') void table.subscribe(tableId);
  }, [net.status, tableId]);

  // Zvukové emotikony u stolu: bublina u hráče na pár vteřin.
  const [soundBubbles, setSoundBubbles] = useState<Record<string, { emoji: string; name: string }>>({});
  useEffect(
    () =>
      onSocket<SoundPlayEvent>('sound', (e) => {
        if (e.target.kind !== 'table' || e.target.id !== tableId) return;
        const who = e.from.userId;
        setSoundBubbles((b) => ({ ...b, [who]: { emoji: e.emoji, name: e.name } }));
        window.setTimeout(() => setSoundBubbles((b) => (b[who]?.name === e.name ? Object.fromEntries(Object.entries(b).filter(([k]) => k !== who)) : b)), 3500);
      }),
    [tableId],
  );

  const { tour } = useTableWidgets();
  // Hráč, na kterého ukazuje myš: karta s informacemi v rohu u stolu.
  const [hoverSeat, setHoverSeat] = useState<number | null>(null);
  // Klepnutí (dotyk) na hráče kartu připne; zavře se klepnutím mimo hráče nebo znovu na něj.
  const [pinnedSeat, setPinnedSeat] = useState<number | null>(null);
  useEffect(() => {
    if (pinnedSeat === null) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest('[data-seat-wrap]')) setPinnedSeat(null);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [pinnedSeat]);

  if (!view) return <p className="text-muted">{t('table.loading')}</p>;
  const info = view.info;
  const mine = view.seats.find((s) => s.playerId === userId);
  const seated = !!mine;
  const myTurn = !!mine && view.actingSeat === mine.seat;
  const run = async (p: Promise<{ ok: boolean; code?: string; params?: Record<string, unknown> }>) => {
    const r = await p;
    setError(r.ok ? '' : t(`error.${r.code}`, r.params));
    return r.ok;
  };

  // Run it: pot leží nad řádky jednotlivých běhů, aby se s nimi a s mými kartami nepřekrýval.
  const multiRun = !!view.runs && view.runs.length >= 1;
  const potEl = (
    <div className="tk-pot" aria-label={t('table.pot')}>
      {t('table.pot')}: {formatAmount(view.totalPot, info, inBb)}
      {view.bombPot && <span className="ml-2 rounded-md bg-accent px-2 text-on-act">{t('table.bombPot')}</span>}
    </div>
  );
  const seatNumbers = Array.from({ length: info.seatCount }, (_, i) => i);
  // Otočení stolu: moje místo dole uprostřed (výchozí), jinak pevné pozice podle čísel sedadel.
  const viewerSeat = rotate ? (view.viewerSeat ?? mine?.seat ?? 0) : 0;
  const odds = view.odds;
  const mainOdds = odds?.[0];
  const acting = view.actingSeat !== null ? view.seats.find((s) => s.seat === view.actingSeat) : undefined;
  const shownSeat = hoverSeat ?? pinnedSeat;
  const hovered = shownSeat !== null ? view.seats.find((s) => s.seat === shownSeat) : undefined;
  // Co lze po handě ukázat (widget „Ukázat karty“ se ukazuje jen, když je co).
  const canShowCards = !!(view.winners && mine?.hasCards && info.showCards && !view.seats.some((s) => s.playerId !== userId && s.cards));
  const canCallClock = !!(mine && view.actingSeat !== null && view.actingSeat !== mine.seat && mine.status !== 'folded' && !view.clockCalled);
  const canRabbit = !!(view.winners && mine?.hasCards && info.rabbitHunt && view.board.length < 5 && !view.rabbit);

  return (
    <div className="tk-screen flex flex-col gap-2">
      <div className="tk-room relative" {...myLook}>
        {hovered && <PlayerCard seat={hovered} view={view} tour={tour} inBb={inBb} />}
        <div className="tk-table relative mx-auto w-full">
          {/* střed: board, pot, hlášky */}
          <div className="tk-center absolute left-1/2 top-1/2 flex w-[70%] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-center">
            {(logoTextToken || logoImageToken !== 'none') && <div className="tk-table-logo flex items-center justify-center font-heading text-sm text-felt-text">{logoTextToken}</div>}
            {multiRun && potEl}
            {view.runs && view.runs.length >= 1 ? (
              <div className="flex flex-col gap-1">
                {view.runs.map((r, n) => {
                  // Karty, které s prvním během sdílí (už ležely na stole), se nerozdávají znovu; nové se rozdávají jedna po druhé.
                  const shared = n === 0 ? r.board.length : r.board.findIndex((c, i) => c !== view.runs![0]!.board[i]);
                  const sharedCount = shared < 0 ? r.board.length : shared;
                  const fresh = r.board.length - sharedCount;
                  return (
                    <div key={n} className={`flex items-center gap-2 ${n > 0 ? 'tk-run-in' : ''}`}>
                      <span className="w-12 text-xs text-felt-text">{t('table.run', { n: n + 1 })}</span>
                      <div className="flex gap-1">
                        {r.board.map((c, i) => (
                          <CardView key={`${n}-${i}-${c}`} card={c} small still={i < sharedCount} delayMs={i < sharedCount ? 0 : runCardDelay(i - sharedCount)} />
                        ))}
                      </div>
                      <span className="tk-run-won text-xs text-felt-text" style={runDelayStyle(n === 0 ? 0 : fresh)}>
                        {r.winners.map((w) => t('table.runWon', { nick: view.seats.find((s) => s.seat === w.seat)?.name ?? '', amount: formatAmount(w.amount, info, inBb) })).join(' · ')}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex gap-1">
                {Array.from({ length: 5 }, (_, i) =>
                  view.board[i] ? <CardView key={i} card={view.board[i]!} delay={Math.min(4, Math.max(0, i - (view.street === 'TURN' ? 3 : view.street === 'RIVER' ? 4 : 0)) + 1)} /> : <span key={i} className="tk-card tk-card-slot" />,
                )}
              </div>
            )}
            {!multiRun && potEl}
            {view.rabbit && (
              <div className="flex items-center gap-1 text-xs text-felt-text">
                {t('table.rabbit')}:
                {view.rabbit.map((c) => (
                  <CardView key={c} card={c} small />
                ))}
              </div>
            )}
            {odds && odds.length > 1 && (
              <ul className="text-xs text-felt-text">
                {odds.slice(1).map((o) => (
                  <li key={o.pot}>
                    {t('table.sidePot')} {o.pot}: {formatAmount(o.amount, info, inBb)}
                  </li>
                ))}
              </ul>
            )}
            {view.winners && (
              <div role="status" className="tk-pop rounded-md bg-primary px-3 py-1 text-sm text-on-primary">
                {view.winners
                  .map((w) => `${view.seats.find((s) => s.seat === w.seat)?.name ?? ''}: +${formatAmount(w.amount, info, inBb)}${w.hand ? ` (${t(w.hand.key, w.hand.params)})` : ''}`)
                  .join(' · ')}
              </div>
            )}
          </div>

          {/* sázky uvnitř oválu */}
          {view.seats
            .filter((s) => s.bet > 0)
            .map((s) => {
              const p = betPosition(s.seat, viewerSeat, info.seatCount, mobile);
              const from = seatPosition(s.seat, viewerSeat, info.seatCount);
              return (
                <div key={`bet-${s.seat}-${s.bet}`} className="tk-bet tk-chip-fly absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${p.left}%`, top: `${p.top}%`, ['--from-left' as string]: `${from.left}%`, ['--from-top' as string]: `${from.top}%` }}>
                  <Amount amount={s.bet} text={formatAmount(s.bet, info, inBb)} />
                </div>
              );
            })}

          {/* sedadla po obvodu */}
          {seatNumbers.map((n) => {
            const seat = view.seats.find((s) => s.seat === n);
            const pos = seatPosition(n, viewerSeat, info.seatCount);
            return (
              // Sedadlo s bublinou nebo štítkem musí ležet nad sousedními sedadly i nad sázkami (každé sedadlo je vlastní vrstva).
              <div key={n} data-seat-wrap className="absolute -translate-x-1/2 -translate-y-1/2" onClick={seat ? () => setPinnedSeat((p) => (p === n ? null : n)) : undefined} onMouseEnter={seat ? () => setHoverSeat(n) : undefined} onMouseLeave={seat ? () => setHoverSeat((h) => (h === n ? null : h)) : undefined} onFocus={seat ? () => setHoverSeat(n) : undefined} onBlur={seat ? () => setHoverSeat((h) => (h === n ? null : h)) : undefined} style={{ left: `${pos.left}%`, top: `${pos.top}%`, zIndex: seat && (actionBubbles[n] || soundBubbles[seat.playerId] || seat.reveal || seat.exposed) ? 5 : undefined }}>
                {seat ? (
                  <Seat seat={seat} view={view} mine={seat.playerId === userId} offset={net.clockOffset} inBb={inBb} oddsPct={mainOdds?.entries.find((e) => e.seat === seat.seat)} sound={soundBubbles[seat.playerId]} action={actionBubbles[seat.seat]} deal={deal} dealFrom={view.buttonSeat !== null ? seatPosition(view.buttonSeat, viewerSeat, info.seatCount) : undefined} dealTo={pos} bubbleSide={pos.top > 62 ? (pos.left < 50 ? 'left' : 'right') : undefined} />
                ) : info.tournament ? null : (
                  <button className="tk-seat-empty" disabled={seated} onClick={() => setDialog({ kind: 'join', seat: n })}>
                    {t('table.sit')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {/* Hlasování a rozhodnutí o ukázání karet leží přes stůl, aby byly vidět i na celé obrazovce a na telefonu. */}
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 p-2">
      {mine && view.vote && view.vote.kind === 'runit' && view.vote.status === 'open' && (
        <div role="dialog" aria-label={t('table.runIt.title', { times: String((view.vote.payload as { times: number }).times) })} className="pointer-events-auto flex w-full max-w-sm flex-col gap-2 rounded-md border-2 border-primary bg-surface p-3 shadow-lg">
          <strong>{t('table.runIt.title', { times: String((view.vote.payload as { times: number }).times) })}</strong>
          <p>{t('table.runIt.text', { times: String((view.vote.payload as { times: number }).times) })}</p>
          <p className="text-sm text-muted">
            {t('table.runIt.votes', { voted: view.vote.tally.voted, total: view.vote.tally.total })} · <Countdown deadline={view.vote.deadline} offset={net.clockOffset} />
          </p>
          {view.vote.canVote && (
            <div className="flex gap-2">
              <button className={btnPrimary} disabled={view.vote.myVote === true} onClick={() => void run(table.vote(tableId, true))}>
                {t('table.runIt.agree', { times: String((view.vote.payload as { times: number }).times) })}
              </button>
              <button className={btn} disabled={view.vote.myVote === false} onClick={() => void run(table.vote(tableId, false))}>
                {t('table.runIt.disagree')}
              </button>
            </div>
          )}
        </div>
      )}

      {mine && view.showdownChoice && (
        <div role="dialog" aria-label={t('table.showdown.title')} className="pointer-events-auto flex w-full max-w-sm flex-col gap-2 rounded-md border-2 border-primary bg-surface p-3 shadow-lg">
          <strong>{t('table.showdown.title')}</strong>
          <p className="text-sm text-muted">
            {t('table.showdown.hint', { s: String(Math.max(0, Math.ceil((view.showdownChoice.deadline - Date.now() - net.clockOffset) / 1000))) })} · <Countdown deadline={view.showdownChoice.deadline} offset={net.clockOffset} />
          </p>
          <div className="flex gap-2">
            <button className={btnPrimary} onClick={() => void run(table.showdown(tableId, 'show'))}>
              {t('table.showdown.show')}
            </button>
            <button className={btn} onClick={() => void run(table.showdown(tableId, 'muck'))}>
              {t('table.showdown.muck')}
            </button>
          </div>
        </div>
      )}

        </div>
      </div>

      {/* stav tahu: výrazně pro mě, decentně pro ostatní */}
      <div className="tk-turn-row">
      {myTurn ? (
        <div role="status" className="tk-your-turn tk-pop">
          {t('table.yourTurn')} · <Countdown deadline={view.deadline} offset={net.clockOffset} />
          {view.bankActive && ` (${t('table.timeBank')})`}
          {view.clockCalled && ` · ${t('table.clockCalled')}`}
        </div>
      ) : (
        acting && (
          <p className="text-center text-sm text-muted">
            {t('table.waitingFor', { nick: acting.name })} · <Countdown deadline={view.deadline} offset={net.clockOffset} />
            {view.bankActive && ` (${t('table.timeBank')})`}
          </p>
        )
      )}
      {!myTurn && !acting && <p className="text-center text-sm text-muted">{view.paused ? `⏸ ${t('table.paused')}` : view.handId && view.winners === null && view.street !== null ? t('table.handRunning') : t('table.waitingPlayers')}</p>}
      </div>

      {mine && <ActionBar view={view} legal={deal.active ? null : view.legal} inBb={inBb} quickPost={quickPost} quickPre={quickPre} onAct={(a) => void run(table.act(tableId, a))} />}

      {/* Pravý sloupec: widgety o hře (přizpůsobitelné ozubeným kolečkem) a akce hráče. */}
      <RightColumn>
        <RevealPortal
          node={
            // Widget je u stolu stále (když je ukázání karet nebo rabbit hunt povolené); tlačítka jsou šedá, dokud je nelze použít, pak barevná.
            mine && (info.showCards || info.rabbitHunt) ? (
              <>
                {info.showCards && (
                  <>
                    {winnerPref === 'ask' && canShowCards && view.winners?.some((w) => w.seat === mine.seat) && !mine.exposed && <span className="w-full rounded-md border border-primary px-2 py-1 text-sm">{t('table.showWinnerPrompt')}</span>}
                    <button className={canShowCards ? actionTone.show : actionOff} disabled={!canShowCards} onClick={() => void run(table.show(tableId, 'both'))}>
                      {t('table.showCards')}
                    </button>
                    <button className={canShowCards ? actionTone.show : actionOff} disabled={!canShowCards} onClick={() => void run(table.show(tableId, 0))}>
                      {t('table.showCard1')}
                    </button>
                    <button className={canShowCards ? actionTone.show : actionOff} disabled={!canShowCards} onClick={() => void run(table.show(tableId, 1))}>
                      {t('table.showCard2')}
                    </button>
                  </>
                )}
                {info.rabbitHunt && (
                  <button className={canRabbit ? actionTone.special : actionOff} disabled={!canRabbit} onClick={() => void run(table.rabbit(tableId))}>
                    {t('table.rabbit')}
                  </button>
                )}
              </>
            ) : null
          }
        />
        <ToolsPortal
          node={
            mine ? (
              <div className="tk-tools flex flex-wrap items-center gap-2">
                {extra}
          {info.callClock && (
            <button className={canCallClock ? actionTone.special : actionOff} disabled={!canCallClock} onClick={() => void run(table.callClock(tableId))}>
              {t('table.callClock')}
            </button>
          )}
          {info.straddle === 'optional' && (
            <button className={actionTone.special} aria-pressed={view.myStraddle} onClick={() => void run(table.straddle(tableId, !view.myStraddle))}>
              {view.myStraddle ? t('table.straddleOff') : t('table.straddleOn')}
            </button>
          )}
          {!info.tournament && (info.topUpEnabled || (mine.stack === 0 && info.rebuyEnabled)) && (
            <button className={actionTone.add} onClick={() => setDialog({ kind: 'topUp' })}>
              {mine.stack === 0 ? t('table.rebuy') : t('table.topUp')}
            </button>
          )}
          {!info.tournament && (
            <button className={actionTone.leave} onClick={() => void run(table.leave(tableId))}>
              {t('table.leave')}
            </button>
          )}
              </div>
            ) : extra ? (
              <div className="tk-tools flex flex-wrap items-center gap-2">{extra}</div>
            ) : null
          }
        />
      </RightColumn>

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

const BUBBLE_TONE: Record<Bubble['kind'], string> = {
  fold: 'bg-act-fold text-on-act',
  reraise: 'bg-act-raise text-on-act',
  check: 'bg-act-check text-on-act',
  call: 'bg-act-call text-on-act',
  bet: 'bg-act-raise text-on-act',
  raise: 'bg-act-raise text-on-act',
  allIn: 'bg-accent text-on-act',
};

/** Sedadlo jako na předloze: karty, pod nimi jméno a stack jako text na plátně, dealer button vedle karet. */
function Seat({
  seat,
  view,
  mine,
  offset,
  inBb,
  oddsPct,
  sound,
  action,
  deal,
  dealFrom,
  dealTo,
  bubbleSide,
}: {
  seat: SeatView;
  view: TableView;
  mine: boolean;
  offset: number;
  inBb: boolean;
  oddsPct?: { win: number; tie: number };
  sound?: { emoji: string; name: string };
  action?: Bubble;
  /** Rozdávání nové handy: zpoždění karet a odkud (od tlačítka) letí. */
  deal?: DealState;
  dealFrom?: { left: number; top: number };
  dealTo?: { left: number; top: number };
  /** Sedadla v dolní části stolu mají bublinu vedle karet, aby se nepřekrývala se sázkou, která leží nad nimi. */
  bubbleSide?: 'left' | 'right';
}) {
  const userSettings = useSettings().values;
  const showRank = userSettings['xp.showAtTable'] !== false;
  // Zakryté vlastní karty: ukážou se jen při přejetí myší (na dotykovém displeji klepnutím).
  const hideMine = mine && userSettings['ui.hideMyCards'] === true;
  const [peek, setPeek] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const look = useLook(seat.playerId);
  const frame = avatarClasses(look, '');
  const won = view.winners?.find((w) => w.seat === seat.seat);
  const acting = view.actingSeat === seat.seat;
  // Sit out (i ten, který začne po dohrání handy) musí být u stolu na první pohled vidět: šedé sedadlo a výrazný odznak.
  const out = seat.status === 'sittingOut' || seat.sitOut === true;
  const dim = seat.status === 'folded' || seat.status === 'sittingOut' || seat.status === 'waiting';
  const pct = oddsPct ? `${(oddsPct.win * 100).toFixed(1)} %` : null;
  // Co hráč s kartami udělal: ukázal obě / jednu (po handě bez showdownu), odhodil je (muck), nebo se ještě rozhoduje.
  const shownCount = seat.exposed ? seat.exposed.filter((c) => c !== null).length : 0;
  const revealLabel = seat.reveal === 'deciding' ? t('table.deciding') : seat.reveal === 'muck' ? (seat.cards ? t('table.muck') : null) : shownCount === 2 ? t('table.shownBoth') : shownCount === 1 ? t('table.shownOne') : null;
  // Rozdávání: karta se objeví ve svém „kroku“ a doletí od tlačítka; mimo rozdávání se nic nenastavuje.
  const dealDelay = (i: number) => deal?.delayMs(seat.seat, i);
  const dealFly = deal?.active && dealFrom && dealTo ? flyOffset(dealFrom, dealTo) : undefined;
  const status = seat.status === 'allIn' ? t('table.allIn') : seat.status === 'folded' ? t('table.fold') : seat.status === 'sittingOut' ? t('table.sittingOut') : seat.status === 'waiting' ? t('table.waiting') : null;
  return (
    <div className={`tk-seat ${mine ? 'tk-seat-mine' : ''} ${acting ? 'tk-seat-acting' : ''} ${won ? 'tk-seat-won' : ''} ${dim ? 'tk-seat-dim' : ''} ${out ? 'tk-seat-out' : ''}`}>
      <div className="relative flex justify-center">
        <div
          className={`tk-seat-cards flex gap-1 ${frame.cls} ${hideMine ? 'cursor-pointer' : ''} ${seat.status === 'folded' ? 'tk-fold-away' : ''}`}
          title={hideMine ? t('table.peek') : undefined}
          onMouseEnter={hideMine ? () => setPeek(true) : undefined}
          onMouseLeave={hideMine ? () => setPeek(false) : undefined}
          onPointerDown={hideMine ? (e) => e.pointerType === 'touch' && setPeek((v) => !v) : undefined}
        >
          {seat.hasCards
            ? seat.reveal === 'muck' && !seat.cards
              ? <span className="tk-seat-status tk-muck-in">{t('table.muck')}</span>
              : seat.cards && !(hideMine && !peek)
              ? seat.cards.map((c, i) => <CardView key={seat.exposed?.[i] ? `${c}-shown` : c} card={c} small={!mine} reveal={!mine} shown={seat.exposed?.[i] ? (mine ? 'self' : 'other') : undefined} delayMs={dealDelay(i)} fly={dealFly} />)
              : [0, 1].map((i) => <CardView key={seat.exposed?.[i] ? `x-${seat.exposed[i]}` : `${view.handId}-${i}`} card={seat.exposed?.[i] ?? null} small={!mine} reveal={!!seat.exposed?.[i]} shown={seat.exposed?.[i] ? 'other' : undefined} delayMs={dealDelay(i)} fly={dealFly} />)
            : status && !out && <span className="tk-seat-status">{status}</span>}
        </div>
        {seat.isDealer && (
          <span className="tk-dealer" title={t('table.dealer')}>
            D
          </span>
        )}
        {view.straddleSeat === seat.seat && <span className="tk-straddle">S</span>}
        {revealLabel && (
          <span className="tk-seat-reveal" role="status">
            {revealLabel}
          </span>
        )}
        {frame.sparkle && (
          <span aria-hidden className="absolute -right-2 -top-2 text-xs">
            ✨
          </span>
        )}
        {(action || sound) && (
          <span key={action?.key ?? sound?.name} role="status" className={`tk-bubble ${bubbleSide ? `tk-bubble-${bubbleSide}` : ''} ${action ? `tk-say-${action.kind} ${BUBBLE_TONE[action.kind]}` : 'tk-say-call bg-surface text-text'}`}>
            {action ? action.text : `${sound!.emoji} ${sound!.name}`}
          </span>
        )}
        {won && (
          <span key={view.handId} aria-hidden className="tk-float absolute -top-3 right-0 font-mono text-sm font-bold text-accent">
            +{formatAmount(won.amount, view.info, inBb)}
          </span>
        )}
      </div>
      <div className="tk-seat-name" title={out ? (seat.status === 'sittingOut' ? t('table.sittingOut') : t('table.sitOutPending')) : undefined}>
        {out && <span aria-hidden="true">⏸</span>}
        {showRank && <RankBadge userId={seat.playerId} />}
        <LookName userId={seat.playerId}>{seat.name}</LookName>
        {!mine && <NoteDot userId={seat.playerId} onOpen={() => setNoteOpen(true)} />}
      </div>
      {noteOpen && <NoteDialog userId={seat.playerId} nickname={seat.name} onClose={() => setNoteOpen(false)} />}
      <div className="tk-seat-stack">
        <Amount amount={seat.stack} text={formatAmount(seat.stack, view.info, inBb)} />
        {seat.hasCards && status && <span className="ml-1 text-xs opacity-80">{status}</span>}
      </div>
      {acting && <TimerBar deadline={view.deadline} offset={offset} bank={view.bankActive} />}
      {((seat.wanted ?? 0) > 0 || (seat.bounty ?? 0) > 0 || pct) && (
        <div className="flex justify-center gap-1">
          {(seat.wanted ?? 0) > 0 && (
            <span className="rounded-md bg-danger px-1 font-mono text-xs text-on-primary" title={t('tournament.wanted')}>
              ⚑ {seat.wanted}
            </span>
          )}
          {(seat.bounty ?? 0) > 0 && (
            <span className="rounded-md bg-accent px-1 font-mono text-xs text-on-act" title={t('tournament.head')}>
              ☠ {seat.bounty}
            </span>
          )}
          {pct && <span className="rounded-md bg-info px-1 font-mono text-xs text-on-act">{pct}</span>}
        </div>
      )}
    </div>
  );
}

function AmountDialog({ title, view, balance, onCancel, onOk }: { title: string; view: TableView; balance: number; onCancel: () => void; onOk: (currency: number) => void }) {
  const info = view.info;
  const rate = info.chipsPerCurrencyUnit;
  const min = Math.ceil(info.minBuyIn / rate);
  const max = Math.min(Math.floor(info.maxBuyIn / rate), balance);
  const [v, setV] = useState(Math.min(max, Math.max(min, Math.floor((min + max) / 2))));
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="text-sm text-muted">
        {t('table.wallet')}:{' '}
        <span className="font-mono">
          {balance} {info.currencySymbol}
        </span>
      </p>
      <div className="flex items-center gap-3">
        <input aria-label={t('table.amount')} type="range" className="flex-1" min={min} max={Math.max(min, max)} value={v} onChange={(e) => setV(Number(e.target.value))} />
        <input aria-label={t('table.amountExact')} type="number" className="w-28 rounded-sm border border-line bg-surface px-2 py-1 font-mono" min={min} max={max} value={v} onChange={(e) => setV(Number(e.target.value))} />
      </div>
      <div className="flex gap-2">
        <button className={btnPrimary} onClick={() => onOk(v)}>
          {t('table.confirm')}
        </button>
        <button className={btn} onClick={onCancel}>
          {t('table.cancel')}
        </button>
      </div>
    </Modal>
  );
}

/** Akce hráče (Sit out, Dokoupit, Odejít, ukázání karet…) se vykreslí do místa, kde je právě widget „Akce u stolu“ (v levém nebo pravém panelu). */
/** Tlačítka pro ukázání karet po handě: vlastní widget, aby nesdílela místo s jinými akcemi. */
function RevealPortal({ node }: { node: ReactNode | null }) {
  const { revealSlot, setHasReveal } = useTableWidgets();
  const has = node !== null;
  useEffect(() => setHasReveal(has), [has, setHasReveal]);
  return node !== null && revealSlot ? createPortal(node, revealSlot) : null;
}

function ToolsPortal({ node }: { node: ReactNode | null }) {
  const { toolsSlot, setHasTools } = useTableWidgets();
  const has = node !== null;
  useEffect(() => setHasTools(has), [has, setHasTools]);
  return node !== null && toolsSlot ? createPortal(node, toolsSlot) : null;
}

/** Rozměry pravého sloupce se přenášejí do CSS proměnných (mimo JSX, styl nemá obsahovat pevné hodnoty). */
function sideStyle(w: number, h: number): CSSProperties {
  const style: Record<string, string> = {};
  if (w > 0) style['--tk-side-w'] = w + 'px';
  if (h > 0) style['--tk-side-h'] = h + 'px';
  return style as CSSProperties;
}

/** Pravý sloupec vedle stolu se stejně nastavitelnou velikostí jako levý panel (tažení za okraj, dvojklik = výchozí). */
function RightColumn({ children }: { children: ReactNode }) {
  const values = useSettings().values;
  const stored = { w: Number(values['ui.tableSideWidth'] ?? 0), h: Number(values['ui.tableSideHeight'] ?? 0) };
  const [size, setSize] = useState(stored);
  const [dragging, setDragging] = useState(false);
  // Výška se uloží jen tehdy, když ji hráč skutečně tahal (tažení za šířku ji jinak zafixuje na aktuální hodnotu).
  const heights = useRef(new Set<number>());
  useEffect(() => {
    if (!dragging) setSize({ w: Number(values['ui.tableSideWidth'] ?? 0), h: Number(values['ui.tableSideHeight'] ?? 0) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored.w, stored.h, dragging]);
  const keep = (key: string, value: number) => void saveUserSetting(key, value).catch(() => undefined);
  return (
    <Resizable
      className="tk-extra tk-side relative flex flex-col gap-2"
      style={sideStyle(size.w, size.h)}
      side="left"
      w={size.w}
      h={size.h}
      limits={{ minW: 120, maxW: 560, minH: 120, maxH: 3000 }}
      onChange={(w, h, commit) => {
        setDragging(!commit);
        heights.current.add(h);
        setSize({ w, h: heights.current.size > 1 || stored.h > 0 ? h : stored.h });
        if (commit) {
          if (w !== stored.w) keep('ui.tableSideWidth', w);
          if (heights.current.size > 1 && h !== stored.h) keep('ui.tableSideHeight', h);
          heights.current = new Set();
        }
      }}
      onReset={() => {
        setSize({ w: defaultOf('ui.tableSideWidth'), h: defaultOf('ui.tableSideHeight') });
        keep('ui.tableSideWidth', defaultOf('ui.tableSideWidth'));
        keep('ui.tableSideHeight', defaultOf('ui.tableSideHeight'));
      }}
    >
      <Panel side="right" />
      {children}
    </Resizable>
  );
}
