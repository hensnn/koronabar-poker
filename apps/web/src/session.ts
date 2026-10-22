import { useSyncExternalStore } from 'react';
import { get, post, ApiError } from './api';
import { connectSocket, disconnectSocket, onSocket } from './net';
import { viewAs } from './view-as';

export interface Me {
  user: { id: string; nickname: string; email: string | null; emailVerified: boolean; status: string; blockedReason: string | null; blockedUntil: string | null; avatar: string | null };
  permissions: string[];
  limits: Record<string, Record<string, number>>;
  approvals: Record<string, boolean>;
  mainAdmin: boolean;
  power: number;
  balance: number;
}

interface SessionState {
  status: 'loading' | 'anonymous' | 'authenticated';
  me: Me | null;
}

let state: SessionState = { status: 'loading', me: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<SessionState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export function useSession(): SessionState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Zda má přihlášený uživatel dané oprávnění (UI jen skrývá, server kontroluje vždy). */
export const can = (me: Me | null, permission: string): boolean => !!me?.permissions.includes(permission);

/** Načte stav přihlášení (volá se při startu a po změnách rolí). */
export async function refreshSession(): Promise<void> {
  try {
    const me = await get<Me>('/api/auth/me');
    set({ status: 'authenticated', me });
    // Při zobrazení jako jiný uživatel se spojení se stoly nenavazuje (živá data by patřila správci, ne zobrazovanému hráči).
    if (!viewAs()) connectSocket();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      disconnectSocket();
      set({ status: 'anonymous', me: null });
    } else if (state.status === 'loading') {
      set({ status: 'anonymous', me: null });
    }
  }
}

export async function login(identifier: string, password: string): Promise<void> {
  const me = await post<Me>('/api/auth/login', { identifier, password });
  set({ status: 'authenticated', me });
  connectSocket();
}

export async function logout(): Promise<void> {
  try {
    await post('/api/auth/logout');
  } finally {
    disconnectSocket();
    set({ status: 'anonymous', me: null });
  }
}

export function updateBalance(balance: number) {
  if (state.me) set({ me: { ...state.me, balance } });
}

// Události ze serveru, které mění stav přihlášení a peněženky.
onSocket<{ balance: number }>('hello', (m) => updateBalance(m.balance));
onSocket<{ balance: number }>('wallet', (m) => updateBalance(m.balance));
onSocket('permissions:changed', () => void refreshSession());
