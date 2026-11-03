import type { ReactNode } from 'react';
import type { SeatView, TableView } from '@kb/game-core';
import { t } from '@kb/shared';
import { saveUserSetting, useSettings } from '../settings';
import { CardView } from './CardView';
import { Link } from '../router';
import { TimeStrip } from './TimerRing';
import { mmss } from './TablePanel';
import { SoundStrip } from '../pages/sounds';
import { useTableWidgets } from './widgets';
import { effectiveOrder, parseMobileOrder, ORDER_KEY, type MobileWidget } from './mobile-order';

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
  tools,
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
  /** Další nástroje stolu jako ikony (volba „všechny ikony nahoře“); zalomí se do dalšího řádku. */
  tools?: ReactNode;
}) {
  const btn = 'tk-mbar-btn relative rounded-md border border-line bg-surface';
  return (
    <div className="flex flex-col gap-1">
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
    {tools && <div className="flex flex-wrap items-center gap-1">{tools}</div>}
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
 * Pás mezi stolem a pevným ovládacím panelem na telefonu: widgety, které si hráč dal „pod stůl“ (Nastavení → Telefon, nebo ⇅ v informacích).
 * Pás vyplní zbytek výšky a případný přebytek se v něm posouvá; ovládací panel pod ním se tím nikdy nepohne.
 */
export function MobileMid({ view, mine, inBb: _inBb, offset, log, tableId }: { view: TableView; mine: SeatView | undefined; inBb: boolean; offset: number; log: { key: number; text: string }[]; tableId: string }) {
  const v = useSettings().values;
  const { defs } = useTableWidgets();
  const acting = view.actingSeat !== null;
  const parts: Record<MobileWidget, ReactNode> = {
    timer: (acting || mine) && <TimeStrip key="timer" deadline={view.deadline} offset={offset} bank={view.bankActive} reserve={mine && view.info.timeBankMode && view.info.timeBankMode !== 'none' ? mmss(mine.timeBank * 1000) : undefined} />,
    best: mine && (
      <div key="best" className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-1.5 text-sm">
        {view.myBest?.cards && view.myBest.cards.length > 0 && (
          <span className="flex shrink-0 gap-0.5" aria-hidden>
            {view.myBest.cards.map((c) => (
              <CardView key={c} card={c} mini still />
            ))}
          </span>
        )}
        <span className="min-w-0">
          <span className="text-muted">{t('table.widget.best')}: </span>
          <span className="font-semibold">{view.myBest ? t(view.myBest.key, view.myBest.params) : t('table.widget.bestNone')}</span>
        </span>
      </div>
    ),
    sounds: mine && <SoundStrip key="sounds" target={{ kind: 'table', id: tableId }} />,
    events: log.length > 0 && (
      <ul key="events" className="flex flex-col gap-0.5 rounded-md bg-raised px-2 py-1 text-xs text-muted" aria-label={t('table.m.events')}>
        {log.map((l) => (
          <li key={l.key} className="truncate">
            {l.text}
          </li>
        ))}
      </ul>
    ),
    players: null,
    table: null,
    bounties: null,
    info: null,
    chat: null,
  };
  // Ostatní widgety (hráči, můj stůl, odměny) se vykreslí stejně jako v zásuvce, jen v kompaktní kartě.
  for (const id of ['players', 'table', 'bounties'] as const) {
    const def = defs[id];
    parts[id] = def.show && (
      <section key={id} className="rounded-md border border-line bg-surface px-2 py-1 text-sm">
        <h3 className="text-xs font-semibold text-muted">{def.title}</h3>
        {def.body}
      </section>
    );
  }
  return <div className="tk-mid flex flex-col gap-1.5">{effectiveOrder(parseMobileOrder(v[ORDER_KEY], v)).s1.map((id) => parts[id])}</div>;
}

/** Zaškrtávátka v kartě „O hře“: co se na telefonu ukazuje mezi stolem a tlačítky a zda se upozorní na můj tah. */
export function MobileOptions() {
  const v = useSettings().values;
  const row = (key: string, def = true) => (
    <label key={key} className="flex items-start gap-2 text-sm" title={t(`settings.${key}.help`)}>
      <input type="checkbox" role="switch" className="mt-1" checked={def ? v[key] !== false : v[key] === true} onChange={(e) => void saveUserSetting(key, e.target.checked, true).catch(() => undefined)} />
      <span>{t(`settings.${key}.label`)}</span>
    </label>
  );
  return (
    <fieldset className="flex flex-col gap-1 border-t border-line pt-2">
      <legend className="text-xs font-semibold text-muted">{t('table.m.options')}</legend>
      {row('ui.mobileTurnAlert')}
      {row('ui.mobileAllIcons', false)}
      {row('ui.mobileAutoFullscreen', false)}
      {row('ui.hideMyCards', false)}
    </fieldset>
  );
}
