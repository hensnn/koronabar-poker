import { useSyncExternalStore } from 'react';
import { send, onSocket, type Ack } from './net';

export interface Channel {
  id: string;
  key: string;
  name: string;
  kind: 'public' | 'dm' | 'group' | 'table';
  topic: string | null;
  unread: number;
  lastMessageId: number;
  peer?: { id: string; nickname: string };
  notifyMuted: boolean;
}

export interface Message {
  id: number;
  channelId: string;
  userId: string | null;
  nickname: string | null;
  body: string;
  replyTo: number | null;
  system: boolean;
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  pinned: boolean;
  reactions: Record<string, string[]>;
  image: string | null;
  /** Thread the message belongs to (id of the question); null for a message of the main line. */
  threadId: number | null;
  /** Replies under this message (only in a channel shown with threads). */
  thread?: ThreadSummary | null;
}

export interface ThreadSummary {
  count: number;
  lastId: number;
  lastAt: string;
  lastNickname: string | null;
  unread: number;
}

interface State {
  channels: Channel[];
  messages: Record<string, Message[]>;
  /** Channels shown with threads: their main line holds no replies, those sit under the questions. */
  threaded: Record<string, boolean>;
  /** Replies of the threads that were opened, by the id of the question. */
  threads: Record<number, Message[]>;
  /** Replies the user has not seen yet (thread collapsed), by the id of the question. */
  fresh: Record<number, number>;
  typing: Record<string, { nickname: string; at: number }[]>;
  /** Kanál, který má uživatel právě otevřený (zprávy se hned označí za přečtené). */
  active: string | null;
  mentions: number;
}

let state: State = { channels: [], messages: {}, threaded: {}, threads: {}, fresh: {}, typing: {}, active: null, mentions: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const useChatStore = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );

export const totalUnread = (s: State) => s.channels.reduce((n, c) => n + c.unread, 0);

const unwrap = async <T>(p: Promise<Ack & { data?: T }>): Promise<T> => {
  const r = await p;
  if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code, params: r.params });
  return r.data as T;
};

export async function loadChannels(): Promise<void> {
  const channels = await unwrap<Channel[]>(send('chat:channels'));
  set({ channels });
}

/** Loads a channel (or its older part). With `threads` the main line comes without replies and with thread summaries. */
export async function openChannel(id: string, before?: number, threads = false): Promise<void> {
  const rows = await unwrap<Message[]>(send('chat:history', { channelId: id, before, limit: 50, threads }));
  const prev = before ? (state.messages[id] ?? []) : [];
  // replies that came while the user was away mark their threads as new
  const fresh = { ...state.fresh };
  for (const r of rows) if (r.thread && r.thread.unread > 0) fresh[r.id] = r.thread.unread;
  set({ messages: { ...state.messages, [id]: [...rows, ...prev] }, threaded: { ...state.threaded, [id]: threads }, fresh, active: before ? state.active : id });
  // the newest message may be a reply hidden in a thread: read up to it, or the channel would stay unread
  const last = Math.max(rows.at(-1)?.id ?? 0, ...rows.map((r) => r.thread?.lastId ?? 0));
  if (!before && last) void markRead(id, last);
}

/** Loads the replies of one thread and marks them as seen. */
export async function loadThread(rootId: number): Promise<void> {
  const rows = await unwrap<Message[]>(send('chat:thread', { messageId: rootId }));
  const fresh = { ...state.fresh };
  delete fresh[rootId];
  set({ threads: { ...state.threads, [rootId]: rows }, fresh });
}

/** The user looks at the thread: its new replies are seen. */
export function seenThread(rootId: number): void {
  if (!state.fresh[rootId]) return;
  const fresh = { ...state.fresh };
  delete fresh[rootId];
  set({ fresh });
}

export function setActive(id: string | null) {
  set({ active: id });
}

export async function markRead(channelId: string, upTo: number): Promise<void> {
  set({ channels: state.channels.map((c) => (c.id === channelId ? { ...c, unread: 0 } : c)) });
  await send('chat:read', { channelId, upTo });
}

export const sendMessage = (channelId: string, body: string, replyTo?: number | null, image?: string | null) => unwrap<Message>(send('chat:send', { channelId, body, replyTo: replyTo ?? null, image: image ?? null }));
export const setNotifyMuted = async (channelId: string, on: boolean) => {
  await unwrap<void>(send('chat:notify-mute', { channelId, on }));
  await loadChannels();
};
export const editMessage = (messageId: number, body: string) => unwrap<Message>(send('chat:edit', { messageId, body }));
export const deleteMessage = (messageId: number) => unwrap<void>(send('chat:delete', { messageId }));
export const reactTo = (messageId: number, emoji: string) => unwrap<Record<string, string[]>>(send('chat:react', { messageId, emoji }));
export const pinMessage = (messageId: number, on: boolean) => unwrap<Message>(send('chat:pin', { messageId, on }));
export const startDm = async (userId: string) => {
  const r = await unwrap<{ channelId: string }>(send('chat:dm', { userId }));
  await loadChannels();
  return r.channelId;
};
export const startGroup = async (name: string, memberIds: string[]) => {
  const r = await unwrap<{ channelId: string }>(send('chat:group', { name, memberIds }));
  await loadChannels();
  return r.channelId;
};
export const createChannel = async (name: string, topic?: string) => {
  const r = await unwrap<{ channelId: string }>(send('chat:channel', { name, topic }));
  await loadChannels();
  return r.channelId;
};
export const searchMessages = (q: string, channelId?: string) => unwrap<Message[]>(send('chat:search', { q, channelId }));
export const setIgnore = (userId: string, on: boolean) => unwrap<void>(send('chat:ignore', { userId, on }));
export const muteUser = (userId: string, hours: number, reason: string, channelId?: string) => unwrap<void>(send('chat:mute', { userId, hours, reason, channelId }));
export const notifyTyping = (channelId: string) => void send('chat:typing', { channelId });

/** Changes one message wherever it is held: in the main line of its channel or among the replies of an opened thread. */
const patchMessage = (channelId: string, id: number, fn: (m: Message) => Message) => {
  const threads = Object.fromEntries(Object.entries(state.threads).map(([root, list]) => [root, list.some((m) => m.id === id) ? list.map((m) => (m.id === id ? fn(m) : m)) : list]));
  set({ messages: { ...state.messages, [channelId]: (state.messages[channelId] ?? []).map((m) => (m.id === id ? fn(m) : m)) }, threads });
};

onSocket<Message>('chat:message', (m) => {
  const known = state.messages[m.channelId];
  if (m.threadId && state.threaded[m.channelId]) {
    // a reply in a channel with threads stays out of the main line: it goes under its question
    const root = m.threadId;
    const loaded = state.threads[root];
    if (!loaded?.some((x) => x.id === m.id)) {
      const bump = (x: Message): Message => ({ ...x, thread: { count: (x.thread?.count ?? 0) + 1, lastId: m.id, lastAt: m.createdAt, lastNickname: m.nickname, unread: x.thread?.unread ?? 0 } });
      set({
        threads: loaded ? { ...state.threads, [root]: [...loaded, m] } : state.threads,
        messages: known ? { ...state.messages, [m.channelId]: known.map((x) => (x.id === root ? bump(x) : x)) } : state.messages,
        fresh: { ...state.fresh, [root]: (state.fresh[root] ?? 0) + 1 },
      });
    }
  } else if (known && !known.some((x) => x.id === m.id)) set({ messages: { ...state.messages, [m.channelId]: [...known, m] } });
  const isActive = state.active === m.channelId;
  set({ channels: state.channels.map((c) => (c.id === m.channelId ? { ...c, lastMessageId: m.id, unread: isActive ? 0 : c.unread + 1 } : c)) });
  if (isActive) void markRead(m.channelId, m.id);
  if (!state.channels.some((c) => c.id === m.channelId)) void loadChannels();
});
onSocket<Message>('chat:edited', (m) => patchMessage(m.channelId, m.id, () => m));
onSocket<Message>('chat:pinned', (m) => patchMessage(m.channelId, m.id, () => m));
onSocket<{ channelId: string; messageId: number; threadId?: number | null }>('chat:deleted', (m) => {
  patchMessage(m.channelId, m.messageId, (x) => ({ ...x, deleted: true, body: '' }));
  // a deleted reply no longer counts in the summary under its question
  const root = m.threadId;
  if (root) patchMessage(m.channelId, root, (x) => (x.thread ? { ...x, thread: x.thread.count > 1 ? { ...x.thread, count: x.thread.count - 1 } : null } : x));
});
onSocket<{ channelId: string; messageId: number; reactions: Record<string, string[]> }>('chat:reaction', (m) => patchMessage(m.channelId, m.messageId, (x) => ({ ...x, reactions: m.reactions })));
onSocket<{ channelId: string; nickname: string }>('chat:typing', (m) => {
  const now = Date.now();
  const list = (state.typing[m.channelId] ?? []).filter((x) => now - x.at < 4000 && x.nickname !== m.nickname);
  set({ typing: { ...state.typing, [m.channelId]: [...list, { nickname: m.nickname, at: now }] } });
  setTimeout(() => set({ typing: { ...state.typing, [m.channelId]: (state.typing[m.channelId] ?? []).filter((x) => Date.now() - x.at < 4000) } }), 4100);
});
onSocket('chat:mention', () => set({ mentions: state.mentions + 1 }));
onSocket('chat:channels-changed', () => void loadChannels().catch(() => undefined));

/** Přišla mi nová soukromá zpráva od protějšku (ne zpráva s @zmínkou, ta má vlastní událost, a ne ztlumený kanál). */
export const isIncomingDm = (m: Message): boolean => {
  const c = state.channels.find((x) => x.id === m.channelId);
  return !!c && c.kind === 'dm' && !c.notifyMuted && !m.system && m.mentions.length === 0 && !!c.peer && m.userId === c.peer.id;
};
