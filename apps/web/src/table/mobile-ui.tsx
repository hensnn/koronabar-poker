import { t } from '@kb/shared';
import { Link } from '../router';
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
