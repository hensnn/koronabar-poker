import { t } from '@kb/shared';

/** Text při rozhodování po vypadnutí: zmiňuje jen to, co je opravdu k dispozici (rebuy, nový vstup, nebo obojí). */
export function decideText(me: { canRebuy?: boolean; canReenter?: boolean }, time: string): string {
  if (me.canRebuy && me.canReenter) return t('tournament.decide', { time });
  if (me.canRebuy) return t('tournament.decide.rebuy', { time });
  if (me.canReenter) return t('tournament.decide.reenter', { time });
  return t('tournament.decide.none');
}

/** Nadpis okna rozhodnutí podle dostupných možností. */
export function decideTitle(me: { canRebuy?: boolean; canReenter?: boolean }): string {
  if (me.canRebuy && me.canReenter) return t('tournament.decideTitle');
  return me.canReenter ? t('tournament.reenter') : t('tournament.rebuy');
}
