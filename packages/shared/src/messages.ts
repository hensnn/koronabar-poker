import { z } from 'zod';

/** Zprávy klient → server. Každá se na serveru validuje tímto schématem. */
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fold') }),
  z.object({ type: z.literal('check') }),
  z.object({ type: z.literal('call') }),
  z.object({ type: z.literal('allIn') }),
  z.object({ type: z.literal('bet'), amount: z.number().int().positive() }),
  z.object({ type: z.literal('raise'), amount: z.number().int().positive() }),
]);

export const tableId = z.string().min(1).max(64);

export const clientMessages = {
  'table:subscribe': z.object({ tableId }),
  'table:unsubscribe': z.object({ tableId }),
  'table:join': z.object({ tableId, seat: z.number().int().min(0).max(63), amount: z.number().int().positive() }),
  'table:leave': z.object({ tableId }),
  'table:topUp': z.object({ tableId, amount: z.number().int().positive() }),
  'table:sitOut': z.object({ tableId }),
  'table:sitIn': z.object({ tableId }),
  'table:straddle': z.object({ tableId, want: z.boolean() }),
  'table:callClock': z.object({ tableId }),
  'table:vote': z.object({ tableId, yes: z.boolean() }),
  'table:ready': z.object({ tableId, ready: z.boolean() }),
  'table:show': z.object({ tableId, which: z.union([z.literal('both'), z.literal(0), z.literal(1)]) }),
  'table:rabbit': z.object({ tableId }),
  'table:showdown': z.object({ tableId, choice: z.union([z.literal('show'), z.literal('muck')]) }),
  'table:act': z.object({ tableId, action: actionSchema }),
} as const;

export type ClientMessageName = keyof typeof clientMessages;

/** Chat: zprávy klient → server. */
const channelId = z.string().uuid();
const messageId = z.number().int().positive();
export const chatClientMessages = {
  'chat:channels': z.object({}).optional(),
  'chat:history': z.object({ channelId, before: messageId.optional(), limit: z.number().int().min(1).max(200).optional() }),
  'chat:send': z.object({ channelId, body: z.string().max(10000), replyTo: messageId.nullable().optional(), image: z.string().uuid().nullable().optional() }),
  'chat:notify-mute': z.object({ channelId, on: z.boolean() }),
  'chat:edit': z.object({ messageId, body: z.string().max(10000) }),
  'chat:delete': z.object({ messageId }),
  'chat:react': z.object({ messageId, emoji: z.string().min(1).max(16) }),
  'chat:pin': z.object({ messageId, on: z.boolean() }),
  'chat:pinned': z.object({ channelId }),
  'chat:read': z.object({ channelId, upTo: messageId }),
  'chat:typing': z.object({ channelId }),
  'chat:dm': z.object({ userId: z.string().uuid() }),
  'chat:group': z.object({ name: z.string().min(1).max(60), memberIds: z.array(z.string().uuid()).max(30) }),
  'chat:channel': z.object({ name: z.string().min(1).max(60), topic: z.string().max(200).optional() }),
  'chat:search': z.object({ q: z.string().min(2).max(100), channelId: channelId.optional() }),
  'chat:ignore': z.object({ userId: z.string().uuid(), on: z.boolean() }),
  'chat:mute': z.object({ userId: z.string().uuid(), hours: z.number().positive().max(24 * 365), reason: z.string().min(1).max(200), channelId: channelId.optional() }),
  'chat:unmute': z.object({ userId: z.string().uuid() }),
  'presence:list': z.object({}).optional(),
} as const;

export type ChatMessageName = keyof typeof chatClientMessages;
