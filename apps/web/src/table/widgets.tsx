import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { useFeatures } from '../features';
import { SoundPalette } from '../pages/sounds';
import { useSession } from '../session';
import { saveUserSetting, useSettings } from '../settings';
import { CardView } from './CardView';
import { type TournamentInfo, AddonOfferDialog, RebuyDecisionDialog, BountiesBody, InfoBody, useTournamentInfo } from './InfoCard';
import { defaultLayout, parseLayout, WIDGET_IDS, type Layout, type WidgetId } from './layout';
import { formatAmount } from './format';
import { ClockWidget } from './TablePanel';
import { useMobileLayout } from './mobile';

export interface WidgetDef {
  title: string;
  /** Widget má co ukázat (např. „Moje handa“ jen když sedím v ruce). */
  show: boolean;
  body: ReactNode;
  badge?: number;
  /** Doplňková tlačítka v hlavičce widgetu (např. chat na celou obrazovku). */
  actions?: ReactNode;
}

interface Ctx {
  layout: Layout;
  setLayout: (next: Layout) => void;
  defs: Record<WidgetId, WidgetDef>;
  /** Místo, do kterého stůl vykresluje akce hráče (v widgetu „O hře“, nebo v pruhu pod stolem, když panel s „O hře“ není vidět). */
  setToolsSlot: (el: HTMLElement | null) => void;
  toolsSlot: HTMLElement | null;
  /** Akce se ukazují v pruhu pod stolem (telefon, vypnutý panel nebo skrytý widget „O hře“). */
  actionsInline: boolean;
  view: TableView | undefined;
  /** Údaje o turnaji (null u cash stolu). */
  tour: TournamentInfo | null;
}

const WidgetsContext = createContext<Ctx | null>(null);

export function useTableWidgets(): Ctx {
  const c = useContext(WidgetsContext);
  if (!c) throw new Error('Widgety stolu musí být uvnitř TableWidgetsProvider');
  return c;
}

/** Osobní rozložení widgetů (levý i pravý panel), synchronizované mezi zařízeními. */
function useLayoutState(): [Layout, (next: Layout) => void] {
  const values = useSettings().values;
  const raw = values['ui.tableLayout'];
  const legacyLeft = values['ui.tablePanel'];
  const legacyRight = values['ui.tableSide'];
  const layout = useMemo(() => (raw || legacyLeft || legacyRight ? parseLayout(raw, legacyLeft, legacyRight) : defaultLayout()), [raw, legacyLeft, legacyRight]);
  const set = useCallback((next: Layout) => void saveUserSetting('ui.tableLayout', JSON.stringify(next)).catch(() => undefined), []);
  return [layout, set];
}

export function TableWidgetsProvider({ view, tableId, inBb, chat, children }: { view: TableView | undefined; tableId: string; inBb: boolean; chat?: { body: ReactNode; unread: number; actions: ReactNode }; children: ReactNode }) {
  const [layout, setLayout] = useLayoutState();
  const [toolsSlot, setToolsSlot] = useState<HTMLElement | null>(null);
  const mobile = useMobileLayout();
  // „O hře“ (a v něm akce) je vidět jen když není skrytý ani jeho panel; jinak se akce ukážou pod stolem.
  const infoSide = layout.right.includes('info') ? 'right' : 'left';
  const actionsInline = mobile || layout.hidden.includes('info') || layout.hiddenSides.includes(infoSide);
  const { me } = useSession();
  const features = useFeatures();
  const info = view?.info;
  const mine = view?.seats.find((s) => s.playerId === me?.user.id);
  const tournamentId = info?.tournament ? (info.tournamentId ?? tableId) : null;
  const tour = useTournamentInfo(tournamentId);
  const myWin = view?.winners?.find((w) => w.seat === mine?.seat);

  const defs: Record<WidgetId, WidgetDef> = {
    table: {
      title: tournamentId ? t('table.widget.clock') : t('table.widget.table'),
      show: !!info,
      // Jeden widget o stole: v turnaji hodiny turnaje (level, blindy, čas), v cash game blindy, rozsah nákupu a rake.
      body: tournamentId ? (
        <ClockWidget tournamentId={tournamentId} />
      ) : (
        info && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            <dt className="text-muted">{t('table.widget.blinds')}</dt>
            <dd className="font-mono">
              {info.smallBlind}/{info.bigBlind}
            </dd>
            {!info.tournament && (
              <>
                <dt className="text-muted">{t('table.widget.buyIn')}</dt>
                <dd className="font-mono">
                  {formatAmount(info.minBuyIn, info, false)} – {formatAmount(info.maxBuyIn, info, false)}
                </dd>
              </>
            )}
            {info.rake && (
              <>
                <dt className="text-muted">Rake</dt>
                <dd className="font-mono">{info.rake.percent} %</dd>
              </>
            )}
          </dl>
        )
      ),
    },
    hand: {
      title: t('table.widget.hand'),
      show: !!mine,
      body:
        mine && mine.hasCards && mine.cards ? (
          <div className="flex flex-col items-center gap-2">
            <div className="flex gap-1">
              {mine.cards.map((c) => (
                <CardView key={c} card={c} />
              ))}
            </div>
            {myWin?.hand && <span className="text-sm">{t(myWin.hand.key, myWin.hand.params)}</span>}
          </div>
        ) : (
          <p className="text-muted">{t('table.notInHand')}</p>
        ),
    },
    best: {
      title: t('table.widget.best'),
      show: !!mine,
      body: view?.myBest ? <span className="text-lg font-semibold">{t(view.myBest.key, view.myBest.params)}</span> : <p className="text-muted">{t('table.widget.bestNone')}</p>,
    },
    players: {
      title: t('table.widget.players'),
      show: !!view,
      body: view && (
        <ul className="flex flex-col gap-0.5">
          {[...view.seats]
            .sort((a, b) => b.stack - a.stack)
            .map((s) => (
              <li key={s.seat} className={`flex justify-between gap-2 ${s.seat === view.actingSeat ? 'font-bold' : ''} ${s.status === 'folded' || s.status === 'sittingOut' ? 'text-muted' : ''}`}>
                <span className="truncate">
                  {s.isDealer ? 'Ⓓ ' : ''}
                  {(s.status === 'sittingOut' || s.sitOut === true) && <span title={t('table.sittingOut')}>⏸ </span>}
                  {s.name}
                </span>
                <span className="font-mono">{formatAmount(s.stack, view.info, inBb)}</span>
              </li>
            ))}
        </ul>
      ),
    },
    chat: { title: t('table.chat'), show: !!chat && features.chat, body: chat?.body ?? null, badge: chat?.unread, actions: chat?.actions },
    sounds: { title: t('table.widget.sounds'), show: !!mine, body: <SoundPalette target={{ kind: 'table', id: tableId }} /> },
    // „O hře“ obsahuje i všechny akce hráče (stůl je vykresluje portálem do tohoto místa): malá tlačítka, aktivní barevná, neaktivní šedá.
    info: {
      title: t('table.info.title'),
      show: !!view,
      body: view && (
        <div className="flex flex-col gap-2">
          <InfoBody view={view} tour={tour} tournamentId={tournamentId} inBb={inBb} />
          {!actionsInline && <div ref={setToolsSlot} />}
        </div>
      ),
    },
    bounties: { title: t('table.info.rewards'), show: !!view && features.headBounty, body: view && <BountiesBody view={view} tour={tour} tournamentId={tournamentId} /> },
  };

  const value = useMemo<Ctx>(
    () => ({ layout, setLayout, defs, setToolsSlot, toolsSlot, actionsInline, view, tour }),
    // defs se staví při každém vykreslení; kontext se tedy obnovuje s ním
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, setLayout, defs, toolsSlot, actionsInline, view, tour],
  );
  void WIDGET_IDS;
  return (
    <WidgetsContext.Provider value={value}>
      {children}
      <AddonOfferDialog tour={tour} tournamentId={tournamentId} />
      <RebuyDecisionDialog tour={tour} tournamentId={tournamentId} />
    </WidgetsContext.Provider>
  );
}

/** Které panely má hráč vypnuté (čte se přímo z osobního nastavení; použitelné i mimo kontext widgetů). */
export function useHiddenSides(): { left: boolean; right: boolean } {
  const values = useSettings().values;
  return useMemo(() => {
    const l = parseLayout(values['ui.tableLayout'], values['ui.tablePanel'], values['ui.tableSide']);
    return { left: l.hiddenSides.includes('left'), right: l.hiddenSides.includes('right') };
  }, [values]);
}
