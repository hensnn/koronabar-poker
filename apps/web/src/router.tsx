import { useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from 'react';

interface Loc {
  path: string;
  search: string;
}

let loc: Loc = { path: window.location.pathname, search: window.location.search };
const listeners = new Set<() => void>();
const update = () => {
  loc = { path: window.location.pathname, search: window.location.search };
  listeners.forEach((l) => l());
};
window.addEventListener('popstate', update);

export function useLocation(): Loc {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => loc,
  );
}

export function navigate(to: string, replace = false): void {
  if (to === window.location.pathname + window.location.search) return;
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  update();
}

export function Link({ to, onClick, ...p }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string; children?: ReactNode }) {
  return (
    <a
      {...p}
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

/** Porovná cestu se vzorem `/stul/:id`; vrací parametry, nebo null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export const queryParam = (search: string, key: string): string => new URLSearchParams(search).get(key) ?? '';

/** Přesměruje hned po vykreslení (např. nepřihlášený na přihlášení). */
export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, true), [to]);
  return null;
}
