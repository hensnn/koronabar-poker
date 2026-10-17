import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { PermissionChecker, SettingValues } from '@kb/shared';
import type { AuditService } from '../auth/audit.js';
import { AttemptLimiter } from '../auth/rate-limit.js';
import { schema, type Db } from '../db/index.js';

export type ChatErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DISABLED'
  | 'IMAGE_DISABLED'
  | 'IMAGE_FORMAT'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_INVALID'
  | 'EMPTY'
  | 'TOO_LONG'
  | 'RATE_LIMITED'
  | 'MUTED'
  | 'INVALID'
  | 'EDIT_EXPIRED'
  | 'NOT_MEMBER'
  | 'BAD_EMOJI';

export class ChatError extends Error {
  constructor(
    public readonly code: ChatErrorCode,
    public readonly params?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export interface ChannelDto {
  id: string;
  key: string;
  name: string;
  kind: string;
  topic: string | null;
  unread: number;
  lastMessageId: number;
  /** U soukromé zprávy: druhý účastník. */
  peer?: { id: string; nickname: string };
  /** Upozornění (push, souhrn) z tohoto kanálu jsou pro uživatele vypnutá. */
  notifyMuted: boolean;
}

export interface MessageDto {
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
  /** Id přiloženého obrázku (stahuje se z /api/chat/images/:id). */
  image: string | null;
}

export interface ChatEvents {
  message(channel: { id: string; key: string; kind: string }, msg: MessageDto): void;
  edited(channelId: string, msg: MessageDto): void;
  deleted(channelId: string, messageId: number): void;
  reaction(channelId: string, messageId: number, reactions: Record<string, string[]>): void;
  pinned(channelId: string, msg: MessageDto): void;
  /** Uživatel byl zmíněn (pro push a e-mailový souhrn). */
  mention(userId: string, msg: MessageDto): void;
  /** Uživatel se stal členem kanálu (např. nová soukromá zpráva). */
  joined(userId: string, channelId: string): void;
}

export interface TableAccess {
  /** Smí uživatel číst/psát do chatu tohoto stolu? */
  (userId: string, tableId: string): { read: boolean; write: boolean };
}

const NICK = /(?:^|[^\p{L}\p{N}_-])@([\p{L}\p{N}_-]{2,24})/gu;

export class ChatService {
  private limiter: AttemptLimiter;
  private events: Partial<ChatEvents> = {};

  constructor(
    private deps: {
      db: Db;
      perms: PermissionChecker;
      audit: AuditService;
      settings: () => SettingValues;
      tableAccess?: TableAccess;
      now?: () => Date;
    },
  ) {
    this.limiter = new AttemptLimiter(() => this.now().getTime());
  }

  /** Přidá obsluhu událostí; obsluhy téže události se řetězí (nepřepisují). */
  on(handlers: Partial<ChatEvents>): void {
    const merged: Record<string, (...a: any[]) => void> = { ...(this.events as Record<string, (...a: any[]) => void>) };
    for (const [k, fn] of Object.entries(handlers) as [string, (...a: any[]) => void][]) {
      const prev = merged[k];
      merged[k] = prev ? (...a) => (prev(...a), fn(...a)) : fn;
    }
    this.events = merged as unknown as Partial<ChatEvents>;
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }
  private get s() {
    return this.deps.settings();
  }

  // ---------- kanály ----------

  /** Hlavní společný kanál (vytvoří se při prvním startu). */
  async ensureMainChannel(): Promise<string> {
    const [c] = await this.deps.db.select().from(schema.chatChannels).where(eq(schema.chatChannels.key, 'hospoda'));
    if (c) return c.id;
    const [row] = await this.deps.db.insert(schema.chatChannels).values({ key: 'hospoda', name: String(this.s['chat.mainChannelName']), kind: 'public' }).returning({ id: schema.chatChannels.id });
    return row!.id;
  }

  private async channel(id: string) {
    const [c] = await this.deps.db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, id));
    if (!c || c.archivedAt) throw new ChatError('NOT_FOUND');
    return c;
  }

  private async isMember(channelId: string, userId: string): Promise<boolean> {
    const [m] = await this.deps.db.select({ u: schema.chatMembers.userId }).from(schema.chatMembers).where(and(eq(schema.chatMembers.channelId, channelId), eq(schema.chatMembers.userId, userId)));
    return !!m;
  }

  /** Právo číst a psát v kanálu podle jeho druhu a oprávnění uživatele. */
  async access(userId: string, ch: { id: string; kind: string; key: string }): Promise<{ read: boolean; write: boolean }> {
    if (!this.s['chat.enabled']) return { read: false, write: false };
    const scope = { scopeType: 'channel' as const, scopeId: ch.key };
    const canWrite = this.deps.perms.can(userId, 'chat.psat', scope).allowed;
    switch (ch.kind) {
      case 'public': {
        const read = canWrite || this.deps.perms.can(userId, 'prihlizet.zobrazit').allowed;
        return { read, write: canWrite };
      }
      case 'dm':
      case 'group': {
        const member = await this.isMember(ch.id, userId);
        return { read: member, write: member && canWrite };
      }
      case 'table': {
        const t = this.deps.tableAccess?.(userId, ch.key.slice('table:'.length)) ?? { read: false, write: false };
        return { read: t.read, write: t.write && canWrite && this.deps.perms.can(userId, 'stul.chat').allowed };
      }
      default:
        return { read: false, write: false };
    }
  }

  /** Smí uživatel psát do kanálu (kontrola pro odesílání zvukových emotikonů). */
  async canRead(userId: string, channelId: string): Promise<boolean> {
    try {
      await this.readable(userId, channelId);
      return true;
    } catch {
      return false;
    }
  }

  async canWrite(userId: string, channelId: string): Promise<boolean> {
    try {
      return (await this.readable(userId, channelId)).write;
    } catch {
      return false;
    }
  }

  private async readable(userId: string, channelId: string) {
    const ch = await this.channel(channelId);
    const a = await this.access(userId, ch);
    if (!a.read) throw new ChatError('FORBIDDEN');
    return { ch, ...a };
  }

  async listChannels(userId: string): Promise<ChannelDto[]> {
    if (!this.s['chat.enabled']) return [];
    const all = await this.deps.db.select().from(schema.chatChannels).where(isNull(schema.chatChannels.archivedAt));
    const out: ChannelDto[] = [];
    for (const ch of all) {
      if (ch.kind === 'table' && !(this.deps.tableAccess?.(userId, ch.key.slice('table:'.length)).read)) continue;
      const a = await this.access(userId, ch);
      if (!a.read) continue;
      const [last] = await this.deps.db.select({ id: sql<number>`coalesce(max(${schema.chatMessages.id}), 0)::int` }).from(schema.chatMessages).where(and(eq(schema.chatMessages.channelId, ch.id), isNull(schema.chatMessages.deletedAt)));
      const [mem] = await this.deps.db.select().from(schema.chatMembers).where(and(eq(schema.chatMembers.channelId, ch.id), eq(schema.chatMembers.userId, userId)));
      const lastRead = mem?.lastReadId ?? 0;
      const [unread] = await this.deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.chatMessages)
        .where(and(eq(schema.chatMessages.channelId, ch.id), gt(schema.chatMessages.id, lastRead), isNull(schema.chatMessages.deletedAt), or(isNull(schema.chatMessages.userId), sql`${schema.chatMessages.userId} <> ${userId}`)));
      const dto: ChannelDto = { id: ch.id, key: ch.key, name: ch.name, kind: ch.kind, topic: ch.topic, unread: unread?.n ?? 0, lastMessageId: last?.id ?? 0, notifyMuted: mem?.notifyMuted ?? false };
      if (ch.kind === 'dm') {
        const peerId = ch.key.split(':').slice(1).find((x) => x !== userId);
        if (peerId) {
          const [p] = await this.deps.db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users).where(eq(schema.users.id, peerId));
          if (p) {
            dto.peer = p;
            dto.name = p.nickname;
          }
        }
      }
      out.push(dto);
    }
    return out.sort((a, b) => (a.kind === 'public' ? 0 : 1) - (b.kind === 'public' ? 0 : 1) || a.name.localeCompare(b.name));
  }

  /** Soukromá zpráva 1:1: vrátí existující nebo nový kanál. */
  async openDm(userId: string, otherId: string): Promise<string> {
    if (userId === otherId) throw new ChatError('INVALID');
    const [other] = await this.deps.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, otherId));
    if (!other) throw new ChatError('NOT_FOUND');
    if (!this.deps.perms.can(userId, 'chat.psat').allowed) throw new ChatError('FORBIDDEN');
    const key = `dm:${[userId, otherId].sort().join(':')}`;
    const [existing] = await this.deps.db.select().from(schema.chatChannels).where(eq(schema.chatChannels.key, key));
    if (existing) return existing.id;
    const id = await this.deps.db.transaction(async (trx) => {
      const [c] = await trx.insert(schema.chatChannels).values({ key, name: 'dm', kind: 'dm' }).returning({ id: schema.chatChannels.id });
      await trx.insert(schema.chatMembers).values([{ channelId: c!.id, userId }, { channelId: c!.id, userId: otherId }]);
      return c!.id;
    });
    this.events.joined?.(userId, id);
    this.events.joined?.(otherId, id);
    return id;
  }

  async createGroup(userId: string, name: string, memberIds: string[]): Promise<string> {
    if (!this.deps.perms.can(userId, 'chat.vytvorit_kanal').allowed || !this.deps.perms.can(userId, 'chat.psat').allowed) throw new ChatError('FORBIDDEN');
    const members = [...new Set([userId, ...memberIds])];
    if (!name.trim() || name.length > 60 || members.length < 2 || members.length > 20) throw new ChatError('INVALID');
    const users = await this.deps.db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, members));
    if (users.length !== members.length) throw new ChatError('NOT_FOUND');
    const id = await this.deps.db.transaction(async (trx) => {
      const [c] = await trx.insert(schema.chatChannels).values({ key: `group:${randomBytes(6).toString('hex')}`, name: name.trim(), kind: 'group', ownerId: userId }).returning({ id: schema.chatChannels.id });
      await trx.insert(schema.chatMembers).values(members.map((m) => ({ channelId: c!.id, userId: m })));
      return c!.id;
    });
    for (const m of members) this.events.joined?.(m, id);
    return id;
  }

  /** Veřejný kanál: správci vždy, hráči jen když to nastavení dovolí. */
  async createPublicChannel(userId: string, name: string, topic?: string): Promise<string> {
    const admin = this.deps.perms.can(userId, 'chat.spravovat_kanaly').allowed;
    const player = !!this.s['chat.playerChannels'] && this.deps.perms.can(userId, 'chat.vytvorit_kanal').allowed;
    if (!admin && !player) throw new ChatError('FORBIDDEN');
    const clean = name.trim();
    if (clean.length < 2 || clean.length > 40) throw new ChatError('INVALID');
    const key = clean.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!key) throw new ChatError('INVALID');
    const [dup] = await this.deps.db.select({ id: schema.chatChannels.id }).from(schema.chatChannels).where(eq(schema.chatChannels.key, key));
    if (dup) throw new ChatError('INVALID', { reason: 'duplicate' });
    const [c] = await this.deps.db.insert(schema.chatChannels).values({ key, name: clean, kind: 'public', ownerId: userId, topic: topic ?? null }).returning({ id: schema.chatChannels.id });
    await this.deps.audit.log({ actorId: userId, action: 'chat.kanal_vytvoren', targetType: 'chat_channel', targetId: c!.id, after: { name: clean } });
    return c!.id;
  }

  async archiveChannel(userId: string, channelId: string): Promise<void> {
    if (!this.deps.perms.can(userId, 'chat.spravovat_kanaly').allowed) throw new ChatError('FORBIDDEN');
    const ch = await this.channel(channelId);
    if (ch.key === 'hospoda') throw new ChatError('INVALID', { reason: 'main' });
    await this.deps.db.update(schema.chatChannels).set({ archivedAt: this.now() }).where(eq(schema.chatChannels.id, channelId));
    await this.deps.audit.log({ actorId: userId, action: 'chat.kanal_archivovan', targetType: 'chat_channel', targetId: channelId });
  }

  /** Chat stolu (vzniká se stolem a zůstane jako archiv). */
  async ensureTableChannel(tableId: string, name: string): Promise<string> {
    const key = `table:${tableId}`;
    const [c] = await this.deps.db.select().from(schema.chatChannels).where(eq(schema.chatChannels.key, key));
    if (c) return c.id;
    const [row] = await this.deps.db.insert(schema.chatChannels).values({ key, name, kind: 'table' }).returning({ id: schema.chatChannels.id });
    return row!.id;
  }

  async channelIdByKey(key: string): Promise<string | undefined> {
    const [c] = await this.deps.db.select({ id: schema.chatChannels.id }).from(schema.chatChannels).where(eq(schema.chatChannels.key, key));
    return c?.id;
  }

  // ---------- zprávy ----------

  private filterWords(body: string): string {
    const words = String(this.s['chat.wordFilter']).split(',').map((w) => w.trim()).filter(Boolean);
    let out = body;
    for (const w of words) out = out.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => '*'.repeat(m.length));
    return out;
  }

  private async activeMute(userId: string, channelId: string) {
    const now = this.now();
    const rows = await this.deps.db
      .select()
      .from(schema.chatMutes)
      .where(and(eq(schema.chatMutes.userId, userId), isNull(schema.chatMutes.liftedAt), gt(schema.chatMutes.until, now), or(isNull(schema.chatMutes.channelId), eq(schema.chatMutes.channelId, channelId))));
    return rows[0];
  }

  private async toDto(rows: (typeof schema.chatMessages.$inferSelect)[]): Promise<MessageDto[]> {
    if (!rows.length) return [];
    const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
    const users = userIds.length ? await this.deps.db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
    const nick = new Map(users.map((u) => [u.id, u.nickname]));
    const reactions = await this.deps.db.select().from(schema.chatReactions).where(inArray(schema.chatReactions.messageId, rows.map((r) => r.id)));
    return rows.map((r) => {
      const rs: Record<string, string[]> = {};
      for (const x of reactions.filter((x) => x.messageId === r.id)) (rs[x.emoji] ??= []).push(x.userId);
      return {
        id: r.id,
        channelId: r.channelId,
        userId: r.userId,
        nickname: r.userId ? (nick.get(r.userId) ?? null) : null,
        body: r.deletedAt ? '' : r.body,
        replyTo: r.replyTo,
        system: r.system,
        mentions: r.mentions ?? [],
        createdAt: r.createdAt.toISOString(),
        editedAt: r.editedAt?.toISOString() ?? null,
        deleted: !!r.deletedAt,
        pinned: !!r.pinnedAt,
        reactions: rs,
        image: r.deletedAt ? null : (r.image ?? null),
      };
    });
  }

  async send(userId: string, channelId: string, rawBody: string, opts: { replyTo?: number | null; image?: string | null } = {}): Promise<MessageDto> {
    const { ch, write } = await this.readable(userId, channelId);
    if (!write) throw new ChatError('FORBIDDEN');
    const body = (rawBody ?? '').replace(/\r\n/g, '\n').trim();
    const max = Number(this.s['chat.maxLength']);
    if (!body && !opts.image) throw new ChatError('EMPTY');
    if (body.length > max) throw new ChatError('TOO_LONG', { max });
    if (opts.image) {
      if (!this.s['chat.imagesEnabled']) throw new ChatError('IMAGE_DISABLED');
      const [img] = await this.deps.db.select().from(schema.chatImages).where(eq(schema.chatImages.id, opts.image));
      if (!img || img.ownerId !== userId || img.attached) throw new ChatError('IMAGE_INVALID');
    }
    const perMinute = Number(this.s['chat.messagesPerMinute']);
    const key = `chat:${userId}`;
    if (this.limiter.count(key, 60_000) >= perMinute) throw new ChatError('RATE_LIMITED', { perMinute });
    const mute = await this.activeMute(userId, channelId);
    if (mute) throw new ChatError('MUTED', { until: mute.until.toISOString(), reason: mute.reason });
    if (opts.replyTo) {
      const [target] = await this.deps.db.select({ id: schema.chatMessages.id }).from(schema.chatMessages).where(and(eq(schema.chatMessages.id, opts.replyTo), eq(schema.chatMessages.channelId, channelId)));
      if (!target) throw new ChatError('NOT_FOUND');
    }
    this.limiter.record(key, 60_000);
    const text = this.filterWords(body);
    const mentions = await this.findMentions(text, userId, ch);
    const [row] = await this.deps.db.insert(schema.chatMessages).values({ channelId, userId, body: text, replyTo: opts.replyTo ?? null, mentions, image: opts.image ?? null, createdAt: this.now() }).returning();
    if (opts.image) await this.deps.db.update(schema.chatImages).set({ attached: true }).where(eq(schema.chatImages.id, opts.image));
    const [dto] = await this.toDto([row!]);
    // Odesílatel má svou zprávu přečtenou.
    await this.markRead(userId, channelId, row!.id).catch(() => undefined);
    this.events.message?.({ id: ch.id, key: ch.key, kind: ch.kind }, dto!);
    for (const m of mentions) this.events.mention?.(m, dto!);
    return dto!;
  }

  private async findMentions(text: string, authorId: string, ch: { id: string; kind: string; key: string }): Promise<string[]> {
    const names = [...new Set([...text.matchAll(NICK)].map((m) => m[1]!.toLowerCase()))].slice(0, 10);
    if (!names.length) return [];
    const users = await this.deps.db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.nicknameLower, names));
    const ids: string[] = [];
    for (const u of users) {
      if (u.id === authorId) continue;
      if ((await this.access(u.id, ch)).read) ids.push(u.id);
    }
    return ids;
  }

  /** Systémová zpráva (např. „Petr dokoupil rebuy“, změna nastavení). */
  async system(channelId: string, body: string): Promise<MessageDto> {
    const ch = await this.channel(channelId);
    const [row] = await this.deps.db.insert(schema.chatMessages).values({ channelId, userId: null, body, system: true, createdAt: this.now() }).returning();
    const [dto] = await this.toDto([row!]);
    this.events.message?.({ id: ch.id, key: ch.key, kind: ch.kind }, dto!);
    return dto!;
  }

  async history(userId: string, channelId: string, opts: { before?: number; limit?: number } = {}): Promise<MessageDto[]> {
    await this.readable(userId, channelId);
    const limit = Math.min(opts.limit ?? 50, 200);
    const ignored = await this.ignoredBy(userId);
    const rows = await this.deps.db
      .select()
      .from(schema.chatMessages)
      .where(and(eq(schema.chatMessages.channelId, channelId), opts.before ? lt(schema.chatMessages.id, opts.before) : undefined))
      .orderBy(desc(schema.chatMessages.id))
      .limit(limit);
    const visible = rows.filter((r) => !r.userId || !ignored.has(r.userId));
    return (await this.toDto(visible)).reverse();
  }

  async search(userId: string, q: string, channelId?: string): Promise<MessageDto[]> {
    const term = q.trim();
    if (term.length < 2) throw new ChatError('INVALID');
    const channels = (await this.listChannels(userId)).map((c) => c.id).filter((id) => !channelId || id === channelId);
    if (!channels.length) return [];
    const ignored = await this.ignoredBy(userId);
    const rows = await this.deps.db
      .select()
      .from(schema.chatMessages)
      .where(and(inArray(schema.chatMessages.channelId, channels), isNull(schema.chatMessages.deletedAt), eq(schema.chatMessages.system, false), ilike(schema.chatMessages.body, `%${term.replace(/[\\%_]/g, '\\$&')}%`)))
      .orderBy(desc(schema.chatMessages.id))
      .limit(50);
    return this.toDto(rows.filter((r) => !r.userId || !ignored.has(r.userId)));
  }

  private async message(id: number) {
    const [m] = await this.deps.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, id));
    if (!m) throw new ChatError('NOT_FOUND');
    return m;
  }

  async edit(userId: string, messageId: number, rawBody: string): Promise<MessageDto> {
    const m = await this.message(messageId);
    if (m.userId !== userId || m.system || m.deletedAt) throw new ChatError('FORBIDDEN');
    const { write } = await this.readable(userId, m.channelId);
    if (!write) throw new ChatError('FORBIDDEN');
    const window = Number(this.s['chat.editWindowMinutes']);
    if (window > 0 && this.now().getTime() - m.createdAt.getTime() > window * 60_000) throw new ChatError('EDIT_EXPIRED', { minutes: window });
    const body = this.filterWords((rawBody ?? '').trim());
    if (!body) throw new ChatError('EMPTY');
    if (body.length > Number(this.s['chat.maxLength'])) throw new ChatError('TOO_LONG', { max: Number(this.s['chat.maxLength']) });
    const [row] = await this.deps.db.update(schema.chatMessages).set({ body, editedAt: this.now() }).where(eq(schema.chatMessages.id, messageId)).returning();
    const [dto] = await this.toDto([row!]);
    this.events.edited?.(m.channelId, dto!);
    return dto!;
  }

  /** Smazat smí autor, nebo moderátor (v rámci rozsahu kanálu). */
  async delete(userId: string, messageId: number): Promise<void> {
    const m = await this.message(messageId);
    const ch = await this.channel(m.channelId);
    const own = m.userId === userId;
    const mod = this.deps.perms.can(userId, 'chat.mazat_zpravy', { scopeType: 'channel', scopeId: ch.key }).allowed;
    if (!own && !mod) throw new ChatError('FORBIDDEN');
    if (!(await this.access(userId, ch)).read && !mod) throw new ChatError('FORBIDDEN');
    if (m.deletedAt) return;
    await this.deps.db.update(schema.chatMessages).set({ deletedAt: this.now(), deletedBy: userId }).where(eq(schema.chatMessages.id, messageId));
    if (!own) await this.deps.audit.log({ actorId: userId, action: 'chat.zprava_smazana', targetType: 'chat_message', targetId: String(messageId), before: { author: m.userId, body: m.body } });
    this.events.deleted?.(m.channelId, messageId);
  }

  async react(userId: string, messageId: number, emoji: string): Promise<Record<string, string[]>> {
    const m = await this.message(messageId);
    const { write } = await this.readable(userId, m.channelId);
    if (!write) throw new ChatError('FORBIDDEN');
    const allowed = String(this.s['chat.emojiList']).split(',').map((e) => e.trim()).filter(Boolean);
    if (!allowed.includes(emoji)) throw new ChatError('BAD_EMOJI');
    const existing = await this.deps.db.select().from(schema.chatReactions).where(and(eq(schema.chatReactions.messageId, messageId), eq(schema.chatReactions.userId, userId), eq(schema.chatReactions.emoji, emoji)));
    if (existing.length) await this.deps.db.delete(schema.chatReactions).where(and(eq(schema.chatReactions.messageId, messageId), eq(schema.chatReactions.userId, userId), eq(schema.chatReactions.emoji, emoji)));
    else await this.deps.db.insert(schema.chatReactions).values({ messageId, userId, emoji });
    const [dto] = await this.toDto([await this.message(messageId)]);
    this.events.reaction?.(m.channelId, messageId, dto!.reactions);
    return dto!.reactions;
  }

  async pin(userId: string, messageId: number, on: boolean): Promise<MessageDto> {
    const m = await this.message(messageId);
    const ch = await this.channel(m.channelId);
    if (!this.deps.perms.can(userId, 'chat.pripinat', { scopeType: 'channel', scopeId: ch.key }).allowed) throw new ChatError('FORBIDDEN');
    const [row] = await this.deps.db.update(schema.chatMessages).set(on ? { pinnedAt: this.now(), pinnedBy: userId } : { pinnedAt: null, pinnedBy: null }).where(eq(schema.chatMessages.id, messageId)).returning();
    const [dto] = await this.toDto([row!]);
    this.events.pinned?.(m.channelId, dto!);
    return dto!;
  }

  async pinned(userId: string, channelId: string): Promise<MessageDto[]> {
    await this.readable(userId, channelId);
    const rows = await this.deps.db.select().from(schema.chatMessages).where(and(eq(schema.chatMessages.channelId, channelId), sql`${schema.chatMessages.pinnedAt} is not null`, isNull(schema.chatMessages.deletedAt))).orderBy(asc(schema.chatMessages.pinnedAt));
    return this.toDto(rows);
  }

  // ---------- čtení a nepřečtené ----------

  /** Ztlumí / zapne upozornění (push a e-mailový souhrn) z kanálu; zmínky přes @ chodí dál. */
  async setNotifyMuted(userId: string, channelId: string, on: boolean): Promise<void> {
    await this.readable(userId, channelId);
    await this.deps.db
      .insert(schema.chatMembers)
      .values({ channelId, userId, notifyMuted: on })
      .onConflictDoUpdate({ target: [schema.chatMembers.channelId, schema.chatMembers.userId], set: { notifyMuted: on } });
  }

  /** Komu poslat upozornění na novou zprávu v soukromém / skupinovém kanálu (členové bez autora a bez ztlumených). */
  async notifyTargets(channelId: string, authorId: string | null): Promise<string[]> {
    const ch = await this.channel(channelId);
    if (ch.kind !== 'dm' && ch.kind !== 'group') return [];
    const rows = await this.deps.db.select().from(schema.chatMembers).where(eq(schema.chatMembers.channelId, channelId));
    const out: string[] = [];
    for (const m of rows) {
      if (m.userId === authorId || m.notifyMuted) continue;
      if (authorId && (await this.ignoredBy(m.userId)).has(authorId)) continue;
      out.push(m.userId);
    }
    return out;
  }

  async channelName(channelId: string): Promise<{ name: string; kind: string }> {
    const ch = await this.channel(channelId);
    return { name: ch.name, kind: ch.kind };
  }

  /** Nepřečtené zprávy po zadaném čase po kanálech (bez kanálů stolů) pro e-mailový souhrn. */
  async unreadSince(userId: string, since: Date): Promise<{ channelId: string; name: string; kind: string; count: number }[]> {
    const list = await this.listChannels(userId);
    const out: { channelId: string; name: string; kind: string; count: number }[] = [];
    for (const c of list) {
      if (c.kind === 'table' || c.unread === 0 || c.notifyMuted) continue;
      const [mem] = await this.deps.db.select({ r: schema.chatMembers.lastReadId }).from(schema.chatMembers).where(and(eq(schema.chatMembers.channelId, c.id), eq(schema.chatMembers.userId, userId)));
      const [n] = await this.deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.chatMessages)
        .where(and(eq(schema.chatMessages.channelId, c.id), gt(schema.chatMessages.id, mem?.r ?? 0), gt(schema.chatMessages.createdAt, since), isNull(schema.chatMessages.deletedAt), eq(schema.chatMessages.system, false), or(isNull(schema.chatMessages.userId), sql`${schema.chatMessages.userId} <> ${userId}`)));
      if ((n?.n ?? 0) > 0) out.push({ channelId: c.id, name: c.name, kind: c.kind, count: n!.n });
    }
    return out;
  }

  async markRead(userId: string, channelId: string, upTo: number): Promise<void> {
    await this.deps.db
      .insert(schema.chatMembers)
      .values({ channelId, userId, lastReadId: upTo })
      .onConflictDoUpdate({ target: [schema.chatMembers.channelId, schema.chatMembers.userId], set: { lastReadId: sql`greatest(${schema.chatMembers.lastReadId}, ${upTo})` } });
  }

  // ---------- moderace a ignorování ----------

  /** Ztlumení hráče v kanálu (nebo všude). Délka je omezena limitem oprávnění. */
  async mute(actorId: string, targetId: string, hours: number, reason: string, channelId?: string): Promise<void> {
    const scope = channelId ? { scopeType: 'channel' as const, scopeId: (await this.channel(channelId)).key } : undefined;
    const d = this.deps.perms.can(actorId, 'chat.ztlumit', scope);
    if (!d.allowed) throw new ChatError('FORBIDDEN');
    if (!Number.isFinite(hours) || hours <= 0) throw new ChatError('INVALID');
    if (d.limits?.maxDurationHours !== undefined && hours > d.limits.maxDurationHours) throw new ChatError('FORBIDDEN', { maxHours: d.limits.maxDurationHours });
    if (actorId === targetId) throw new ChatError('INVALID');
    const until = new Date(this.now().getTime() + hours * 3600_000);
    await this.deps.db.insert(schema.chatMutes).values({ userId: targetId, channelId: channelId ?? null, until, reason, createdBy: actorId, createdAt: this.now() });
    await this.deps.audit.log({ actorId, action: 'chat.ztlumit', targetType: 'user', targetId, after: { hours, channelId }, reason });
  }

  async unmute(actorId: string, targetId: string): Promise<void> {
    if (!this.deps.perms.can(actorId, 'chat.ztlumit').allowed) throw new ChatError('FORBIDDEN');
    await this.deps.db.update(schema.chatMutes).set({ liftedAt: this.now() }).where(and(eq(schema.chatMutes.userId, targetId), isNull(schema.chatMutes.liftedAt)));
    await this.deps.audit.log({ actorId, action: 'chat.zrusit_ztlumeni', targetType: 'user', targetId });
  }

  async setIgnore(userId: string, otherId: string, on: boolean): Promise<void> {
    if (userId === otherId) throw new ChatError('INVALID');
    if (on) await this.deps.db.insert(schema.chatIgnores).values({ userId, ignoredId: otherId }).onConflictDoNothing();
    else await this.deps.db.delete(schema.chatIgnores).where(and(eq(schema.chatIgnores.userId, userId), eq(schema.chatIgnores.ignoredId, otherId)));
  }

  async ignoredBy(userId: string): Promise<Set<string>> {
    const rows = await this.deps.db.select({ id: schema.chatIgnores.ignoredId }).from(schema.chatIgnores).where(eq(schema.chatIgnores.userId, userId));
    return new Set(rows.map((r) => r.id));
  }

  /** Kdo smí zprávu dostat (člen kanálu s právem číst, který odesílatele neignoruje). */
  async recipients(channelId: string, authorId: string | null, candidateUserIds: string[]): Promise<string[]> {
    const ch = await this.channel(channelId);
    const out: string[] = [];
    for (const u of candidateUserIds) {
      if (authorId && (await this.ignoredBy(u)).has(authorId)) continue;
      if ((await this.access(u, ch)).read) out.push(u);
    }
    return out;
  }

  /** Úklid podle nastavené doby uchování. */
  async purgeOld(): Promise<number> {
    const days = Number(this.s['chat.historyDays']);
    if (!days) return 0;
    const cutoff = new Date(this.now().getTime() - days * 86400_000);
    const res = await this.deps.db.delete(schema.chatMessages).where(lt(schema.chatMessages.createdAt, cutoff)).returning({ id: schema.chatMessages.id });
    return res.length;
  }
}
