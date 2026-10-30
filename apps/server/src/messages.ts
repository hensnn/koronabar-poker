import { desc, eq, inArray, ne } from 'drizzle-orm';
import type { PermissionChecker } from '@kb/shared';
import type { AuditService, AuditSource } from './auth/audit.js';
import { schema, type Db } from './db/index.js';
import { fillTemplate, type EmailService } from './email/service.js';
import type { NotificationService } from './notifications.js';
import type { SettingsStore } from './settings-store.js';

export class MessageError extends Error {
  constructor(public readonly code: 'FORBIDDEN' | 'INVALID' | 'EMPTY' | 'TOO_MANY', public readonly params: Record<string, unknown> = {}) {
    super(code);
  }
}

export type MessageChannel = 'app' | 'push' | 'email';
export const MESSAGE_CHANNELS: readonly MessageChannel[] = ['app', 'push', 'email'];

/** Okruh příjemců: sjednocení vybraných skupin, od kterého se odečtou vyloučené role. Zablokované účty se nikdy nezahrnují. */
export interface AudienceFilter {
  everyone?: boolean;
  roleKeys?: string[];
  /** Hráči přihlášení do turnaje. */
  tournamentId?: string;
  userIds?: string[];
  excludeRoleKeys?: string[];
  excludeSelf?: boolean;
}

export interface MessageInput {
  title: string;
  body: string;
  link?: string | null;
  channels: MessageChannel[];
  audience: AudienceFilter;
}

interface Recipient {
  id: string;
  nickname: string;
  email: string | null;
  verified: boolean;
  roleKeys: string[];
}

type Meta = { ip?: string | null; source?: AuditSource; reason?: string | null };

const MAX_RECIPIENTS = 500;

interface Deps {
  db: Db;
  perms: PermissionChecker;
  audit: AuditService;
  email: EmailService;
  notifications: () => NotificationService;
  settings: SettingsStore;
  publicUrl: () => string;
  /** Hráči přihlášení do turnaje. */
  registeredUsers: (tournamentId: string) => string[];
}

/** Zprávy členům: správce vybere příjemce (všichni, role, turnaj, jmenovitě) a kanály (aplikace, push, e-mail). */
export class MessageService {
  constructor(private deps: Deps) {}

  private can(actorId: string): void {
    if (!this.deps.perms.can(actorId, 'zpravy.odeslat').allowed) throw new MessageError('FORBIDDEN');
  }

  /** Okruh příjemců podle filtru (bez zablokovaných). */
  async resolve(actorId: string, f: AudienceFilter): Promise<Recipient[]> {
    const db = this.deps.db;
    const rows = await db
      .select({ id: schema.users.id, nickname: schema.users.nickname, email: schema.users.email, verified: schema.users.emailVerifiedAt })
      .from(schema.users)
      .where(ne(schema.users.status, 'blocked'));
    const roleRows = await db.select({ userId: schema.roleAssignments.userId, key: schema.roles.key }).from(schema.roleAssignments).innerJoin(schema.roles, eq(schema.roles.id, schema.roleAssignments.roleId));
    const rolesOf = new Map<string, string[]>();
    for (const r of roleRows) (rolesOf.get(r.userId) ?? rolesOf.set(r.userId, []).get(r.userId)!).push(r.key);
    const wanted = new Set<string>();
    const roleKeys = (f.roleKeys ?? []).map((k) => k.toLowerCase());
    const registered = f.tournamentId ? new Set(this.deps.registeredUsers(f.tournamentId)) : new Set<string>();
    const picked = new Set(f.userIds ?? []);
    for (const u of rows) {
      const keys = rolesOf.get(u.id) ?? [];
      if (f.everyone || picked.has(u.id) || registered.has(u.id) || keys.some((k) => roleKeys.includes(k.toLowerCase()))) wanted.add(u.id);
    }
    const excluded = (f.excludeRoleKeys ?? []).map((k) => k.toLowerCase());
    return rows
      .filter((u) => wanted.has(u.id))
      .filter((u) => !(rolesOf.get(u.id) ?? []).some((k) => excluded.includes(k.toLowerCase())))
      .filter((u) => !(f.excludeSelf && u.id === actorId))
      .map((u) => ({ id: u.id, nickname: u.nickname, email: u.email, verified: !!u.verified, roleKeys: rolesOf.get(u.id) ?? [] }))
      .sort((a, b) => a.nickname.localeCompare(b.nickname, 'cs'));
  }

  private validate(input: MessageInput): void {
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title || title.length > 120 || !body || body.length > 4000) throw new MessageError('INVALID');
    if (input.channels.length === 0 || input.channels.some((c) => !MESSAGE_CHANNELS.includes(c))) throw new MessageError('INVALID');
    if (input.link && !(input.link.startsWith('/') || /^https?:\/\//.test(input.link))) throw new MessageError('INVALID');
  }

  private absolute(link: string): string {
    return link.startsWith('/') ? this.deps.publicUrl() + link : link;
  }

  /** Dosadí osobní proměnné ({prezdivka}, {odkaz}) do textu pro konkrétního příjemce. */
  private fill(text: string, nickname: string, link?: string | null): string {
    return fillTemplate(text, { prezdivka: nickname, odkaz: link ? this.absolute(link) : '' });
  }

  /** Náhled před odesláním: kolik lidí zprávu dostane a kdo, jak vypadá vzorek a kolika půjde e-mail. */
  async preview(actorId: string, input: MessageInput) {
    this.can(actorId);
    this.validate(input);
    const to = await this.resolve(actorId, input.audience);
    const emailable = to.filter((r) => r.email && r.verified);
    const first = to[0];
    return {
      count: to.length,
      emailable: emailable.length,
      noEmail: to.length - emailable.length,
      tooMany: to.length > MAX_RECIPIENTS,
      names: to.slice(0, 60).map((r) => r.nickname),
      sample: first ? { title: this.fill(input.title, first.nickname, input.link), body: this.fill(input.body, first.nickname, input.link) } : null,
    };
  }

  /** Odešle zprávu všem příjemcům v okruhu vybranými kanály a uloží ji do historie. */
  async send(actorId: string, input: MessageInput, meta: Meta = {}): Promise<{ id: string; recipients: number; result: Record<string, number> }> {
    this.can(actorId);
    this.validate(input);
    const to = await this.resolve(actorId, input.audience);
    if (to.length === 0) throw new MessageError('EMPTY');
    if (to.length > MAX_RECIPIENTS) throw new MessageError('TOO_MANY', { max: MAX_RECIPIENTS });
    const result: Record<string, number> = {};
    const notifications = this.deps.notifications();
    const link = input.link || null;
    const app = input.channels.includes('app');
    const push = input.channels.includes('push');
    if (app || push) {
      for (const r of to) await notifications.message(r.id, { title: this.fill(input.title, r.nickname, link), body: this.fill(input.body, r.nickname, link), link }, { app, push });
      result.app = app ? to.length : 0;
      if (push) result.push = to.length;
    }
    if (input.channels.includes('email')) {
      const ids: number[] = [];
      let noAddress = 0;
      for (const r of to) {
        if (!r.email || !r.verified) {
          noAddress++;
          continue;
        }
        const prefs = this.deps.settings.resolve([{ scope: 'user', scopeId: r.id, values: this.deps.settings.layer('user', r.id) }]);
        ids.push(
          await this.deps.email.enqueue(
            'zprava_clenum',
            r.email,
            { prezdivka: r.nickname, predmet: this.fill(input.title, r.nickname, link), text: this.fill(input.body, r.nickname, link), odkaz: link ? this.absolute(link) : '' },
            { userOptedOut: prefs['email.notifyMessages'] === false },
          ),
        );
      }
      const rows = ids.length ? await this.deps.db.select({ status: schema.emailQueue.status }).from(schema.emailQueue).where(inArray(schema.emailQueue.id, ids)) : [];
      result.emailQueued = rows.filter((x) => x.status !== 'skipped').length;
      result.emailSkipped = rows.filter((x) => x.status === 'skipped').length;
      result.emailNoAddress = noAddress;
    }
    const [row] = await this.deps.db
      .insert(schema.broadcastMessages)
      .values({ senderId: actorId, title: input.title.trim(), body: input.body.trim(), link, channels: input.channels, audience: input.audience as Record<string, unknown>, recipients: to.length, result })
      .returning({ id: schema.broadcastMessages.id });
    await this.deps.audit.log({ actorId, action: 'zpravy.odeslano', targetType: 'broadcast', targetId: row!.id, after: { title: input.title.trim(), channels: input.channels, recipients: to.length, result }, ...meta });
    return { id: row!.id, recipients: to.length, result };
  }

  /** Historie odeslaných zpráv (nejnovější první). */
  async history(actorId: string, limit = 50) {
    this.can(actorId);
    const rows = await this.deps.db
      .select({ r: schema.broadcastMessages, nickname: schema.users.nickname })
      .from(schema.broadcastMessages)
      .leftJoin(schema.users, eq(schema.users.id, schema.broadcastMessages.senderId))
      .orderBy(desc(schema.broadcastMessages.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map(({ r, nickname }) => ({ id: r.id, title: r.title, body: r.body, link: r.link, channels: r.channels, audience: r.audience, recipients: r.recipients, result: r.result, sender: nickname ?? '–', createdAt: r.createdAt.getTime() }));
  }
}
