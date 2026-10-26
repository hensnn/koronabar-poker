import type { TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { CardView } from './CardView';

/** Moje nejlepší kombinace: pětice karet v miniaturách a pod nimi název kombinace. */
export function BestHand({ best, textClass = 'text-lg font-semibold' }: { best: NonNullable<TableView['myBest']>; textClass?: string }) {
  return (
    <div className="flex flex-col gap-1">
      {best.cards && best.cards.length > 0 && (
        <div className="flex gap-0.5" aria-hidden>
          {best.cards.map((c) => (
            <CardView key={c} card={c} mini still />
          ))}
        </div>
      )}
      <span className={textClass}>{t(best.key, best.params)}</span>
    </div>
  );
}
