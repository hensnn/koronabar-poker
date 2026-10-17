import { and, asc, eq, isNull } from 'drizzle-orm';
import { HAND_REACTIONS, type PermissionChecker, type SettingValues } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';
import type { StatsService } from './stats.js';

export type HandErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'DISABLED' | 'LIMIT';

export class HandError extends Error {
  constructor(
    public code: HandErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

interface Deps {
  db: Db;
  perms: PermissionChecker;
  audit: AuditService;
  settings: () => SettingValues;
  now: () => number;
  stats: () => StatsService;
  /** Pošle zprávu do chatu (kanál nebo hlavní kanál). */
  postChat: (userId: string, channelId: string | null, body: string) => Promise<void>;
  /** Anketa „Jak bys hrál?“ k handě; vrací id ankety. */
  createPoll: (userId: string, title: string, options: string[]) => Promise<string>;
  nickOf: (userId: string) => Promise<string>;
  notify?: (userId: string, kind: string, params: Record<string, unknown>, link: string | null) => Promise<void>;
  onChanged?: (sharedId: string) => void;
}

type Meta = { ip?: string | null };

/**
 * Sdílení hand: handa se jedním kliknutím pošle do chatu jako karta s přehrávačem. Cizí karty se nikdy neukážou, jen ty,
 * které byly odkryté při showdownu nebo je hráč sám dobrovolně odkryl. Pod handou je vlákno komentářů a reakce.
 */
export class SharedHandService {
  constructor(private deps: Deps) {}

  private s() {
    return this.deps.settings();
  }

  private enabled(): void {
    if (!this.s()['hands.shareEnabled']) throw new HandError('DISABLED');
  }

  private async load(id: string) {
    const [row] = await this.deps.db.select().from(schema.sharedHands).where(eq(schema.sharedHands.id, id));
    if (!row) throw new HandError('NOT_FOUND');
    return row;
  }

  /** Sdílí handu do chatu. Kdo v handě nehrál, musí mít oprávnění ke statistikám. */
  async share(userId: string, handId: string, opts: { reveal?: boolean; channelId?: string | null; poll?: boolean } = {}, meta: Meta = {}): Promise<{ id: string; pollError?: string }> {
    this.enabled();
    const [h] = await this.deps.db.select({ id: schema.hands.id, number: schema.hands.handNumber }).from(schema.hands).where(eq(schema.hands.id, handId));
    if (!h) throw new HandError('NOT_FOUND');
    const players = await this.deps.db.select({ userId: schema.handPlayers.userId }).from(schema.handPlayers).where(eq(schema.handPlayers.handId, handId));
    const played = players.some((p) => p.userId === userId);
    if (!played && !this.deps.perms.can(userId, 'statistiky.sezony').allowed) throw new HandError('FORBIDDEN');
    const [existing] = await this.deps.db.select().from(schema.sharedHands).where(and(eq(schema.sharedHands.handId, handId), eq(schema.sharedHands.sharedBy, userId)));
    let id = existing?.id;
    const reveal = !!opts.reveal && played;
    if (!id) {
      const [row] = await this.deps.db.insert(schema.sharedHands).values({ handId, sharedBy: userId, revealed: reveal ? [userId] : [] }).returning({ id: schema.sharedHands.id });
      id = row!.id;
    } else if (reveal && !existing!.revealed.includes(userId)) {
      await this.deps.db.update(schema.sharedHands).set({ revealed: [...existing!.revealed, userId] }).where(eq(schema.sharedHands.id, id));
    }
    let pollError: string | undefined;
    if (opts.poll && !existing?.pollId) {
      try {
        const pollId = await this.deps.createPoll(userId, `{{ruka:${id}}}`, ['fold', 'call', 'raise']);
        await this.deps.db.update(schema.sharedHands).set({ pollId }).where(eq(schema.sharedHands.id, id));
      } catch (e) {
        pollError = e instanceof Error ? e.message : 'POLL';
      }
    }
    await this.deps.postChat(userId, opts.channelId ?? null, `{{ruka:${id}}}`);
    await this.deps.audit.log({ actorId: userId, action: 'handa.sdilet', targetType: 'shared_hand', targetId: id, after: { handId, reveal }, ...meta });
    return { id, ...(pollError ? { pollError } : {}) };
  }

  /** Sdílí handu jménem systému (handa večera): bez autora a bez odkrytých karet kromě showdownu. */
  async shareSystem(handId: string): Promise<string> {
    const [existing] = await this.deps.db.select().from(schema.sharedHands).where(and(eq(schema.sharedHands.handId, handId), isNull(schema.sharedHands.sharedBy)));
    if (existing) return existing.id;
    const [row] = await this.deps.db.insert(schema.sharedHands).values({ handId, sharedBy: null, revealed: [] }).returning({ id: schema.sharedHands.id });
    return row!.id;
  }

  /** Karta handy pro každého přihlášeného; karty jen ukázané. */
  async view(viewerId: string, sharedId: string) {
    this.enabled();
    if (!this.deps.perms.can(viewerId, 'stul.zobrazit').allowed) throw new HandError('FORBIDDEN');
    const sh = await this.load(sharedId);
    const detail = await this.deps.stats().handDetailShared(viewerId, sh.handId, sh.revealed);
    const comments = await this.deps.db
      .select({ id: schema.handComments.id, userId: schema.handComments.userId, body: schema.handComments.body, createdAt: schema.handComments.createdAt, nickname: schema.users.nickname })
      .from(schema.handComments)
      .leftJoin(schema.users, eq(schema.users.id, schema.handComments.userId))
      .where(and(eq(schema.handComments.sharedId, sharedId), isNull(schema.handComments.deletedAt)))
      .orderBy(asc(schema.handComments.createdAt));
    const reactions = await this.deps.db.select().from(schema.handReactions).where(eq(schema.handReactions.sharedId, sharedId));
    const counts: Record<string, number> = {};
    for (const r of reactions) counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;
    return {
      shared: { id: sh.id, sharedBy: sh.sharedBy ? { userId: sh.sharedBy, nickname: await this.deps.nickOf(sh.sharedBy) } : null, createdAt: sh.createdAt.getTime(), pollId: sh.pollId, revealed: sh.revealed },
      hand: detail,
      comments: comments.map((c) => ({ id: c.id, userId: c.userId, nickname: c.nickname ?? '?', body: c.body, at: c.createdAt.getTime(), mine: c.userId === viewerId })),
      reactions: { allowed: HAND_REACTIONS, counts, mine: reactions.filter((r) => r.userId === viewerId).map((r) => r.emoji) },
      canReveal: !!sh.sharedBy && sh.sharedBy === viewerId,
      canModerate: this.deps.perms.can(viewerId, 'chat.mazat_zpravy').allowed,
    };
  }

  /** Autor sdílení si dobrovolně odkryje, nebo zase skryje své karty. */
  async setReveal(userId: string, sharedId: string, reveal: boolean, meta: Meta = {}): Promise<void> {
    const sh = await this.load(sharedId);
    if (sh.sharedBy !== userId) throw new HandError('FORBIDDEN');
    const [mine] = await this.deps.db.select({ u: schema.handPlayers.userId }).from(schema.handPlayers).where(and(eq(schema.handPlayers.handId, sh.handId), eq(schema.handPlayers.userId, userId)));
    if (!mine) throw new HandError('FORBIDDEN');
    const next = reveal ? [...new Set([...sh.revealed, userId])] : sh.revealed.filter((x) => x !== userId);
    await this.deps.db.update(schema.sharedHands).set({ revealed: next }).where(eq(schema.sharedHands.id, sharedId));
    await this.deps.audit.log({ actorId: userId, action: 'handa.odkryt_karty', targetType: 'shared_hand', targetId: sharedId, after: { reveal }, ...meta });
    this.deps.onChanged?.(sharedId);
  }

  async comment(userId: string, sharedId: string, body: unknown, meta: Meta = {}): Promise<{ id: string }> {
    this.enabled();
    if (!this.deps.perms.can(userId, 'chat.psat').allowed) throw new HandError('FORBIDDEN');
    const sh = await this.load(sharedId);
    const text = typeof body === 'string' ? body.trim() : '';
    if (text.length < 1 || text.length > 500) throw new HandError('INVALID', { field: 'body', max: 500 });
    const count = (await this.deps.db.select({ id: schema.handComments.id }).from(schema.handComments).where(and(eq(schema.handComments.sharedId, sharedId), isNull(schema.handComments.deletedAt)))).length;
    if (count >= Number(this.s()['hands.commentMax'])) throw new HandError('LIMIT', { max: Number(this.s()['hands.commentMax']) });
    const [row] = await this.deps.db.insert(schema.handComments).values({ sharedId, userId, body: text, createdAt: new Date(this.deps.now()) }).returning({ id: schema.handComments.id });
    await this.deps.audit.log({ actorId: userId, action: 'handa.komentar', targetType: 'shared_hand', targetId: sharedId, ...meta });
    if (sh.sharedBy && sh.sharedBy !== userId) void this.deps.notify?.(sh.sharedBy, 'handComment', { nick: await this.deps.nickOf(userId) }, null);
    this.deps.onChanged?.(sharedId);
    return { id: row!.id };
  }

  async deleteComment(userId: string, commentId: string, meta: Meta = {}): Promise<void> {
    const [c] = await this.deps.db.select().from(schema.handComments).where(eq(schema.handComments.id, commentId));
    if (!c || c.deletedAt) throw new HandError('NOT_FOUND');
    if (c.userId !== userId && !this.deps.perms.can(userId, 'chat.mazat_zpravy').allowed) throw new HandError('FORBIDDEN');
    await this.deps.db.update(schema.handComments).set({ deletedAt: new Date(this.deps.now()) }).where(eq(schema.handComments.id, commentId));
    await this.deps.audit.log({ actorId: userId, action: 'handa.smazat_komentar', targetType: 'shared_hand', targetId: c.sharedId, ...meta });
    this.deps.onChanged?.(c.sharedId);
  }

  /** Přepne reakci (přidá, nebo odebere). */
  async react(userId: string, sharedId: string, emoji: string): Promise<void> {
    this.enabled();
    if (!(HAND_REACTIONS as readonly string[]).includes(emoji)) throw new HandError('INVALID', { field: 'emoji' });
    await this.load(sharedId);
    const [cur] = await this.deps.db.select().from(schema.handReactions).where(and(eq(schema.handReactions.sharedId, sharedId), eq(schema.handReactions.userId, userId), eq(schema.handReactions.emoji, emoji)));
    if (cur) await this.deps.db.delete(schema.handReactions).where(and(eq(schema.handReactions.sharedId, sharedId), eq(schema.handReactions.userId, userId), eq(schema.handReactions.emoji, emoji)));
    else await this.deps.db.insert(schema.handReactions).values({ sharedId, userId, emoji });
    this.deps.onChanged?.(sharedId);
  }
}
