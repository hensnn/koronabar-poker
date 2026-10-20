import { useSyncExternalStore } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { PlayerAction, TableView } from '@kb/game-core';

export interface Presence {
  userId: string;
  nickname: string;
  status: 'online' | 'table';
}

export interface NetState {
  status: 'offline' | 'connecting' | 'online';
  /** Rozdíl hodin server − klient (ms), pro správné odpočty. */
  clockOffset: number;
  views: Record<string, TableView>;
  presence: Presence[];
}

export type Ack = { ok: true; data?: unknown } | { ok: false; code: string; params?: Record<string, unknown> };

let state: NetState = { status: 'offline', clockOffset: 0, views: {}, presence: [] };
const listeners = new Set<() => void>();
let socket: Socket | null = null;
const handlers = new Map<string, Set<(data: any) => void>>();

const set = (patch: Partial<NetState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

/** Odběr události ze serveru (musí být v seznamu FORWARDED níže) (chat, nastavení, peněženka…). */
export function onSocket<T = unknown>(event: string, fn: (data: T) => void): () => void {
  let set_ = handlers.get(event);
  if (!set_) {
    set_ = new Set();
    handlers.set(event, set_);
  }
  set_.add(fn);
  return () => void set_!.delete(fn);
}

const FORWARDED = ['hello', 'wallet', 'settings:changed', 'permissions:changed', 'chat:message', 'chat:edited', 'chat:deleted', 'chat:reaction', 'chat:pinned', 'chat:typing', 'chat:mention', 'chat:channels-changed', 'tournament:changed', 'tournament:fx', 'tournament:result', 'notification', 'sound', 'progress:level', 'progress:achievement', 'poll:changed', 'announce', 'evening:changed', 'live:changed', 'bets:changed', 'hand:changed', 'looks:changed'];

const announceRooms = new Set<string>();
/** Místnosti hlasatele (stránka turnaje nebo živé hry); po obnovení spojení se přihlásí znovu. */
export const announceRoom = {
  join(id: string) {
    announceRooms.add(id);
    socket?.emit('announce:join', id);
  },
  leave(id: string) {
    announceRooms.delete(id);
    socket?.emit('announce:leave', id);
  },
};

export function connectSocket() {
  if (socket) return;
  set({ status: 'connecting' });
  const s = io({ transports: ['websocket'] });
  socket = s;
  s.on('connect', () => {
    set({ status: 'online' });
    for (const id of announceRooms) s.emit('announce:join', id);
  });
  s.on('disconnect', () => set({ status: 'connecting' }));
  s.on('connect_error', () => set({ status: 'connecting' }));
  s.on('table:view', (m: { tableId: string; view: TableView; serverTime: number }) =>
    set({ views: { ...state.views, [m.tableId]: m.view }, clockOffset: m.serverTime - Date.now() }),
  );
  s.on('presence', (p: Presence[]) => set({ presence: p }));
  for (const ev of FORWARDED) s.on(ev, (d) => handlers.get(ev)?.forEach((h) => h(d)));
}

export function disconnectSocket() {
  socket?.close();
  socket = null;
  set({ status: 'offline', views: {}, presence: [] });
}

export const send = <T = unknown>(event: string, data?: unknown) =>
  new Promise<Ack & { data?: T }>((resolve) => {
    if (!socket) return resolve({ ok: false, code: 'NETWORK' } as Ack & { data?: T });
    socket.timeout(8000).emit(event, data ?? {}, (err: Error | null, ack: Ack) => resolve((err ? { ok: false, code: 'NETWORK' } : ack) as Ack & { data?: T }));
  });

export const table = {
  subscribe: (tableId: string) => send('table:subscribe', { tableId }),
  join: (tableId: string, seat: number, amount: number) => send('table:join', { tableId, seat, amount }),
  leave: (tableId: string) => send('table:leave', { tableId }),
  topUp: (tableId: string, amount: number) => send('table:topUp', { tableId, amount }),
  sitOut: (tableId: string) => send('table:sitOut', { tableId }),
  sitIn: (tableId: string) => send('table:sitIn', { tableId }),
  straddle: (tableId: string, want: boolean) => send('table:straddle', { tableId, want }),
  callClock: (tableId: string) => send('table:callClock', { tableId }),
  vote: (tableId: string, yes: boolean) => send('table:vote', { tableId, yes }),
  show: (tableId: string, which: 'both' | 0 | 1) => send('table:show', { tableId, which }),
  rabbit: (tableId: string) => send('table:rabbit', { tableId }),
  showdown: (tableId: string, choice: 'show' | 'muck') => send('table:showdown', { tableId, choice }),
  act: (tableId: string, action: PlayerAction) => send('table:act', { tableId, action }),
};

export function useNet(): NetState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
