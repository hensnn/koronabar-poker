import { useEffect, useState, useSyncExternalStore } from 'react';
import { t } from '@kb/shared';
import { get } from './api';
import { onSocket } from './net';
import { useFeatures } from './features';

export interface Brief {
  userId: string;
  level: number;
  rank: { name: string; icon: string; color: string };
}

const cache = new Map<string, Brief>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let timer: number | undefined;

const notify = () => {
  version++;
  listeners.forEach((l) => l());
};

function flush() {
  timer = undefined;
  const ids = [...pending];
  pending.clear();
  if (ids.length === 0) return;
  get<{ players: Brief[] }>(`/api/progress/brief?ids=${ids.join(',')}`)
    .then((d) => {
      for (const p of d.players) cache.set(p.userId, p);
      notify();
    })
    .catch(() => undefined);
}

/** Hodnost a level hráče z mezipaměti; chybějící se načtou dávkou. */
export function useBrief(userId: string | null | undefined): Brief | undefined {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  useEffect(() => {
    if (!userId || cache.has(userId) || pending.has(userId)) return;
    pending.add(userId);
    if (timer === undefined) timer = window.setTimeout(flush, 50);
  }, [userId]);
  return userId ? cache.get(userId) : undefined;
}

/** Po postupu hráče se jeho mezipaměť zneplatní. */
export function invalidateBrief(userId: string) {
  cache.delete(userId);
  notify();
}

const COLOR: Record<string, string> = {
  primary: 'text-primary',
  secondary: 'text-secondary',
  accent: 'text-accent',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-muted',
};

export const rankColorClass = (c: string) => COLOR[c] ?? 'text-muted';

/** Ikona hodnosti s popiskem (název hodnosti a level). */
export function RankBadge({ userId }: { userId: string | null | undefined }) {
  const b = useBrief(userId);
  const xp = useFeatures().xp;
  if (!b || !xp) return null;
  return (
    <span className={rankColorClass(b.rank.color)} title={`${b.rank.name}, ${t('xp.level', { n: b.level })}`} aria-label={`${b.rank.name}, ${t('xp.level', { n: b.level })}`}>
      {b.rank.icon}
    </span>
  );
}

/** Pruh nahoře, když hráč postoupí na další level (na pár vteřin). */
export function LevelUpToast() {
  const [msg, setMsg] = useState<{ icon: string; title: string; extra?: string } | null>(null);
  useEffect(() => {
    const show = (m: { icon: string; title: string; extra?: string }) => {
      setMsg(m);
      window.setTimeout(() => setMsg(null), 6000);
    };
    const offLevel = onSocket<{ level: number; rank: { name: string; icon: string }; rankChanged: boolean }>('progress:level', (e) =>
      show({ icon: e.rank.icon, title: t('xp.levelUp', { n: e.level }), extra: e.rankChanged ? t('xp.rankUp', { rank: e.rank.name }) : undefined }),
    );
    const offAch = onSocket<{ name: string; icon: string; xp: number }>('progress:achievement', (e) => show({ icon: e.icon, title: t('achievements.new', { name: e.name }), extra: e.xp > 0 ? `+${e.xp} XP` : undefined }));
    return () => {
      offLevel();
      offAch();
    };
  }, []);
  if (!msg) return null;
  return (
    <div role="status" className="fixed left-1/2 top-3 z-40 -translate-x-1/2 rounded-md border border-primary bg-surface px-4 py-2 shadow-lg motion-safe:animate-bounce">
      <span className="mr-2 text-xl">{msg.icon}</span>
      <strong>{msg.title}</strong>
      {msg.extra && <span className="ml-2">{msg.extra}</span>}
    </div>
  );
}
