import { useEffect, useRef, useState } from 'react';
import type { LegalActions, PlayerAction, TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { formatAmount, parseList, quickBetDefaults } from './format';
import { useSettings } from '../settings';
import { PlanBar } from './TablePanel';

interface Props {
  view: TableView;
  /** Dovolené akce; null = nejsem na tahu (lišta zůstává na místě, ukazuje plánovaný tah). */
  legal: LegalActions | null;
  inBb: boolean;
  quickPost: string;
  quickPre: string;
  onAct: (a: PlayerAction) => void;
  /** Přepnutí dobrovolného straddle: je u plánovaného tahu, protože se rozhoduje předem. */
  onStraddle?: (want: boolean) => void;
}

const base = 'tk-act px-5 py-3 text-lg font-semibold disabled:opacity-40';

/**
 * Akční lišta se stálým rozložením: rychlé sázky a posuvník nahoře, dole vždy čtyři místa
 * (Fold, Check/Call, Bet/Raise, All-in), aby se okno stolu při tahu nezvětšovalo ani neposouvalo.
 * Mimo tah je na místě tlačítek plánovaný tah.
 */
export function ActionBar({ view, legal, inBb, quickPost, quickPre, onAct, onStraddle }: Props) {
  const aggress = !!legal && (legal.canBet || legal.canRaise);
  const fixed = view.info.bettingLimit === 'fixedLimit';
  const [amount, setAmount] = useState(legal?.minRaiseTo ?? 0);
  useEffect(() => setAmount(legal?.minRaiseTo ?? 0), [legal?.minRaiseTo, legal?.maxRaiseTo, view.handId, view.street]);
  const info = view.info;
  const mine = view.seats.find((s) => s.seat === view.viewerSeat);
  const myBet = mine?.bet ?? 0;
  const preflop = view.street === 'PREFLOP';
  const min = legal?.minRaiseTo ?? 0;
  const max = legal?.maxRaiseTo ?? 0;
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));

  const quick = preflop
    ? parseList(quickPre, quickBetDefaults.preflop).map((m) => ({ label: `${m}×`, value: clamp(m * info.bigBlind) }))
    : parseList(quickPost, quickBetDefaults.postflop).map((p) => ({ label: `${p} %`, value: clamp(myBet + (view.totalPot * p) / 100) }));
  // Čelím sázce nad svůj stack: dorovnat jde jen všemi žetony, takže All-in (= call všeho) je vždy možný, i když zvyšovat nejde.
  const callIsAllIn = !!legal && !legal.canCheck && legal.callAmount > 0 && !!mine && legal.callAmount >= mine.stack;
  const allInOk = (aggress && !fixed) || callIsAllIn;
  const sliderOn = aggress && !fixed;
  // Klávesové zkratky (osobní nastavení): nereagují při psaní do polí a bez modifikátorů; šipky mění výšku sázky.
  const uiSettings = useSettings().values;
  const hotkeys = uiSettings['ui.hotkeysEnabled'] !== false;
  const keyOf = (k: string) => String(uiSettings[k] ?? '').trim().toLowerCase().slice(0, 1);
  const keys = { fold: keyOf('ui.hotkeyFold'), call: keyOf('ui.hotkeyCall'), bet: keyOf('ui.hotkeyBet'), raise: keyOf('ui.hotkeyRaise'), allIn: keyOf('ui.hotkeyAllIn') };
  // Výška sázky se mění po malém blindu (šipky nahoru/dolů, kolečko); šipky doleva/doprava ladí jemně po nejmenší jednotce.
  const stepBig = info.smallBlind || 1;
  const live = useRef({ legal, amount, clamp, aggress, fixed, sliderOn, allInOk, keys, onAct, step: stepBig });
  live.current = { legal, amount, clamp, aggress, fixed, sliderOn, allInOk, keys, onAct, step: stepBig };
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Posuvník sázky sám šipky nechává na nás (aby skok byl malý blind); ostatní pole si je nechávají.
      const slider = el?.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range';
      if (!slider && el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const s = live.current;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!s.sliderOn) return;
        e.preventDefault();
        const up = e.key === 'ArrowUp' || e.key === 'ArrowRight';
        const by = e.key === 'ArrowUp' || e.key === 'ArrowDown' ? s.step : 1;
        setAmount((a) => s.clamp(a + (up ? by : -by)));
        return;
      }
      if (!s.legal) return;
      const k = e.key.toLowerCase();
      if (k === s.keys.fold && s.legal.canFold) s.onAct({ type: 'fold' });
      else if (k === s.keys.call) s.onAct(s.legal.canCheck ? { type: 'check' } : s.legal.callAmount > 0 ? { type: 'call' } : { type: 'check' });
      else if (k === s.keys.bet && s.legal.canBet) s.onAct({ type: 'bet', amount: s.clamp(s.amount) });
      else if (k === s.keys.raise && s.legal.canRaise) s.onAct({ type: 'raise', amount: s.clamp(s.amount) });
      else if (k === s.keys.allIn && s.allInOk) s.onAct({ type: 'allIn' });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys]);
  // Kolečko myši nad řádkem s posuvníkem mění výšku sázky po big blindech (posluchač bez passive, aby se stránka neposouvala).
  const sliderRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sliderRow.current;
    if (!el || !sliderOn) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = stepBig;
      setAmount((a) => clamp(a + (e.deltaY < 0 ? step : -step)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [sliderOn, stepBig, min, max]);

  return (
    <div className="tk-actionbar flex flex-col gap-2 rounded-lg border border-line bg-surface p-3" data-turn={legal ? 'mine' : 'wait'} role="group" aria-label={t('table.actions')} title={hotkeys ? t('table.hotkeysHint', { fold: keys.fold.toUpperCase(), call: keys.call.toUpperCase(), bet: keys.bet.toUpperCase(), raise: keys.raise.toUpperCase(), allIn: keys.allIn.toUpperCase() }) : undefined}>
      <div ref={sliderRow} className={`tk-slider-row flex flex-wrap items-center gap-2 ${sliderOn ? '' : 'opacity-40'}`} title={sliderOn ? t('table.wheelHint') : undefined}>
        {quick.map((q) => (
          <button key={q.label} className="rounded-md border border-line bg-raised px-3 py-1.5 text-base" disabled={!sliderOn} onClick={() => setAmount(q.value)}>
            {q.label}
          </button>
        ))}
        <input aria-label={t('table.amount')} type="range" className="min-w-24 flex-1" disabled={!sliderOn} min={min} max={Math.max(min, max)} step={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        <input aria-label={t('table.amountExact')} type="number" className="w-28 rounded-sm border border-line bg-surface px-2 py-1.5 font-mono text-lg" disabled={!sliderOn} min={min} max={max} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
      </div>
      {legal ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button className={`${base} tk-act-fold`} disabled={!legal.canFold} onClick={() => onAct({ type: 'fold' })}>
            {t('table.fold')}
          </button>
          {legal.canCheck ? (
            <button className={`${base} tk-act-check`} onClick={() => onAct({ type: 'check' })}>
              {t('table.check')}
            </button>
          ) : (
            <button className={`${base} tk-act-call`} disabled={legal.callAmount <= 0} onClick={() => onAct({ type: 'call' })}>
              {t('table.call')} {legal.callAmount > 0 ? formatAmount(legal.callAmount, info, inBb) : ''}
            </button>
          )}
          <button className={`${base} tk-act-raise`} disabled={!aggress} onClick={() => onAct({ type: legal.canBet ? 'bet' : 'raise', amount: clamp(amount) })}>
            {legal.canBet || !legal.canRaise ? t('table.bet') : t('table.raise')} {aggress ? formatAmount(clamp(amount), info, inBb) : ''}
          </button>
          <button className={`${base} tk-act-allin`} disabled={!allInOk} onClick={() => onAct({ type: 'allIn' })}>
            {t('table.allIn')}
          </button>
        </div>
      ) : (
        <div className="flex min-h-10 flex-wrap items-center gap-2">
          <PlanBar view={view} onStraddle={onStraddle} />
        </div>
      )}
    </div>
  );
}
