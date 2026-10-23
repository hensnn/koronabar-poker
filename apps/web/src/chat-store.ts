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
}

interface State {
  channels: Channel[];
  messages: Record<string, Message[]>;
  typing: Record<string, { nickname: string; at: number }[]>;
  /** Kanál, který má uživatel právě otevřený (zprávy se hned označí za přečtené). */
  active: string | null;
  mentions: number;
}

let state: State = { channels: [], messages: {}, typing: {}, active: null, mentions: 0 };
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

export async function openChannel(id: string, before?: number): Promise<void> {
  const rows = await unwrap<Message[]>(send('chat:history', { channelId: id, before, limit: 50 }));
  const prev = before ? (state.messages[id] ?? []) : [];
  set({ messages: { ...state.messages, [id]: [...rows, ...prev] }, active: before ? state.active : id });
  const last = rows.at(-1)?.id;
  if (!before && last) void markRead(id, last);
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

const patchMessage = (channelId: string, id: number, fn: (m: Message) => Message) =>
  set({ messages: { ...state.messages, [channelId]: (state.messages[channelId] ?? []).map((m) => (m.id === id ? fn(m) : m)) } });

onSocket<Message>('chat:message', (m) => {
  const known = state.messages[m.channelId];
  if (known && !known.some((x) => x.id === m.id)) set({ messages: { ...state.messages, [m.channelId]: [...known, m] } });
  const isActive = state.active === m.channelId;
  set({ channels: state.channels.map((c) => (c.id === m.channelId ? { ...c, lastMessageId: m.id, unread: isActive ? 0 : c.unread + 1 } : c)) });
  if (isActive) void markRead(m.channelId, m.id);
  if (!state.channels.some((c) => c.id === m.channelId)) void loadChannels();
});
onSocket<Message>('chat:edited', (m) => patchMessage(m.channelId, m.id, () => m));
onSocket<Message>('chat:pinned', (m) => patchMessage(m.channelId, m.id, () => m));
onSocket<{ channelId: string; messageId: number }>('chat:deleted', (m) => patchMessage(m.channelId, m.messageId, (x) => ({ ...x, deleted: true, body: '' })));
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
