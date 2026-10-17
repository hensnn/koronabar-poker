import { useEffect, useState, useSyncExternalStore } from 'react';
import { get } from './api';
import { onSocket } from './net';
import { useSession } from './session';

export interface PublicLook {
  userId: string;
  frame: { color: string; style: string } | null;
  effect: { color: string; style: string } | null;
  nameColor: string | null;
  title: { name: string; color: string } | null;
  trophies: { key: string; name: string; icon: string }[];
}

// Třídy musí být v kódu celé (Tailwind je hledá), proto mapy místo skládání názvu.
export const BORDER: Record<string, string> = {
  primary: 'border-primary',
  secondary: 'border-secondary',
  accent: 'border-accent',
  info: 'border-info',
  success: 'border-success',
  warning: 'border-warning',
  danger: 'border-danger',
  muted: 'border-muted',
};
export const RING: Record<string, string> = {
  primary: 'ring-primary',
  secondary: 'ring-secondary',
  accent: 'ring-accent',
  info: 'ring-info',
  success: 'ring-success',
  warning: 'ring-warning',
  danger: 'ring-danger',
  muted: 'ring-muted',
};
export const TEXT: Record<string, string> = {
  primary: 'text-primary',
  secondary: 'text-secondary',
  accent: 'text-accent',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-muted',
};
export const BG: Record<string, string> = {
  primary: 'bg-primary',
  secondary: 'bg-secondary',
  accent: 'bg-accent',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-muted',
};
const FRAME_STYLE: Record<string, string> = { solid: 'border-2', double: 'border-4 border-double', dashed: 'border-2 border-dashed', glow: 'border-2 ring-2' };
const EFFECT_STYLE: Record<string, string> = { glow: 'ring-4', pulse: 'ring-2 animate-pulse', sparkle: 'ring-2' };

/** Třídy rámečku a efektu kolem avataru; `fallback` je běžné ohraničení, když nic nenosí. */
export function avatarClasses(look: PublicLook | undefined, fallback: string): { cls: string; sparkle: boolean } {
  if (!look) return { cls: fallback, sparkle: false };
  const parts: string[] = [];
  if (look.frame) parts.push(BORDER[look.frame.color] ?? '', FRAME_STYLE[look.frame.style] ?? '', look.frame.style === 'glow' ? (RING[look.frame.color] ?? '') : '');
  else parts.push(fallback);
  if (look.effect) parts.push(EFFECT_STYLE[look.effect.style] ?? '', RING[look.effect.color] ?? '');
  return { cls: parts.filter(Boolean).join(' '), sparkle: look.effect?.style === 'sparkle' };
}

const cache = new Map<string, PublicLook>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let timer: number | undefined;
let subscribed = false;

const notify = () => {
  version++;
  listeners.forEach((l) => l());
};

function flush() {
  timer = undefined;
  const ids = [...pending];
  pending.clear();
  if (ids.length === 0) return;
  get<{ looks: PublicLook[] }>(`/api/cosmetics/looks?ids=${ids.join(',')}`)
    .then((d) => {
      for (const l of d.looks) cache.set(l.userId, l);
      notify();
    })
    .catch(() => undefined);
}

/** Vzhled hráče z mezipaměti (rámeček, efekt, barva jména, titul, trofeje). Chybějící se načtou dávkou. */
export function useLook(userId: string | null | undefined): PublicLook | undefined {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  useEffect(() => {
    if (!subscribed) {
      subscribed = true;
      onSocket<{ userId: string }>('looks:changed', (m) => {
        cache.delete(m.userId);
        notify();
      });
    }
    if (!userId || cache.has(userId) || pending.has(userId)) return;
    pending.add(userId);
    if (timer === undefined) timer = window.setTimeout(flush, 50);
  }, [userId, version]);
  return userId ? cache.get(userId) : undefined;
}

/** Přezdívka v barvě, kterou si hráč zvolil. */
export function LookName({ userId, children }: { userId: string | null | undefined; children: React.ReactNode }) {
  const look = useLook(userId);
  return <span className={look?.nameColor ? (TEXT[look.nameColor] ?? '') : ''}>{children}</span>;
}

/** Titul pod přezdívkou (nic, když ho hráč nenosí). */
export function LookTitle({ userId }: { userId: string | null | undefined }) {
  const look = useLook(userId);
  if (!look?.title) return null;
  return <span className={`text-xs ${TEXT[look.title.color] ?? 'text-muted'}`}>{look.title.name}</span>;
}

/** Vitrína trofejí. */
export function Trophies({ userId }: { userId: string | null | undefined }) {
  const look = useLook(userId);
  if (!look || look.trophies.length === 0) return null;
  return (
    <span className="inline-flex gap-1" aria-label={look.trophies.map((x) => x.name).join(', ')}>
      {look.trophies.map((x) => (
        <span key={x.key} title={x.name}>
          {x.icon}
        </span>
      ))}
    </span>
  );
}

interface MyTable {
  cardBack: { color: string; style: string } | null;
  felt: string | null;
}

/** Rub karet a plsť, které nosím já (vidím je jen já); atributy se dávají na kořen stolu a stylují je v styles.css. */
export function useMyTableLook(): Record<string, string> {
  const { me } = useSession();
  const [v, setV] = useState<MyTable | null>(null);
  useEffect(() => {
    const load = () => void get<MyTable>('/api/cosmetics/table').then(setV).catch(() => setV(null));
    load();
    return onSocket<{ userId: string }>('looks:changed', (m) => m.userId === me?.user.id && load());
  }, [me?.user.id]);
  const out: Record<string, string> = {};
  if (v?.felt) out['data-my-felt'] = v.felt;
  if (v?.cardBack) {
    out['data-my-back-color'] = v.cardBack.color;
    out['data-my-back-style'] = v.cardBack.style;
  }
  return out;
}
