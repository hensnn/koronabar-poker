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
import { formatAmount, seatPosition, tableMoney } from './format';
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
import { MobileMid } from './mobile-ui';
import { avatarClasses, LookName, useLook, useMyTableLook } from '../cosmetics-client';
import { ErrorToast, isConfirmKey, Modal, useArrowChoices } from '../ui';
import { ChipStack } from './Chips';
import { ChipSweeps, useChipSweeps } from './chip-fx';
import { usePlanExecutor } from './plan';
import { useMobileLayout } from './mobile';
import { actionOff, actionOffSm, actionTone, actionToneSm } from './buttons';
import { PlayerCard } from './PlayerCard';
import { TableFx, useTableNotices, useTournamentFx } from './fx';
import { useTableSize } from './size';
import { DealButton, EntryActions } from './InfoCard';
import { ShowdownPrefs } from './TablePanel';

interface Props {
  tableId: string;
  inBb: boolean;
  quickPost: string;
  quickPre: string;
  /** Doplňková tlačítka pod akční lištou (zvuky, ankety…). */
  extra?: React.ReactNode;
  /** Nové mobilní rozložení: bez pravého sloupce a bez pruhu s akcemi pod stolem (jsou v zásuvkách). */
  modern?: boolean;
}

const btn = 'rounded-md border border-line bg-surface px-3 py-1';
const btnPrimary = 'rounded-md border border-primary bg-primary px-3 py-1 text-on-primary';

/** Run it: karty dalšího běhu se rozdávají postupně; výherce se ukáže až po nich. */
const RUN_FIRST_MS = 250;
const RUN_STEP_MS = 450;
const runCardDelay = (index: number) => RUN_FIRST_MS + index * RUN_STEP_MS;
const runDelayStyle = (fresh: number) => ({ animationDelay: `${fresh === 0 ? 0 : runCardDelay(fresh)}ms` });

/** Sázka hráče leží mezi jeho sedadlem a středem stolu; na telefonu blíž ke středu, aby ji nezakrývaly karty. */
function betPosition(seat: number, viewerSeat: number | null, count: number, mobile: boolean, mineCardsTop: number | null = null) {
  const p = seatPosition(seat, viewerSeat, count);
  const fx = mobile ? 0.5 : 0.52;
  const fy = mobile ? 0.4 : 0.6;
  const pos = { left: 50 + (p.left - 50) * fx, top: 50 + (p.top - 50) * fy };
  // Moje sázka leží před mým sedadlem, ale nejvýš tak nízko, aby nezakrývala moje karty: v motivech s většími kartami se posune o kus výš.
  if (mineCardsTop !== null && viewerSeat !== null && (seat - viewerSeat + count) % count === 0) pos.top = Math.min(pos.top, mineCardsTop - BET_ABOVE_CARDS);
  return pos;
}

/** O kolik procent výšky stolu leží střed sázky nad horním okrajem mých karet (výška hromádky žetonů s částkou). */
const BET_ABOVE_CARDS = 9;

export function TableScreen({ tableId, inBb, quickPost, quickPre, extra, modern = false }: Props) {
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
  const runItPref = String(useSettings().values['ui.runItResponse'] ?? 'ask');
  const winnerPref = String(useSettings().values['ui.showdownWinning'] ?? 'never');
  const mobile = useMobileLayout();
  const betChips = useSettings().values['ui.betChips'] !== false;
  // Pohyb žetonů: konec ulice (sázky do potu) a konec handy (pot k výherci); polohy se počítají jako u sedadel a sázek.
  const sweepSeat = () => {
    const v = view!;
    const mineSeat = v.seats.find((s) => s.playerId === userId)?.seat;
    return { viewer: rotate ? (v.viewerSeat ?? mineSeat ?? 0) : 0, count: v.info.seatCount };
  };
  // Kde končí moje karty u stolu (horní okraj v % výšky stolu): podle toho se sázka před sedadlem posune, aby karty nezakrývala.
  const tableEl = useRef<HTMLDivElement>(null);
  const [mineCardsTop, setMineCardsTop] = useState<number | null>(null);
  useEffect(() => {
    const measure = () => {
      const table = tableEl.current;
      const cards = table?.querySelector('.tk-seat-mine .tk-seat-cards');
      if (!table || !cards) return setMineCardsTop(null);
      const t = table.getBoundingClientRect();
      const c = cards.getBoundingClientRect();
      if (t.height <= 0) return;
      const v = ((c.top - t.top) / t.height) * 100;
      setMineCardsTop((prev) => (prev !== null && Math.abs(prev - v) < 0.5 ? prev : v));
    };
    measure();
    window.addEventListener('resize', measure);
    const id = window.setInterval(measure, 1500);
    return () => {
      window.removeEventListener('resize', measure);
      window.clearInterval(id);
    };
  });
  const sweeps = useChipSweeps(view, betChips, {
    bet: (seat) => betPosition(seat, sweepSeat().viewer, sweepSeat().count, mobile, mineCardsTop),
    seat: (seat) => seatPosition(seat, sweepSeat().viewer, sweepSeat().count),
    pot: { left: 50, top: 52 },
  });
  usePlanExecutor(view, tableId);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'join'; seat: number } | { kind: 'topUp' } | null>(null);
  // Nový dialog začíná bez staré chyby.
  useEffect(() => {
    if (dialog) setError('');
  }, [dialog]);

  // Dokoupení žetonů lze vyvolat i z panelu vlevo (widget Akce).
  useEffect(() => {
    const open = () => setDialog({ kind: 'topUp' });
    window.addEventListener('kb:topup', open);
    return () => window.removeEventListener('kb:topup', open);
  }, []);

  // Osobní odpověď na hlasování o run it twice (vždy / nikdy): pošle se sama, bez dotazu.
  const vote = view?.vote;
  const autoVote = vote?.kind === 'runit' && vote.status === 'open' && vote.canVote && (vote.myVote === null || vote.myVote === undefined) && runItPref !== 'ask';
  useEffect(() => {
    if (autoVote) void table.vote(tableId, runItPref === 'always');
  }, [autoVote, runItPref, tableId]);

  // Nabídky přes stůl (ukázat karty, souhlas s run it twice): Enter nebo mezerník zvolí hlavní odpověď.
  const prompt = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!prompt.current || !isConfirmKey(e) || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      prompt.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  const { tour, layout, actionsInline, setToolsSlot, actionLog } = useTableWidgets();
  const tournamentId = view?.info.tournament ? (view.info.tournamentId ?? tableId) : null;
  // Hráč, na kterého ukazuje myš: karta s informacemi v rohu u stolu.
  const [hoverSeat, setHoverSeat] = useState<number | null>(null);
  // Klepnutí (dotyk) na hráče kartu připne; zavře se klepnutím mimo hráče nebo znovu na něj.
  const fx = useTournamentFx(tournamentId, view);
  const notices = useTableNotices(tableId);
  const waitInfo = useSettings().values['ui.tableWaitInfo'] !== false;
  const roomSize = useTableSize();
  // Hlasování o run it twice a volba ukázat/zahodit karty: výběr jde přepínat kurzorovými šipkami (Tab funguje sám).
  const choiceRef = useRef<HTMLDivElement>(null);
  useArrowChoices(choiceRef, true, '[role=dialog] button:not(:disabled)');
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
  prompt.current = !mine || dialog ? null : view.showdownChoice ? () => void run(table.showdown(tableId, 'show')) : view.vote?.kind === 'runit' && runItPref === 'ask' && view.vote.status === 'open' && view.vote.canVote && view.vote.myVote !== true ? () => void run(table.vote(tableId, true)) : null;

  // Run it: pot leží nad řádky jednotlivých běhů, aby se s nimi a s mými kartami nepřekrýval.
  const multiRun = !!view.runs && view.runs.length >= 1;
  // Co mám na tahu udělat: dorovnat (kolik), nebo check/sázka; místo obecného „Jsi na tahu“.
  const toCall = view.legal?.callAmount ?? 0;
  const turnText = !view.legal ? t('table.yourTurn') : toCall > 0 ? t(mine && toCall >= mine.stack ? 'table.turn.callAllIn' : 'table.turn.call') : t(view.legal.canRaise ? 'table.turn.checkOrRaise' : 'table.turn.checkOrBet');
  const settledPot = view.pots.reduce((n, p) => n + p.amount, 0);
  const potEl = (
    <div className="tk-pot flex items-center justify-center gap-2" aria-label={t('table.pot')}>
      {/* Text s hodnotou potu je nalevo od žetonů v banku. */}
      <span>
        {t('table.pot')}: {formatAmount(view.totalPot, info, inBb)}
        {view.bombPot && <span className="ml-2 rounded-md bg-accent px-2 text-on-act">{t('table.bombPot')}</span>}
      </span>
      {betChips && settledPot > 0 && <ChipStack amount={settledPot} unit={info.smallBlind} />}
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
  // Plovoucí lišta „Ukázat karty“ (pravý dolní roh stolu): jen když je co ukázat; výherce s volbou „zahodit“ ji nevidí, už ukázané karty ji zavřou.
  const iWon = !!(mine && view.winners?.some((w) => w.seat === mine.seat));
  const showBar = canShowCards && !(iWon && winnerPref === 'never') && !(mine?.exposed && mine.exposed.every(Boolean));
  const canRabbit = !!(view.winners && mine?.hasCards && info.rabbitHunt && view.board.length < 5 && !view.rabbit);

  return (
    <div className={`tk-screen flex flex-col gap-2 ${layout.hiddenSides.includes('right') ? 'tk-no-extra' : ''}`}>
      <div className="tk-room relative" style={{ '--room-h': String(roomSize.h) } as CSSProperties} {...myLook}>
        {mine && canRabbit && (
          <div role="group" aria-label={t('table.widget.reveal')} className="tk-pop absolute bottom-1 right-1 z-20 flex flex-wrap items-center gap-1.5 rounded-md border border-info bg-surface p-1.5 shadow-lg">
            {canRabbit && (
              <button className={actionToneSm.special} onClick={() => void run(table.rabbit(tableId))}>
                {t('table.rabbit')}
              </button>
            )}
          </div>
        )}
        {fx.length > 0 && <TableFx fx={fx} view={view} viewerSeat={view.viewerSeat ?? 0} />}
        {notices.length > 0 && (
          <div role="status" className="pointer-events-none absolute inset-x-0 top-2 z-20 flex flex-col items-center gap-1">
            {notices.map((n) => (
              <span key={n.key} className="tk-pop rounded-md border border-accent bg-surface px-3 py-1 text-sm font-semibold shadow-lg">
                ✨ {n.text}
              </span>
            ))}
          </div>
        )}
        {hovered && <PlayerCard seat={hovered} view={view} tour={tour} inBb={inBb} />}
        <div ref={tableEl} className="tk-table relative mx-auto">
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
              const p = betPosition(s.seat, viewerSeat, info.seatCount, mobile, mineCardsTop);
              const from = seatPosition(s.seat, viewerSeat, info.seatCount);
              return (
                <div key={`bet-${s.seat}-${s.bet}`} className={`tk-chip-fly absolute -translate-x-1/2 -translate-y-1/2 ${betChips ? 'tk-bet-wrap flex flex-col items-center gap-0.5' : 'tk-bet'}`} style={{ left: `${p.left}%`, top: `${p.top}%`, ['--from-left' as string]: `${from.left}%`, ['--from-top' as string]: `${from.top}%` }}>
                  {betChips ? (
                    <>
                      <ChipStack amount={s.bet} unit={info.smallBlind} />
                      <span className="tk-bet">{formatAmount(s.bet, info, inBb)}</span>
                    </>
                  ) : (
                    <Amount amount={s.bet} text={formatAmount(s.bet, info, inBb)} />
                  )}
                </div>
              );
            })}
          {betChips && <ChipSweeps sweeps={sweeps} unit={info.smallBlind} />}

          {/* sedadla po obvodu */}
          {seatNumbers.map((n) => {
            const seat = view.seats.find((s) => s.seat === n);
            const pos = seatPosition(n, viewerSeat, info.seatCount);
            return (
              // Sedadlo s bublinou nebo štítkem musí ležet nad sousedními sedadly i nad sázkami (každé sedadlo je vlastní vrstva).
              <div key={n} data-seat-wrap className="absolute -translate-x-1/2 -translate-y-1/2" onClick={seat ? () => setPinnedSeat((p) => (p === n ? null : n)) : undefined} onMouseEnter={seat ? () => setHoverSeat(n) : undefined} onMouseLeave={seat ? () => setHoverSeat((h) => (h === n ? null : h)) : undefined} onFocus={seat ? () => setHoverSeat(n) : undefined} onBlur={seat ? () => setHoverSeat((h) => (h === n ? null : h)) : undefined} style={{ left: `${pos.left}%`, top: `${pos.top}%`, zIndex: seat && (actionBubbles[n] || soundBubbles[seat.playerId] || seat.reveal || seat.exposed) ? 5 : undefined }}>
                {seat ? (
                  <Seat seat={seat} view={view} mine={seat.playerId === userId} offset={net.clockOffset} inBb={inBb} oddsPct={mainOdds?.entries.find((e) => e.seat === seat.seat)} sound={soundBubbles[seat.playerId]} action={actionBubbles[seat.seat]} deal={deal} dealFrom={view.buttonSeat !== null ? seatPosition(view.buttonSeat, viewerSeat, info.seatCount) : undefined} dealTo={pos} bubbleSide={pos.top > 62 ? (pos.left < 50 ? 'left' : 'right') : undefined} onShowCard={seat.playerId === userId && showBar ? (i) => void run(table.show(tableId, i)) : undefined} />
                ) : info.tournament ? null : (
                  <button className="tk-seat-empty" disabled={seated} onClick={() => setDialog({ kind: 'join', seat: n })}>
                    {t('table.sit')}
                  </button>
                )}
                {/* Dealer button na prázdném sedadle (hráč odešel, button zůstal na jeho místě): musí být vidět i tam. */}
                {!seat && view.buttonSeat === n && (
                  <span className="tk-dealer" title={t('table.dealer')}>
                    D
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {/* Hlasování a rozhodnutí o ukázání karet leží přes stůl, aby byly vidět i na celé obrazovce a na telefonu. */}
        <div ref={choiceRef} className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 p-2">
      {view.vote && view.vote.kind === 'runit' && view.vote.status !== 'open' && (() => {
        const v = view.vote!;
        const times = String((v.payload as { times: number }).times);
        const nameOf = (id: string) => view.seats.find((x) => x.playerId === id)?.name ?? '?';
        const against = v.voters.filter((x) => x.vote === false).map((x) => nameOf(x.userId));
        const silent = v.voters.filter((x) => x.vote === null).map((x) => nameOf(x.userId));
        const text = v.status === 'passed' ? t('table.runIt.resultYes', { times }) : against.length > 0 ? t('table.runIt.resultNo', { names: against.join(', ') }) : silent.length > 0 ? t('table.runIt.resultExpired', { names: silent.join(', ') }) : t('table.runIt.resultCancelled');
        return (
          <div role="status" className={`pointer-events-none w-full max-w-sm rounded-md border-2 bg-surface p-3 text-center font-semibold shadow-lg ${v.status === 'passed' ? 'border-info' : 'border-warning'}`}>
            {text}
          </div>
        );
      })()}
      {mine && view.vote && view.vote.kind === 'runit' && view.vote.status === 'open' && runItPref === 'ask' && (
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

      {/* Vše vedle stolu (stav tahu, akční lišta, akce, widgety) je v jednom obalu: na šířku telefonu tvoří vlastní posuvný sloupec, jinde je obal průhledný. */}
      <div className="tk-side-col">
      {modern && <MobileMid view={view} mine={mine} inBb={inBb} offset={net.clockOffset} log={actionLog.slice(-3)} tableId={tableId} />}
      {/* stav tahu: výrazně pro mě, decentně pro ostatní */}
      <div className={`tk-turn-row ${view.ready ? 'tk-turn-ready' : ''}`}>
      {myTurn ? (
        <div role="status" className="tk-your-turn tk-pop">
          <span className="inline-flex items-center justify-center gap-3">
            <Countdown deadline={view.deadline} offset={net.clockOffset} />
            <span className="font-bold">{turnText}</span>
            {toCall > 0 && <span className="rounded-md bg-surface px-2 font-mono text-lg font-bold text-text">{formatAmount(toCall, info, inBb)}</span>}
          </span>
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
      {!myTurn && !acting && (
        <p role="status" className="text-center text-sm text-muted">
          {showBar && <span className="font-semibold text-info">{t('table.tapToShow')} · </span>}
          {waitInfo && view.vote && view.vote.status === 'open' && !view.vote.canVote ? (
            <>
              🗳️ {t('table.wait.vote', { voted: view.vote.tally.voted, total: view.vote.tally.total })} · <Countdown deadline={view.vote.deadline} offset={net.clockOffset} />
            </>
          ) : waitInfo && view.choice ? (
            <>
              🃏 {t('table.wait.choice', { n: view.choice.count })} · <Countdown deadline={view.choice.deadline} offset={net.clockOffset} />
            </>
          ) : view.paused ? (
            `⏸ ${t('table.paused')}`
          ) : view.handId && view.winners === null && view.street !== null ? (
            t('table.handRunning')
          ) : waitInfo && view.nextHandAt ? (
            <>
              {t('table.wait.nextHand')} <Countdown deadline={view.nextHandAt} offset={net.clockOffset} />
            </>
          ) : waitInfo && view.seats.filter((s) => s.status !== 'sittingOut').length < 2 ? (
            t('table.wait.players')
          ) : (
            t('table.waitingPlayers')
          )}
          {/* Pauza nebo přestávka: „Jsem ready“; když je ready dost hráčů, pauza skončí dřív. */}
          {view.ready && (
            <button className={`ml-2 rounded-md border px-3 py-1 text-base font-semibold ${view.ready.mine ? 'border-primary bg-primary text-on-primary' : 'border-line bg-surface text-text'}`} aria-pressed={view.ready.mine} title={t('table.ready.help')} onClick={() => void run(table.ready(tableId, !view.ready!.mine))}>
              {view.ready.mine ? '✔ ' : ''}
              {t('table.ready')} ({view.ready.count}/{view.ready.needed})
            </button>
          )}
          {view.ready && view.ready.waitMs > 0 && <span className="ml-2 text-xs">{t('table.ready.wait', { s: Math.ceil(view.ready.waitMs / 1000) })}</span>}
        </p>
      )}
      </div>

      {modern && mine && (mine.sitOut ?? mine.status === 'sittingOut') && (
        <button className="tk-sitin rounded-lg border-2 border-primary bg-primary text-on-primary font-bold" onClick={() => void run(table.sitIn(tableId))}>
          ▶ {t('table.sitIn')}
        </button>
      )}
      {mine && !(modern && (mine.sitOut ?? mine.status === 'sittingOut')) && <ActionBar view={view} legal={deal.active ? null : view.legal} inBb={inBb} quickPost={quickPost} quickPre={quickPre} onAct={(a) => void run(table.act(tableId, a))} onStraddle={(want) => void run(table.straddle(tableId, want))} />}

      {/* Akce hráče: malá tlačítka v widgetu „O hře“; když ten není vidět (telefon, vypnutý panel), v pruhu pod stolem. */}
      <ActionsPortal
        node={
          mine || extra ? (
            <div className="flex flex-col gap-1.5">
              {!modern && mine && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <label className="flex items-center gap-1 text-xs" title={t('table.sitOutHelp')}>
                    <input type="checkbox" role="switch" aria-label={t('table.sitOutToggle')} checked={mine.sitOut ?? mine.status === 'sittingOut'} onChange={(e) => void run(e.target.checked ? table.sitOut(tableId) : table.sitIn(tableId))} />
                    <span className={(mine.sitOut ?? mine.status === 'sittingOut') ? 'font-semibold text-warning' : ''}>{t('table.sittingOut')}</span>
                  </label>
                  <ShowdownPrefs />
                </div>
              )}
              {mine && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {info.callClock && (
                    <button className={canCallClock ? actionToneSm.special : actionOffSm} disabled={!canCallClock} onClick={() => void run(table.callClock(tableId))}>
                      {t('table.callClock')}
                    </button>
                  )}
                  {!info.tournament && (info.topUpEnabled || (mine.stack === 0 && info.rebuyEnabled)) && (
                    <button className={actionToneSm.add} onClick={() => setDialog({ kind: 'topUp' })}>
                      {mine.stack === 0 ? t('table.rebuy') : t('table.topUp')}
                    </button>
                  )}
                  {!info.tournament && (
                    <button className={actionToneSm.leave} onClick={() => void run(table.leave(tableId))}>
                      {t('table.leave')}
                    </button>
                  )}
                  <EntryActions tour={tour} tournamentId={tournamentId} />
                  <DealButton tour={tour} tournamentId={tournamentId} />
                </div>
              )}
              {extra && <div className="flex flex-wrap items-center gap-2">{extra}</div>}
            </div>
          ) : null
        }
      />
      {modern && mine && <InfoPortal node={<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <label className="flex items-center gap-1 text-xs" title={t('table.sitOutHelp')}>
                    <input type="checkbox" role="switch" aria-label={t('table.sitOutToggle')} checked={mine.sitOut ?? mine.status === 'sittingOut'} onChange={(e) => void run(e.target.checked ? table.sitOut(tableId) : table.sitIn(tableId))} />
                    <span className={(mine.sitOut ?? mine.status === 'sittingOut') ? 'font-semibold text-warning' : ''}>{t('table.sittingOut')}</span>
                  </label>
                  <ShowdownPrefs />
                </div>} />}
      {actionsInline && !modern && (mine || extra) && (
        <div className="rounded-md border border-line bg-surface p-2">
          <div ref={setToolsSlot} />
        </div>
      )}

      {/* Pravý panel: widgety o hře (přizpůsobitelné); vypnutý panel se nevykreslí. */}
      {!modern && !layout.hiddenSides.includes('right') && <RightColumn />}
      </div>

      {/* Chyby jsou vidět i při otevřeném dialogu: v dialogu přímo, jinak jako plovoucí lišta nad vším. */}
      {!dialog && <ErrorToast message={error} onClose={() => setError('')} />}

      {dialog && (
        <AmountDialog
          title={dialog.kind === 'join' ? t('table.buyIn') : t('table.topUp')}
          topUp={dialog.kind === 'topUp'}
          error={error}
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
  onShowCard,
}: {
  seat: SeatView;
  /** Klepnutí na vlastní kartu ji ukáže (jen když je ukázání karet právě možné). */
  onShowCard?: (i: 0 | 1) => void;
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
  // Zakryté vlastní karty se při showdownu a odhalení (all-in) otočí i mně: ostatní už je vidí, takže skrývat je nemá smysl.
  const shownToOthers = view.seats.some((x) => x.playerId !== seat.playerId && x.cards !== null);
  const hideMine = mine && userSettings['ui.hideMyCards'] === true && !shownToOthers;
  const [peek, setPeek] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const look = useLook(seat.playerId);
  const frame = avatarClasses(look, '');
  const won = view.winners?.find((w) => w.seat === seat.seat);
  const acting = view.actingSeat === seat.seat;
  // Sit out (i ten, který začne po dohrání handy) musí být u stolu na první pohled vidět: šedé sedadlo a výrazný odznak.
  const out = seat.status === 'sittingOut' || seat.sitOut === true;
  const dim = seat.status === 'folded' || seat.status === 'sittingOut' || seat.status === 'waiting';
  const oddsStyle = view.info.oddsStyle ?? 'both';
  const pct = oddsPct ? `${(oddsPct.win * 100).toFixed(view.info.oddsDecimals ?? 1)} %` : null;
  // Co hráč s kartami udělal: ukázal obě / jednu (po handě bez showdownu), odhodil je (muck), nebo se ještě rozhoduje.
  const shownCount = seat.exposed ? seat.exposed.filter((c) => c !== null).length : 0;
  const revealLabel = seat.reveal === 'deciding' ? t('table.deciding') : seat.reveal === 'muck' ? (seat.cards ? t('table.muck') : null) : shownCount === 2 ? t('table.shownBoth') : shownCount === 1 ? t('table.shownOne') : null;
  // Rozdávání: karta se objeví ve svém „kroku“ a doletí od tlačítka; mimo rozdávání se nic nenastavuje.
  const dealDelay = (i: number) => deal?.delayMs(seat.seat, i);
  const dealFly = deal?.active && dealFrom && dealTo ? flyOffset(dealFrom, dealTo) : undefined;
  // Hlasování o run it twice: u každého hlasujícího je vidět, zda souhlasí, nesouhlasí, nebo se na něj čeká (vidí všichni u stolu včetně diváků).
  const runVote = view.vote?.kind === 'runit' ? view.vote.voters.find((v) => v.userId === seat.playerId) : undefined;
  const voteBadge: 'yes' | 'no' | 'wait' | 'silent' | null = !runVote ? null : runVote.vote === true ? 'yes' : runVote.vote === false ? 'no' : view.vote?.status === 'open' ? 'wait' : 'silent';
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
              ? seat.cards.map((c, i) => {
                  const card = <CardView key={seat.exposed?.[i] ? `${c}-shown` : c} card={c} small={!mine} reveal={!mine} shown={seat.exposed?.[i] ? (mine ? 'self' : 'other') : undefined} delayMs={dealDelay(i)} fly={dealFly} />;
                  // Klepnutí na vlastní kartu po handě ji ukáže ostatním (stejně jako lišta v rohu stolu).
                  return onShowCard && !seat.exposed?.[i] ? (
                    <span key={c} role="button" tabIndex={0} className="cursor-pointer" title={t('table.tapToShow')} onClick={(e) => { e.stopPropagation(); onShowCard(i as 0 | 1); }} onKeyDown={(e) => e.key === 'Enter' && onShowCard(i as 0 | 1)}>
                      {card}
                    </span>
                  ) : (
                    card
                  );
                })
              : [0, 1].map((i) => <CardView key={seat.exposed?.[i] ? `x-${seat.exposed[i]}` : `${view.handId}-${i}`} card={seat.exposed?.[i] ?? null} small={!mine} reveal={!!seat.exposed?.[i]} shown={seat.exposed?.[i] ? 'other' : undefined} delayMs={dealDelay(i)} fly={dealFly} />)
            : status && !out && <span className="tk-seat-status">{status}</span>}
        </div>
        {seat.isDealer && (
          <span className="tk-dealer" title={t('table.dealer')}>
            D
          </span>
        )}
        {view.straddleSeat === seat.seat && <span className="tk-straddle">S</span>}
        {(seat.isSmallBlind || seat.isBigBlind) && (
          <span className="tk-blind" data-blind={seat.isBigBlind ? 'big' : 'small'} title={t(seat.isBigBlind ? 'table.bigBlind' : 'table.smallBlind')}>
            {seat.isBigBlind ? 'BB' : 'SB'}
          </span>
        )}
        {voteBadge && (
          <span role="status" className={`absolute -top-5 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full border bg-surface px-2 py-0.5 text-sm font-semibold shadow ${voteBadge === 'yes' ? 'border-info text-info' : voteBadge === 'no' || voteBadge === 'silent' ? 'border-danger text-danger' : 'border-warning text-warning motion-safe:animate-pulse'}`}>
            {voteBadge === 'yes' ? '✓ ' : voteBadge === 'no' || voteBadge === 'silent' ? '✗ ' : '… '}
            {t(`table.runIt.badge.${voteBadge}`)}
          </span>
        )}
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
          {pct && oddsPct && (
            <span className="flex items-center gap-1 rounded-md bg-info px-1 font-mono text-xs text-on-act">
              {oddsStyle !== 'number' && <progress className="tk-odds-bar" max={100} value={Math.round(oddsPct.win * 100)} aria-hidden />}
              {oddsStyle !== 'bar' && pct}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function AmountDialog({ title, topUp, view, balance, error, onCancel, onOk }: { title: string; /** Dokoupení: nejvýš do maximálního buy-inu (počítá se se současným stackem). */ topUp?: boolean; view: TableView; balance: number; /** Chyba z posledního pokusu (např. ochrana hit and run): ukáže se přímo v dialogu. */ error?: string; onCancel: () => void; onOk: (currency: number) => void }) {
  const info = view.info;
  const rate = info.chipsPerCurrencyUnit;
  // Kdo nedávno odešel s větším stackem než je maximum, se smí vrátit se stejným stackem (nad maximální buy-in).
  const back = Math.ceil((view.returnStack ?? 0) / rate);
  const min = topUp ? 1 : Math.max(Math.ceil(info.minBuyIn / rate), back);
  const max = topUp ? Math.min(Math.floor((view.topUpRoom ?? 0) / rate), balance) : Math.min(Math.max(Math.floor(info.maxBuyIn / rate), back), balance);
  const [v, setV] = useState(topUp ? Math.max(min, max) : Math.min(max, Math.max(min, Math.floor((min + max) / 2))));
  const none = max < min;
  return (
    <Modal title={title} onClose={onCancel}>
      {back > 0 && <p className="rounded-md border border-warning px-2 py-1 text-sm">{t('table.returnHint', { amount: tableMoney(back, info) })}</p>}
      <p className="text-sm text-muted">
        {t('table.wallet')}:{' '}
        <span className="font-mono">
          {tableMoney(balance, info)}
        </span>
      </p>
      <div className="flex items-center gap-3">
        <input aria-label={t('table.amount')} type="range" className="flex-1" min={min} max={Math.max(min, max)} value={v} onChange={(e) => setV(Number(e.target.value))} />
        <input aria-label={t('table.amountExact')} type="number" className="w-28 rounded-sm border border-line bg-surface px-2 py-1 font-mono" min={min} max={max} value={v} onChange={(e) => setV(Number(e.target.value))} />
      </div>
      {none && <p className="rounded-md border border-warning px-2 py-1 text-sm">{t(topUp ? 'table.topUpFull' : 'table.buyInNone')}</p>}
      {error && (
        <p role="alert" className="rounded-md border-2 border-danger px-2 py-1 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button className={btnPrimary} disabled={none} onClick={() => onOk(v)}>
          {t('table.confirm')}
        </button>
        <button className={btn} onClick={onCancel}>
          {t('table.cancel')}
        </button>
      </div>
    </Modal>
  );
}

/** Sit out a volba karet po handě se v mobilním rozložení vykreslí do zásuvky s informacemi o stole. */
function InfoPortal({ node }: { node: ReactNode }) {
  const { infoSlot } = useTableWidgets();
  return infoSlot ? createPortal(node, infoSlot) : null;
}

/** Akce hráče se vykreslí do místa, kde je právě slot (widget „O hře“, nebo pruh pod stolem). */
function ActionsPortal({ node }: { node: ReactNode | null }) {
  const { toolsSlot } = useTableWidgets();
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
function RightColumn() {
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
    </Resizable>
  );
}
