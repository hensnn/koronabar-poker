import { useEffect, useState, type ReactNode } from 'react';
import { useMySeats } from './my-seat';
import { t } from '@kb/shared';
import { get } from './api';
import { loadChannels, totalUnread, useChatStore } from './chat-store';
import { onSocket } from './net';
import { Link } from './router';

export interface NavTab {
  to: string;
  label: string;
  /** Počítadla na tlačítku (zobrazí se jen nenulová). */
  badges?: { n: number; tone: 'primary' | 'danger'; title: string }[];
}

/** Počty na tlačítkách: stoly a turnaje k dispozici, nepřečtený chat a ankety, ve kterých můžu hlasovat. */
export function useNavCounts(chatOn: boolean, pollsOn: boolean): { tables: number; chat: number; polls: number } {
  const chat = useChatStore();
  const [tables, setTables] = useState(0);
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void Promise.all([get<{ tables: unknown[] }>('/api/lobby').then((d) => d.tables.length), get<{ tournaments: { status: string }[] }>('/api/tournaments').then((d) => d.tournaments.filter((x) => x.status === 'registering' || x.status === 'running').length)])
        .then(([a, b]) => alive && setTables(a + b))
        .catch(() => undefined);
    };
    load();
    const id = window.setInterval(load, 20_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  useEffect(() => {
    if (chatOn) void loadChannels().catch(() => undefined);
  }, [chatOn]);
  useEffect(() => {
    if (!pollsOn) return;
    let alive = true;
    const load = () =>
      get<{ polls: { canVote: boolean; pinned: boolean }[] }>('/api/polls?scope=open')
        .then((d) => alive && setPolls(d.polls.filter((p) => p.canVote || p.pinned).length))
        .catch(() => undefined);
    void load();
    const off = onSocket('poll:changed', () => void load());
    return () => {
      alive = false;
      off();
    };
  }, [pollsOn]);
  return { tables, chat: chatOn ? totalUnread(chat) : 0, polls: pollsOn ? polls : 0 };
}

/** Řádek hlavních tlačítek pod hlavičkou (na všech stránkách mimo stůl): Stoly / Večery, Chat / Ankety, Peněženka, Statistiky… */
export function NavTabs({ tabs, isActive, label }: { tabs: NavTab[]; isActive: (to: string) => boolean; label?: string }) {
  return (
    <nav aria-label={label ?? t('nav.main')} className="my-2 flex flex-wrap gap-2">
      {tabs.map((tab) => (
        <Link key={tab.to} to={tab.to} aria-current={isActive(tab.to) ? 'page' : undefined} className={`flex items-center gap-2 rounded-md border px-3 py-1 ${isActive(tab.to) ? 'border-primary bg-raised font-semibold' : 'border-line bg-surface'}`}>
          {tab.label}
          {tab.badges?.filter((b) => b.n > 0).map((b) => (
            <span key={b.title} title={b.title} aria-label={`${b.title}: ${b.n}`} className={`rounded-full px-1.5 text-xs ${b.tone === 'danger' ? 'bg-danger text-on-primary' : 'bg-primary text-on-primary'}`}>
              {b.n}
            </span>
          ))}
        </Link>
      ))}
    </nav>
  );
}

const ICON: Record<string, string> = { '/': '🏠', '/stoly': '🃏', '/chat': '💬', '/penezenka': '👛', '/zivy-cash': '💵', '/statistiky': '📊', '/obchod': '🛒', '/nastaveni': '⚙️', '/profil': '👤', '/admin': '🛡️' };

/**
 * Spodní lišta na telefonu mimo stůl (od šířky tabletu je místo ní řádek tlačítek pod hlavičkou): Ke stolu, Lobby, Stoly, Chat a Více.
 * Horní hlavička na telefonu není; všechno ostatní (peněženka, statistiky…, upozornění, zvuk, asistent) je pod „Více“ (`extra` jsou upozornění, zvuk a asistent).
 */
export function BottomNav({ tabs, isActive, path, extra, rail = false }: { tabs: NavTab[]; isActive: (to: string) => boolean; path: string; extra?: ReactNode; /** Telefon na šířku: lišta je svislý pruh u levého okraje (šetří výšku). */ rail?: boolean }) {
  const [sheet, setSheet] = useState<'more' | 'tables' | null>(null);
  const seats = useMySeats();
  useEffect(() => setSheet(null), [path]);
  // Klepnutí mimo nabídku ji zavře.
  useEffect(() => {
    if (!sheet) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest('[data-more]')) setSheet(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [sheet]);
  const all: NavTab[] = [{ to: '/', label: t('nav.lobby') }, ...tabs];
  const find = (to: string) => all.find((x) => x.to === to);
  const main = ['/', '/stoly', '/chat'].map(find).filter((x): x is NavTab => !!x);
  const rest = all.filter((x) => !['/', '/stoly', '/chat'].includes(x.to));
  const moreActive = rest.some((x) => isActive(x.to));
  const badgeSum = (tab: NavTab) => (tab.badges ?? []).reduce((s, b) => s + b.n, 0);
  const item = 'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-xs';
  const vis = rail ? '' : 'md:hidden';
  const sheetPos = rail ? 'fixed bottom-2 left-20 z-40 w-72 max-w-[calc(100vw-6rem)]' : 'fixed inset-x-2 bottom-16 z-40';
  const label = (x: NavTab) => (x.to === '/stoly' ? t('nav.tables.short') : x.to === '/chat' ? t('nav.chat.short') : x.label);
  const link = (x: NavTab) => (
    <Link key={x.to} to={x.to} aria-current={isActive(x.to) ? 'page' : undefined} className={`${item} ${isActive(x.to) ? 'font-semibold text-primary' : 'text-muted'}`}>
      <span aria-hidden="true" className="text-xl">{ICON[x.to]}</span>
      <span className="max-w-full truncate">{label(x)}</span>
      {badgeSum(x) > 0 && <span className={`absolute right-1/4 top-0 rounded-full px-1 text-xs text-on-primary ${(x.badges ?? []).some((b) => b.tone === 'danger' && b.n > 0) ? 'bg-danger' : 'bg-primary'}`}>{badgeSum(x)}</span>}
    </Link>
  );
  // Ke stolu: jediný stůl vede rovnou k němu, víc stolů otevře výběr, bez stolu je tlačítko šedé.
  const myTables = seats.filter((s) => path !== `/stul/${s.tableId}`);
  const toTable =
    myTables.length === 0 ? (
      <span key="table" className={`${item} text-muted opacity-60`} title={t('nav.myTableNone')}>
        <span aria-hidden="true" className="text-xl">🪑</span>
        <span>{t('nav.myTable')}</span>
      </span>
    ) : myTables.length === 1 ? (
      <Link key="table" to={`/stul/${myTables[0]!.tableId}`} className={`${item} font-semibold text-primary`} title={myTables[0]!.name}>
        <span aria-hidden="true" className="text-xl">🪑</span>
        <span>{t('nav.myTable')}</span>
      </Link>
    ) : (
      <button key="table" type="button" data-more aria-expanded={sheet === 'tables'} aria-haspopup="menu" onClick={() => setSheet((s) => (s === 'tables' ? null : 'tables'))} className={`${item} font-semibold text-primary`}>
        <span aria-hidden="true" className="text-xl">🪑</span>
        <span>
          {t('nav.myTable')} ({myTables.length})
        </span>
      </button>
    );
  return (
    <>
      {sheet === 'tables' && (
        <div data-more className={`${sheetPos} flex flex-col gap-1 rounded-lg border border-line bg-surface p-2 shadow-lg ${vis}`} role="menu">
          {myTables.map((s) => (
            <Link key={s.tableId} to={`/stul/${s.tableId}`} role="menuitem" className="flex items-center gap-2 rounded-md px-3 py-2 hover:bg-raised">
              <span aria-hidden="true">🪑</span>
              {s.name}
              {s.tournamentId ? ` · ${t('nav.myTableTournament')}` : ''}
            </Link>
          ))}
        </div>
      )}
      {sheet === 'more' && (
        <div data-more className={`${sheetPos} flex max-h-[75dvh] flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-surface p-2 shadow-lg ${vis}`} role="menu">
          {extra && <div className="flex flex-wrap items-center gap-2 border-b border-line pb-2">{extra}</div>}
          {rest.map((x) => (
            <Link key={x.to} to={x.to} role="menuitem" aria-current={isActive(x.to) ? 'page' : undefined} className={`flex items-center gap-2 rounded-md px-3 py-2 ${isActive(x.to) ? 'bg-primary font-semibold text-on-primary' : 'hover:bg-raised'}`}>
              <span aria-hidden="true">{ICON[x.to] ?? '•'}</span>
              {x.label}
            </Link>
          ))}
        </div>
      )}
      <nav aria-label={t('nav.main')} className={`fixed z-40 flex bg-surface ${rail ? 'inset-y-0 left-0 w-16 flex-col border-r border-line' : 'inset-x-0 bottom-0 border-t border-line pb-[env(safe-area-inset-bottom)] md:hidden'}`}>
        {toTable}
        {main.map(link)}
        <button type="button" data-more aria-expanded={sheet === 'more'} aria-haspopup="menu" onClick={() => setSheet((s) => (s === 'more' ? null : 'more'))} className={`${item} ${moreActive || sheet === 'more' ? 'font-semibold text-primary' : 'text-muted'}`}>
          <span aria-hidden="true" className="text-xl">⋯</span>
          <span>{t('nav.more')}</span>
        </button>
      </nav>
    </>
  );
}
