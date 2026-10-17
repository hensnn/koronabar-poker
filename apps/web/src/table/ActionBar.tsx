import { useEffect, useState } from 'react';
import type { LegalActions, PlayerAction, TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { formatAmount, parseList, quickBetDefaults } from './format';

interface Props {
  view: TableView;
  legal: LegalActions;
  inBb: boolean;
  quickPost: string;
  quickPre: string;
  onAct: (a: PlayerAction) => void;
}

const base = 'tk-act px-4 py-2 font-medium disabled:opacity-50';

/** Akční lišta: Fold / Check / Call / Raise s posuvníkem, rychlé sázky a all-in. */
export function ActionBar({ view, legal, inBb, quickPost, quickPre, onAct }: Props) {
  const aggress = legal.canBet || legal.canRaise;
  const fixed = view.info.bettingLimit === 'fixedLimit';
  const [amount, setAmount] = useState(legal.minRaiseTo);
  useEffect(() => setAmount(legal.minRaiseTo), [legal.minRaiseTo, legal.maxRaiseTo, view.handId, view.street]);
  const info = view.info;
  const mine = view.seats.find((s) => s.seat === view.viewerSeat);
  const myBet = mine?.bet ?? 0;
  const preflop = view.street === 'PREFLOP';
  const clamp = (n: number) => Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(n)));

  const quick = preflop
    ? parseList(quickPre, quickBetDefaults.preflop).map((m) => ({ label: `${m}×`, value: clamp(m * info.bigBlind) }))
    : parseList(quickPost, quickBetDefaults.postflop).map((p) => ({ label: `${p} %`, value: clamp(myBet + (view.totalPot * p) / 100) }));

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3" role="group" aria-label={t('table.actions')}>
      {aggress && !fixed && (
        <div className="flex flex-wrap items-center gap-2">
          {quick.map((q) => (
            <button key={q.label} className="rounded-md border border-line bg-raised px-2 py-1 text-sm" onClick={() => setAmount(q.value)}>
              {q.label}
            </button>
          ))}
          <input
            aria-label={t('table.amount')}
            type="range"
            className="min-w-24 flex-1"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            step={Math.max(1, Math.floor(info.smallBlind / 5) || 1)}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
          <input
            aria-label={t('table.amountExact')}
            type="number"
            className="w-24 rounded-sm border border-line bg-surface px-2 py-1 font-mono"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button className={`${base} tk-act-fold`} onClick={() => onAct({ type: 'fold' })}>
          {t('table.fold')}
        </button>
        {legal.canCheck ? (
          <button className={`${base} tk-act-check`} onClick={() => onAct({ type: 'check' })}>
            {t('table.check')}
          </button>
        ) : (
          <button className={`${base} tk-act-call`} onClick={() => onAct({ type: 'call' })}>
            {t('table.call')} {formatAmount(legal.callAmount, info, inBb)}
          </button>
        )}
        {aggress && (
          <button className={`${base} tk-act-raise`} onClick={() => onAct({ type: legal.canBet ? 'bet' : 'raise', amount: clamp(amount) })}>
            {legal.canBet ? t('table.bet') : t('table.raise')} {formatAmount(clamp(amount), info, inBb)}
          </button>
        )}
        {aggress && !fixed && (
          <button className={`${base} tk-act-allin`} onClick={() => onAct({ type: 'allIn' })}>
            {t('table.allIn')}
          </button>
        )}
      </div>
    </div>
  );
}
