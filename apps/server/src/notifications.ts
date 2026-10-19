import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { formatLocal, t, type SettingValues } from '@kb/shared';
import type { Server } from 'socket.io';
import { schema, type Db } from './db/index.js';
import type { EmailService } from './email/service.js';
import type { PushService } from './push.js';
import type { SettingsStore } from './settings-store.js';
import type { TournamentNotice } from './tournaments.js';

export interface NotificationDto {
  id: number;
  kind: string;
  params: Record<string, unknown>;
  link: string | null;
  createdAt: number;
  read: boolean;
  /** Hotový český text (server ho skládá z klíče a parametrů). */
  text: string;
}

/**
 * Upozornění v aplikaci (uložená v DB, živě přes Socket.IO) a volitelně e-mailem.
 * E-mail dostane jen uživatel s ověřenou adresou a zapnutou osobní předvolbou.
 */
export class NotificationService {
  private io: Server | null = null;

  constructor(
    private deps: {
      db: Db;
      email: EmailService;
      settings: SettingsStore;
      publicUrl: () => string;
      push?: PushService;
    },
  ) {}

  attach(io: Server): void {
    this.io = io;
  }

  private textFor(kind: string, params: Record<string, unknown>): string {
    return t(`notice.${kind}.text`, params as never);
  }

  private dto(r: typeof schema.notifications.$inferSelect): NotificationDto {
    return { id: r.id, kind: r.kind, params: r.params, link: r.link, createdAt: r.createdAt.getTime(), read: !!r.readAt, text: this.textFor(r.kind, r.params) };
  }

  /** Jednoduché upozornění jednomu uživateli (v aplikaci, bez e-mailu), např. postup na další level. */
  async simple(userId: string, kind: string, params: Record<string, unknown>, link: string | null): Promise<void> {
    const [r] = await this.deps.db.insert(schema.notifications).values({ userId, kind, params, link }).returning();
    if (r) this.io?.to(`user:${r.userId}`).emit('notification', this.dto(r));
  }

  /** Upozornění na turnaj: konkrétním hráčům, nebo všem aktivním uživatelům. */
  async tournament(to: string[] | 'all', n: TournamentNotice): Promise<void> {
    const users = to === 'all' ? (await this.deps.db.select({ id: schema.users.id }).from(schema.users).where(ne(schema.users.status, 'blocked'))).map((u) => u.id) : to;
    if (users.length === 0) return;
    const params = { name: n.name, time: formatLocal(n.startAt), minutes: n.minutes ?? 0 };
    const link = `/turnaj/${n.tournamentId}`;
    const rows = await this.deps.db
      .insert(schema.notifications)
      .values(users.map((userId) => ({ userId, kind: n.kind, params, link })))
      .returning();
    for (const r of rows) this.io?.to(`user:${r.userId}`).emit('notification', this.dto(r));
    void this.deps.push?.send(users, { title: t(`notice.${n.kind}.event`), body: this.textFor(n.kind, params), url: link, tag: `turnaj-${n.tournamentId}-${n.kind}` }).catch(() => undefined);
    // E-mail jen k upozorněním, která dávají smysl mimo aplikaci (ne k hromadnému otevření registrace).
    if (n.kind === 'registrationOpened') return;
    for (const userId of users) await this.mail(userId, n.kind, params, link);
  }

  private async mail(userId: string, kind: string, params: Record<string, unknown>, link: string): Promise<void> {
    try {
      const [u] = await this.deps.db.select({ nickname: schema.users.nickname, email: schema.users.email, verified: schema.users.emailVerifiedAt }).from(schema.users).where(eq(schema.users.id, userId));
      if (!u?.email || !u.verified) return;
      const prefs: SettingValues = this.deps.settings.resolve([{ scope: 'user', scopeId: userId, values: this.deps.settings.layer('user', userId) }]);
      const optedOut = prefs['email.notifyTournament'] === false;
      await this.deps.email.enqueue('turnaj_upozorneni', u.email, {
        prezdivka: u.nickname,
        turnaj: String(params.name),
        udalost: t(`notice.${kind}.event`),
        text: this.textFor(kind, params),
        odkaz: this.deps.publicUrl() + link,
      }, { userOptedOut: optedOut });
    } catch (e) {
      console.error('Odeslání upozornění e-mailem selhalo:', e instanceof Error ? e.message : e);
    }
  }

  async list(userId: string, limit = 50): Promise<{ items: NotificationDto[]; unread: number }> {
    const rows = await this.deps.db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId)).orderBy(desc(schema.notifications.id)).limit(Math.min(limit, 200));
    const unreadRows = await this.deps.db.select({ id: schema.notifications.id }).from(schema.notifications).where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
    return { items: rows.map((r) => this.dto(r)), unread: unreadRows.length };
  }

  async markRead(userId: string): Promise<void> {
    await this.deps.db.update(schema.notifications).set({ readAt: new Date() }).where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
  }
}
