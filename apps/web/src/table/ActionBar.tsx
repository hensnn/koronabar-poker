import { useEffect, useRef, useState } from 'react';
import type { LegalActions, PlayerAction, TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { formatAmount, parseList, quickBetDefaults } from './format';
import { PlanBar } from './TablePanel';

interface Props {
  view: TableView;
  /** Dovolené akce; null = nejsem na tahu (lišta zůstává na místě, ukazuje plánovaný tah). */
  legal: LegalActions | null;
  inBb: boolean;
  quickPost: string;
  quickPre: string;
  onAct: (a: PlayerAction) => void;
}

const base = 'tk-act px-4 py-2 font-medium disabled:opacity-40';

/**
 * Akční lišta se stálým rozložením: rychlé sázky a posuvník nahoře, dole vždy čtyři místa
 * (Fold, Check/Call, Bet/Raise, All-in), aby se okno stolu při tahu nezvětšovalo ani neposouvalo.
 * Mimo tah je na místě tlačítek plánovaný tah.
 */
export function ActionBar({ view, legal, inBb, quickPost, quickPre, onAct }: Props) {
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
  const sliderOn = aggress && !fixed;
  // Kolečko myši nad řádkem s posuvníkem mění výšku sázky po big blindech (posluchač bez passive, aby se stránka neposouvala).
  const sliderRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sliderRow.current;
    if (!el || !sliderOn) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = info.bigBlind || 1;
      setAmount((a) => clamp(a + (e.deltaY < 0 ? step : -step)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [sliderOn, info.bigBlind, min, max]);

  return (
    <div className="tk-actionbar flex flex-col gap-2 rounded-lg border border-line bg-surface p-3" role="group" aria-label={t('table.actions')}>
      <div ref={sliderRow} className={`flex flex-wrap items-center gap-2 ${sliderOn ? '' : 'opacity-40'}`} title={sliderOn ? t('table.wheelHint') : undefined}>
        {quick.map((q) => (
          <button key={q.label} className="rounded-md border border-line bg-raised px-2 py-1 text-sm" disabled={!sliderOn} onClick={() => setAmount(q.value)}>
            {q.label}
          </button>
        ))}
        <input aria-label={t('table.amount')} type="range" className="min-w-24 flex-1" disabled={!sliderOn} min={min} max={Math.max(min, max)} step={Math.max(1, Math.floor(info.smallBlind / 5) || 1)} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        <input aria-label={t('table.amountExact')} type="number" className="w-24 rounded-sm border border-line bg-surface px-2 py-1 font-mono" disabled={!sliderOn} min={min} max={max} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
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
          <button className={`${base} tk-act-allin`} disabled={!aggress || fixed} onClick={() => onAct({ type: 'allIn' })}>
            {t('table.allIn')}
          </button>
        </div>
      ) : (
        <div className="flex min-h-10 flex-wrap items-center gap-2">
          <span className="text-sm text-muted">{t('table.widget.plan')}:</span>
          <PlanBar view={view} />
        </div>
      )}
    </div>
  );
}
