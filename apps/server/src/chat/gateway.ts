import type { Server, Socket } from 'socket.io';
import { chatClientMessages, type ChatMessageName } from '@kb/shared';
import { z } from 'zod';
import { ChatError, type ChatService, type MessageDto } from './service.js';

export interface ChatSocketCtx {
  io: Server;
  chat: ChatService;
  user: { userId: string; name: string };
  /** Rate limit spojení (sdílený s ostatními zprávami). */
  allow: () => boolean;
  /** Seznam právě připojených uživatelů (pro stav „online“). */
  presence: () => { userId: string; nickname: string; status: 'online' | 'table' }[];
}

type Ack = (r: { ok: true; data?: unknown } | { ok: false; code: string; params?: Record<string, unknown> }) => void;

const room = (channelId: string) => `chat:${channelId}`;

/**
 * Doručování událostí chatu. Zprávy se posílají jen těm, kdo mají v kanálu právo číst a
 * odesílatele neignorují. Připojení se přidají do místností svých kanálů (a nových soukromých zpráv).
 */
export function setupChatEvents(io: Server, chat: ChatService) {
  const userIds = async (channelId: string) => {
    const sockets = await io.in(room(channelId)).fetchSockets();
    return { sockets, ids: [...new Set(sockets.map((s) => (s.data.user as { userId: string }).userId))] };
  };
  const deliver = async (channelId: string, authorId: string | null, event: string, payload: unknown) => {
    const { sockets, ids } = await userIds(channelId);
    const ok = new Set(await chat.recipients(channelId, authorId, ids));
    for (const s of sockets) if (ok.has((s.data.user as { userId: string }).userId)) s.emit(event, payload);
  };
  chat.on({
    message: (c, m) => void deliver(c.id, m.userId, 'chat:message', m).catch(() => undefined),
    edited: (id, m) => void deliver(id, m.userId, 'chat:edited', m).catch(() => undefined),
    deleted: (id, messageId) => void io.to(room(id)).emit('chat:deleted', { channelId: id, messageId }),
    reaction: (id, messageId, reactions) => void io.to(room(id)).emit('chat:reaction', { channelId: id, messageId, reactions }),
    pinned: (id, m) => void io.to(room(id)).emit('chat:pinned', m),
    mention: (userId, m) => void io.to(`user:${userId}`).emit('chat:mention', { messageId: m.id, channelId: m.channelId, from: m.nickname }),
    joined: (userId, channelId) => void io.in(`user:${userId}`).socketsJoin(room(channelId)),
  });
}

/** Zaregistruje obsluhu zpráv chatu na jednom spojení. */
export function registerChatSocket(socket: Socket, ctx: ChatSocketCtx) {
  const { chat, user } = ctx;
  const typingAt = new Map<string, number>();

  // Místnosti kanálů, které smím číst.
  void chat
    .listChannels(user.userId)
    .then((list) => {
      for (const c of list) socket.join(room(c.id));
    })
    .catch(() => undefined);

  function handle<N extends ChatMessageName>(name: N, fn: (msg: z.infer<NonNullable<(typeof chatClientMessages)[N]>>) => Promise<unknown> | unknown) {
    (socket as unknown as { on(ev: string, fn: (...a: any[]) => void): void }).on(name, async (raw: unknown, ack?: Ack) => {
      const reply: Ack = typeof ack === 'function' ? ack : () => undefined;
      if (!ctx.allow()) return reply({ ok: false, code: 'RATE_LIMITED' });
      const parsed = (chatClientMessages[name] as z.ZodTypeAny).safeParse(raw ?? {});
      if (!parsed.success) return reply({ ok: false, code: 'INVALID_MESSAGE' });
      try {
        reply({ ok: true, data: await fn(parsed.data as never) });
      } catch (e) {
        if (e instanceof ChatError) return reply({ ok: false, code: `CHAT_${e.code}`, params: e.params });
        console.error(`[${name}]`, e);
        reply({ ok: false, code: 'UNKNOWN' });
      }
    });
  }

  handle('chat:channels', () => chat.listChannels(user.userId));
  handle('chat:history', (m) => chat.history(user.userId, m.channelId, { before: m.before, limit: m.limit }));
  handle('chat:send', (m) => chat.send(user.userId, m.channelId, m.body, { replyTo: m.replyTo ?? null, image: m.image ?? null }));
  handle('chat:notify-mute', (m) => chat.setNotifyMuted(user.userId, m.channelId, m.on));
  handle('chat:edit', (m) => chat.edit(user.userId, m.messageId, m.body));
  handle('chat:delete', (m) => chat.delete(user.userId, m.messageId));
  handle('chat:react', (m) => chat.react(user.userId, m.messageId, m.emoji));
  handle('chat:pin', (m) => chat.pin(user.userId, m.messageId, m.on));
  handle('chat:pinned', (m) => chat.pinned(user.userId, m.channelId));
  handle('chat:read', (m) => chat.markRead(user.userId, m.channelId, m.upTo));
  handle('chat:dm', async (m) => {
    const id = await chat.openDm(user.userId, m.userId);
    socket.join(room(id));
    return { channelId: id };
  });
  handle('chat:group', async (m) => ({ channelId: await chat.createGroup(user.userId, m.name, m.memberIds) }));
  handle('chat:channel', async (m) => {
    const id = await chat.createPublicChannel(user.userId, m.name, m.topic);
    ctx.io.emit('chat:channels-changed');
    return { channelId: id };
  });
  handle('chat:search', (m) => chat.search(user.userId, m.q, m.channelId));
  handle('chat:ignore', (m) => chat.setIgnore(user.userId, m.userId, m.on));
  handle('chat:mute', (m) => chat.mute(user.userId, m.userId, m.hours, m.reason, m.channelId));
  handle('chat:unmute', (m) => chat.unmute(user.userId, m.userId));
  handle('presence:list', () => ctx.presence());
  handle('chat:typing', async (m) => {
    // Kdo smí do kanálu číst, smí „psát…“ jen když může i psát; nejvýš jednou za 2 s.
    const last = typingAt.get(m.channelId) ?? 0;
    if (Date.now() - last < 2000) return;
    typingAt.set(m.channelId, Date.now());
    await chat.history(user.userId, m.channelId, { limit: 1 });
    socket.to(room(m.channelId)).emit('chat:typing', { channelId: m.channelId, userId: user.userId, nickname: user.name });
  });
}

export type { MessageDto };
