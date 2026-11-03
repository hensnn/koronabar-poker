import { useEffect, useRef, type ReactNode } from 'react';
import { t } from '@kb/shared';
import type { Channel } from '../chat-store';
import { ChatPanel } from '../pages/chat';
import { Frame } from './Panel';
import type { MobileOrder, MobileWidget } from './mobile-order';
import { useTableWidgets } from './widgets';
import type { WidgetId } from './layout';

/**
 * Obrazovky u stolu na telefonu: první je stůl s pevným ovládacím panelem, další se listují prstem doleva a doprava (nebo klepnutím na tečky).
 * `page` řídí rodič (tlačítka v horní liště, návrat na stůl při mém tahu); listování prstem ho aktualizuje.
 */
export function MobilePager({ first, pages, page, onPage }: { first: ReactNode; pages: ReactNode[]; page: number; onPage: (p: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const moving = useRef(false);
  const timer = useRef(0);
  const settle = useRef(0);
  /** Obrazovka, kterou zvolil prst: rodič se o ní dozví až po doznění posunu a stránka se pak nedoroluje podruhé. */
  const fromScroll = useRef<number | null>(null);
  const total = pages.length + 1;
  const current = Math.min(page, total - 1);
  // Programové přepnutí obrazovky (tlačítka, tečky): plynule se doroluje; průběžné polohy při tom nepřepisují volbu.
  useEffect(() => {
    const el = ref.current;
    if (!el || el.clientWidth === 0) return;
    if (fromScroll.current === current) {
      fromScroll.current = null;
      return;
    }
    if (Math.round(el.scrollLeft / el.clientWidth) === current) return;
    moving.current = true;
    el.scrollTo({ left: current * el.clientWidth, behavior: 'smooth' });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => (moving.current = false), 500);
  }, [current]);
  // Během tahu prstem se nic nepřekresluje (stůl je těžký); poloha se vyhodnotí, až posun doznívá.
  const onScroll = () => {
    if (moving.current) return;
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const el = ref.current;
      if (!el || el.clientWidth === 0) return;
      const p = Math.round(el.scrollLeft / el.clientWidth);
      if (p !== current) {
        fromScroll.current = p;
        onPage(p);
      }
    }, 120);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {total > 1 && (
        <div className="flex items-center justify-center gap-2 py-1" role="tablist" aria-label={t('mobile.screens')}>
          {Array.from({ length: total }, (_, i) => (
            <button key={i} role="tab" aria-selected={i === current} aria-label={t('mobile.screenN', { n: i + 1 })} onClick={() => onPage(i)} className={`h-2 rounded-full ${i === current ? 'w-6 bg-primary' : 'w-2 bg-line'}`} />
          ))}
        </div>
      )}
      <div ref={ref} onScroll={onScroll} className="tk-pager flex min-h-0 flex-1">
        <div className="tk-pager-page tk-pager-first">{first}</div>
        {pages.map((p, i) => (
          <div key={i} className="tk-pager-page">
            {p}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Tělo jednoho widgetu v zásuvce nebo na obrazovce; chat se vykreslí jen na viditelné obrazovce (jinak by se zprávy označovaly za přečtené). */
function WidgetBody({ id, channel, visible }: { id: MobileWidget; channel: Channel | undefined; visible: boolean }) {
  const { defs } = useTableWidgets();
  if (id === 'chat') return channel && visible ? <ChatPanel channel={channel} compact fill /> : <p className="text-muted">{t('table.chat')}</p>;
  if (id === 'timer') return null;
  return <>{defs[id].body}</>;
}

/** Jedna další obrazovka s widgety (2 nebo 3). */
export function MobileScreen({ ids, channel, visible }: { ids: MobileWidget[]; channel: Channel | undefined; visible: boolean }) {
  const { layout, setLayout, defs } = useTableWidgets();
  const shown = ids.filter((id) => id === 'chat' || (id !== 'timer' && defs[id].show));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-y-contain p-1">
      {shown.length === 0 && <p className="text-muted">{t('mobile.screenEmpty')}</p>}
      {shown.map((id) =>
        id === 'chat' ? (
          <section key={id} className="tk-widget flex min-h-64 flex-1 flex-col">
            <div className="tk-widget-head font-semibold">{t('table.chat')}</div>
            <div className="tk-widget-body flex min-h-0 flex-1 flex-col">
              <WidgetBody id={id} channel={channel} visible={visible} />
            </div>
          </section>
        ) : (
          <Frame key={id} id={id as WidgetId} def={defs[id as WidgetId]} layout={layout} setLayout={setLayout} />
        ),
      )}
    </div>
  );
}

/** Obsah zásuvky s jedním widgetem (widget v „ikonách“ nahoře). */
export function MobileWidgetDrawer({ id, channel }: { id: MobileWidget; channel: Channel | undefined }) {
  return <WidgetBody id={id} channel={channel} visible />;
}

/**
 * Telefon na šířku: pod pevným ovládacím panelem jsou záložky 1, 2 a 3 (podle počtu obrazovek), stůl zůstává vidět.
 * Záložka 1 je pás pod stolem (`first`), záložky 2 a 3 jsou widgety z těchto obrazovek.
 */
export function LandscapePane({ first, order, page, onPage, channel }: { first: ReactNode; order: MobileOrder; page: number; onPage: (p: number) => void; channel: Channel | undefined }) {
  const total = order.screens;
  const current = Math.min(page, total - 1);
  return (
    <div className="tk-pane flex min-h-0 flex-1 flex-col gap-1">
      {total > 1 && (
        <div role="tablist" aria-label={t('mobile.screens')} className="flex gap-1">
          {Array.from({ length: total }, (_, i) => (
            <button key={i} role="tab" aria-selected={i === current} aria-label={t('mobile.screenN', { n: i + 1 })} onClick={() => onPage(i)} className={`flex-1 rounded-md border border-line px-2 py-0.5 text-sm ${i === current ? 'bg-primary text-on-primary' : 'bg-surface'}`}>
              {i + 1}
            </button>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{current === 0 ? first : <MobileScreen ids={current === 1 ? order.s2 : order.s3} channel={channel} visible />}</div>
    </div>
  );
}
