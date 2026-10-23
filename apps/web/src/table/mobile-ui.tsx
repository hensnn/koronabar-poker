import type { SeatView, TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { saveUserSetting, useSettings } from '../settings';
import { Link } from '../router';
import { CardView } from './CardView';
import { formatAmount } from './format';
import { TimeStrip } from './TimerRing';
import { mmss } from './TablePanel';
import { SoundStrip } from '../pages/sounds';
import { useTableWidgets } from './widgets';

/**
 * Horní lišta nového mobilního rozložení stolu: zpět, krátký název (blindy nebo turnaj) a tři ikony se zásuvkami
 * (chat s počtem nepřečtených, informace o hře, nabídka stolu). Panely počítače se na telefonu nevykreslují.
 */
export function MobileBar({
  backTo,
  title,
  unread,
  hasChat,
  onChat,
  onInfo,
  onMenu,
  onHistory,
  onPause,
  paused,
}: {
  backTo: string;
  title: string;
  unread: number;
  hasChat: boolean;
  onChat: () => void;
  onInfo: () => void;
  onMenu: () => void;
  onHistory: () => void;
  /** Pauza stolu (jen kdo smí); undefined = tlačítko se nezobrazí. */
  onPause?: () => void;
  paused?: boolean;
}) {
  const btn = 'tk-mbar-btn relative rounded-md border border-line bg-surface';
  return (
    <div className="tk-mbar flex items-center gap-1" role="toolbar" aria-label={t('table.m.bar')}>
      <Link to={backTo} className="tk-mbar-btn rounded-md border border-line bg-surface text-center" aria-label={t('table.backToLobby')} title={t('table.backToLobby')}>
        ←
      </Link>
      <strong className="min-w-0 flex-1 truncate px-1 text-sm">{title}</strong>
      <button className={btn} onClick={onHistory} aria-label={t('table.history')} title={t('table.history')}>
        📜
      </button>
      {onPause && (
        <button className={btn} onClick={onPause} aria-pressed={!!paused} aria-label={paused ? t('table.resume') : t('table.pause')} title={paused ? t('table.resume') : t('table.pause')}>
          {paused ? '▶' : '⏸'}
        </button>
      )}
      {hasChat && (
        <button className={btn} onClick={onChat} aria-label={t('table.chatOpen')} title={t('table.chatOpen')}>
          💬
          {unread > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-accent px-1 text-xs text-on-act">{unread}</span>}
        </button>
      )}
      <button className={btn} onClick={onInfo} aria-label={t('table.m.info')} title={t('table.m.info')}>
        ℹ️
      </button>
      <button className={btn} onClick={onMenu} aria-label={t('table.m.menu')} title={t('table.m.menu')}>
        ☰
      </button>
    </div>
  );
}

/** Místo v nabídce stolu, kam se vykreslují herní akce (sit out, dokoupit, odejít, dohoda…), které jinde u stolu nemají místo. */
export function ToolsSlot() {
  const { setToolsSlot } = useTableWidgets();
  return <div ref={setToolsSlot} className="flex flex-col gap-2" />;
}

/** Místo v zásuvce s informacemi o stole, kam se vykreslí sit out a volba, co s kartami po handě. */
export function InfoSlot() {
  const { setInfoSlot } = useTableWidgets();
  return <div ref={setInfoSlot} className="flex flex-col gap-2" />;
}

/**
 * Prostor mezi stolem a tlačítky na telefonu: moje ruka (velké karty, kombinace, stack), poslední události a pruh času.
 * Každá část se zapíná v kartě „O hře“ (osobní nastavení), aby si každý nechal jen to, co potřebuje.
 */
export function MobileMid({ view, mine, inBb, offset, log, tableId }: { view: TableView; mine: SeatView | undefined; inBb: boolean; offset: number; log: { key: number; text: string }[]; tableId: string }) {
  const v = useSettings().values;
  const hand = v['ui.mobileHandStrip'] !== false;
  const events = v['ui.mobileEvents'] !== false;
  const timer = v['ui.mobileTimerBar'] !== false;
  const best = v['ui.mobileBest'] !== false;
  const sounds = v['ui.mobileSounds'] === true;
  if (!hand && !events && !timer && !best && !sounds) return null;
  const acting = view.actingSeat !== null;
  return (
    <div className="tk-mid flex flex-col gap-1.5">
      {timer && (acting || mine) && <TimeStrip deadline={view.deadline} offset={offset} bank={view.bankActive} reserve={mine && view.info.timeBankMode && view.info.timeBankMode !== 'none' ? mmss(mine.timeBank * 1000) : undefined} />}
      {hand && mine && (
        <div className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2">
          <div className="flex gap-1">
            {mine.hasCards && mine.cards ? mine.cards.map((c, i) => <CardView key={`${view.handId}-${i}`} card={c} still />) : <span className="text-sm text-muted">{t('table.notInHand')}</span>}
          </div>
          <div className="min-w-0 flex-1">
            {best && <div className="truncate font-semibold">{view.myBest ? t(view.myBest.key, view.myBest.params) : t('table.widget.bestNone')}</div>}
            <div className="font-mono text-xs text-muted">{formatAmount(mine.stack, view.info, inBb)}</div>
          </div>
        </div>
      )}
      {!hand && best && mine && (
        <div className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm">
          <span className="text-muted">{t('table.widget.best')}: </span>
          <span className="font-semibold">{view.myBest ? t(view.myBest.key, view.myBest.params) : t('table.widget.bestNone')}</span>
        </div>
      )}
      {sounds && mine && <SoundStrip target={{ kind: 'table', id: tableId }} />}
      {events && log.length > 0 && (
        <ul className="flex flex-col gap-0.5 rounded-md bg-raised px-2 py-1 text-xs text-muted" aria-label={t('table.m.events')}>
          {log.map((l) => (
            <li key={l.key} className="truncate">
              {l.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Zaškrtávátka v kartě „O hře“: co se na telefonu ukazuje mezi stolem a tlačítky a zda se upozorní na můj tah. */
export function MobileOptions() {
  const v = useSettings().values;
  const row = (key: string) => (
    <label key={key} className="flex items-start gap-2 text-sm" title={t(`settings.${key}.help`)}>
      <input type="checkbox" role="switch" className="mt-1" checked={v[key] !== false} onChange={(e) => void saveUserSetting(key, e.target.checked, true).catch(() => undefined)} />
      <span>{t(`settings.${key}.label`)}</span>
    </label>
  );
  return (
    <fieldset className="flex flex-col gap-1 border-t border-line pt-2">
      <legend className="text-xs font-semibold text-muted">{t('table.m.options')}</legend>
      {['ui.mobileHandStrip', 'ui.mobileBest', 'ui.mobileEvents', 'ui.mobileTimerBar', 'ui.mobileSounds', 'ui.mobileTurnAlert'].map(row)}
    </fieldset>
  );
}
