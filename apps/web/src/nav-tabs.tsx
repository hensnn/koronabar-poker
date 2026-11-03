import { useEffect, useState } from 'react';
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
export function NavTabs({ tabs, isActive }: { tabs: NavTab[]; isActive: (to: string) => boolean }) {
  return (
    <nav aria-label={t('nav.main')} className="my-2 flex flex-wrap gap-2">
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
