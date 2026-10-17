import { eq } from 'drizzle-orm';
import { t, type SettingValues } from '@kb/shared';
import { schema, type Db } from '../db/index.js';
import type { EmailService } from '../email/service.js';
import type { PushService } from '../push.js';
import type { SettingsStore } from '../settings-store.js';
import type { ChatService, MessageDto } from './service.js';

const TOKEN = /\{\{(turnaj|stul|anketa|ruka):[\w-]{1,80}\}\}/g;

/** Osobní nastavení uživatele (výchozí hodnoty doplní schéma). */
export function userPrefs(settings: SettingsStore, userId: string): SettingValues {
  return settings.resolve([{ scope: 'user', scopeId: userId, values: settings.layer('user', userId) }]);
}

/**
 * Push upozornění z chatu: na zmínky (@) a na soukromé / skupinové zprávy. Posílá se jen tomu, kdo není
 * právě připojený (v aplikaci ho upozorní sama aplikace), respektuje osobní předvolby a ztlumené kanály.
 */
export class ChatNotifier {
  constructor(
    private deps: {
      db: Db;
      chat: ChatService;
      push: PushService;
      settings: SettingsStore;
      isOnline: (userId: string) => boolean;
    },
  ) {}

  attach(): void {
    this.deps.chat.on({
      message: (ch, m) => void this.onMessage(ch, m).catch(() => undefined),
      mention: (userId, m) => void this.onMention(userId, m).catch(() => undefined),
    });
  }

  private preview(m: MessageDto): string {
    const text = m.body.replace(TOKEN, '').replace(/\s+/g, ' ').trim();
    const body = text || (m.image ? t('push.chatImage') : '');
    return body.length > 140 ? body.slice(0, 137) + '…' : body;
  }

  private async onMessage(ch: { id: string; kind: string }, m: MessageDto): Promise<void> {
    if (m.system || !m.userId || (ch.kind !== 'dm' && ch.kind !== 'group')) return;
    const targets = (await this.deps.chat.notifyTargets(ch.id, m.userId)).filter((u) => !m.mentions.includes(u) && !this.deps.isOnline(u) && userPrefs(this.deps.settings, u)['push.chatDm'] !== false);
    if (targets.length === 0) return;
    const nick = m.nickname ?? '';
    await this.deps.push.send(targets, { title: ch.kind === 'dm' ? t('push.chatTitleDm', { nick }) : `${(await this.deps.chat.channelName(ch.id)).name}: ${nick}`, body: this.preview(m), url: '/chat', tag: `chat-${ch.id}` });
  }

  private async onMention(userId: string, m: MessageDto): Promise<void> {
    if (m.system || this.deps.isOnline(userId) || userPrefs(this.deps.settings, userId)['push.chatMentions'] === false) return;
    await this.deps.push.send([userId], { title: t('push.chatTitleMention', { nick: m.nickname ?? '' }), body: this.preview(m), url: '/chat', tag: `chat-mention-${m.channelId}` });
  }
}

/** Souhrn nepřečtených zpráv e-mailem (denně nebo týdně podle osobního nastavení). */
export class ChatDigest {
  constructor(
    private deps: {
      db: Db;
      chat: ChatService;
      email: EmailService;
      settings: SettingsStore;
      publicUrl: () => string;
      now: () => number;
    },
  ) {}

  private async lastSent(userId: string): Promise<number | null> {
    const [r] = await this.deps.db.select().from(schema.systemMeta).where(eq(schema.systemMeta.key, `chatDigest:${userId}`));
    return r ? Number(r.value) : null;
  }

  private async markSent(userId: string, at: number): Promise<void> {
    await this.deps.db
      .insert(schema.systemMeta)
      .values({ key: `chatDigest:${userId}`, value: at })
      .onConflictDoUpdate({ target: schema.systemMeta.key, set: { value: at } });
  }

  /** Projde uživatele a pošle souhrn těm, komu je podle jejich nastavení a nepřečtených zpráv čas. Vrací počet odeslaných. */
  async run(): Promise<number> {
    if (!this.deps.settings.resolve()['chat.digestEnabled'] || !this.deps.settings.resolve()['chat.enabled']) return 0;
    const now = this.deps.now();
    const users = await this.deps.db.select({ id: schema.users.id, nickname: schema.users.nickname, email: schema.users.email, verified: schema.users.emailVerifiedAt, status: schema.users.status }).from(schema.users);
    let sent = 0;
    for (const u of users) {
      if (!u.email || !u.verified || u.status === 'blocked') continue;
      const mode = String(userPrefs(this.deps.settings, u.id)['chat.digest']);
      if (mode !== 'daily' && mode !== 'weekly') continue;
      const period = (mode === 'daily' ? 1 : 7) * 86_400_000;
      const last = await this.lastSent(u.id);
      if (last !== null && now - last < period) continue;
      const unread = await this.deps.chat.unreadSince(u.id, new Date(last ?? now - period));
      if (unread.length === 0) continue;
      const lines = unread.map((c) => `${c.kind === 'dm' ? '@' : '#'}${c.name}: ${c.count}`).join('\n');
      await this.deps.email.enqueue('chat_souhrn', u.email, { prezdivka: u.nickname, souhrn: lines, odkaz: this.deps.publicUrl() + '/chat' });
      await this.markSent(u.id, now);
      sent++;
    }
    return sent;
  }
}
