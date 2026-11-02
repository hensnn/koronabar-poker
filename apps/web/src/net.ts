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

const FORWARDED = ['hello', 'wallet', 'settings:changed', 'permissions:changed', 'chat:message', 'chat:edited', 'chat:deleted', 'chat:reaction', 'chat:pinned', 'chat:typing', 'chat:mention', 'chat:channels-changed', 'tournament:changed', 'tournament:fx', 'tournament:log', 'tournament:result', 'table:observers', 'bounty:claimed', 'table:notice', 'notification', 'sound', 'progress:level', 'progress:achievement', 'poll:changed', 'announce', 'evening:changed', 'live:changed', 'bets:changed', 'hand:changed', 'looks:changed'];

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

// Pořadové číslo posledního přijatého pohledu na stůl: opožděná zpráva se starším `seq` nesmí přepsat novější stav.
const lastSeq = new Map<string, number>();

/** Kolik posledních vzorků rozdílu hodin se drží pro vyhlazení. */
const CLOCK_SAMPLES = 10;
// Vzorky rozdílu hodin z posledních zpráv (serverTime − čas příjmu).
let clockSamples: number[] = [];

/**
 * Vyhlazený rozdíl hodin: každý vzorek je skutečný rozdíl minus zpoždění doručení, takže zprávě s nejmenším zpožděním
 * odpovídá největší vzorek; ten je nejblíž pravdě a nekolísá s každou zprávou (odpočet na telefonu neposkakuje).
 */
export function clockOffsetFrom(samples: readonly number[]): number {
  return samples.length === 0 ? 0 : Math.max(...samples);
}

/** Má se přijmout pohled s `seq`, když poslední přijatý měl `last`? Starší verze serveru `seq` neposílá: přijme se vždy. */
export function acceptsView(last: number | undefined, seq: number | undefined): boolean {
  return seq === undefined || last === undefined || seq >= last;
}

/** Zpracování zprávy `table:view` (vyčleněno kvůli testům). */
export function receiveTableView(m: { tableId: string; view: TableView; serverTime: number }, now = Date.now()): void {
  if (!acceptsView(lastSeq.get(m.tableId), m.view?.seq)) return;
  if (typeof m.view?.seq === 'number') lastSeq.set(m.tableId, m.view.seq);
  clockSamples = [...clockSamples.slice(-(CLOCK_SAMPLES - 1)), m.serverTime - now];
  set({ views: { ...state.views, [m.tableId]: m.view }, clockOffset: clockOffsetFrom(clockSamples) });
}

/** Zahodí pohled na stůl (po odchodu ze stránky stolu); další přijatý pohled se bere bez ohledu na `seq`. */
export function dropView(tableId: string): void {
  lastSeq.delete(tableId);
  if (!(tableId in state.views)) return;
  const { [tableId]: _gone, ...rest } = state.views;
  set({ views: rest });
}

/** Nové spojení (i po restartu serveru, kde `seq` začíná znovu): pořadová čísla ani vzorky hodin už neplatí. */
export function resetViewTracking(): void {
  lastSeq.clear();
  clockSamples = [];
}

export function connectSocket() {
  if (socket) return;
  set({ status: 'connecting' });
  const s = io({ transports: ['websocket'] });
  socket = s;
  s.on('connect', () => {
    resetViewTracking();
    set({ status: 'online' });
    for (const id of announceRooms) s.emit('announce:join', id);
  });
  s.on('disconnect', () => set({ status: 'connecting' }));
  s.on('connect_error', () => set({ status: 'connecting' }));
  s.on('table:view', (m: { tableId: string; view: TableView; serverTime: number }) => receiveTableView(m));
  s.on('presence', (p: Presence[]) => set({ presence: p }));
  for (const ev of FORWARDED) s.on(ev, (d) => handlers.get(ev)?.forEach((h) => h(d)));
}

export function disconnectSocket() {
  socket?.close();
  socket = null;
  resetViewTracking();
  set({ status: 'offline', views: {}, presence: [] });
}

export const send = <T = unknown>(event: string, data?: unknown) =>
  new Promise<Ack & { data?: T }>((resolve) => {
    if (!socket) return resolve({ ok: false, code: 'NETWORK' } as Ack & { data?: T });
    socket.timeout(8000).emit(event, data ?? {}, (err: Error | null, ack: Ack) => resolve((err ? { ok: false, code: 'NETWORK' } : ack) as Ack & { data?: T }));
  });

export const table = {
  subscribe: (tableId: string) => send('table:subscribe', { tableId }),
  /** Odhlásí odběr stolu a zahodí jeho pohled: server už nemá posílat stav stolů, které hráč opustil. */
  unsubscribe: (tableId: string) => {
    dropView(tableId);
    return send('table:unsubscribe', { tableId });
  },
  join: (tableId: string, seat: number, amount: number) => send('table:join', { tableId, seat, amount }),
  leave: (tableId: string) => send('table:leave', { tableId }),
  topUp: (tableId: string, amount: number) => send('table:topUp', { tableId, amount }),
  sitOut: (tableId: string) => send('table:sitOut', { tableId }),
  sitIn: (tableId: string) => send('table:sitIn', { tableId }),
  straddle: (tableId: string, want: boolean) => send('table:straddle', { tableId, want }),
  callClock: (tableId: string) => send('table:callClock', { tableId }),
  ready: (tableId: string, ready: boolean) => send('table:ready', { tableId, ready }),
  vote: (tableId: string, yes: boolean) => send('table:vote', { tableId, yes }),
  show: (tableId: string, which: 'both' | 0 | 1) => send('table:show', { tableId, which }),
  rabbit: (tableId: string) => send('table:rabbit', { tableId }),
  showdown: (tableId: string, choice: 'show' | 'muck') => send('table:showdown', { tableId, choice }),
  /** Akce v handě nese `handId`: opožděnou nebo zdvojenou zprávu z předchozí handy server odmítne (STALE_ACTION). */
  act: (tableId: string, action: PlayerAction, handId: string | null = null) => send('table:act', { tableId, action, handId: handId ?? undefined }),
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useNet(): NetState {
  return useSyncExternalStore(subscribe, () => state);
}

/**
 * Výřez stavu sítě: komponenta se překreslí jen při změně vybrané části (stůl se nepřekresluje kvůli přítomnosti v chatu).
 * Selektor má vracet primitivum nebo existující část stavu, ne nový objekt.
 */
export function useNetSelector<T>(selector: (s: NetState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/** Stav sítě mimo React (testy). */
export const netState = () => state;
