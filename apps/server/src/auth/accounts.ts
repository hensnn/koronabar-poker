import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { hash, verify } from '@node-rs/argon2';
import { DEFAULT_ROLE_KEY, NEWBIE_ROLE_KEY, type SettingValues } from '@kb/shared';
import { schema, type Db } from '../db/index.js';
import type { AuditService, AuditSource } from './audit.js';
import { inviteCode, randomToken, sha256 } from './crypto.js';
import type { PermissionService } from './permissions.js';
import { AttemptLimiter } from './rate-limit.js';

export type AccountErrorCode =
  | 'INVALID_NICKNAME'
  | 'NICKNAME_TAKEN'
  | 'INVALID_EMAIL'
  | 'EMAIL_TAKEN'
  | 'WEAK_PASSWORD'
  | 'TERMS_NOT_ACCEPTED'
  | 'INVALID_INVITE'
  | 'INVALID_CREDENTIALS'
  | 'LOCKED'
  | 'RATE_LIMITED'
  | 'INVALID_TOKEN'
  | 'NOT_FOUND'
  | 'FORBIDDEN';

export class AccountError extends Error {
  constructor(
    public readonly code: AccountErrorCode,
    public readonly params?: Record<string, unknown>,
  ) {
    super(code);
  }
}

/** Co se posílá e-mailem. Implementace (fronta, SMTP, šablony) přijde s modulem e-mailu. */
export interface AccountNotifier {
  verifyEmail(to: string, vars: { nickname: string; link: string; hours: number }): void;
  resetPassword(to: string, vars: { nickname: string; link: string; hours: number }): void;
  passwordChanged(to: string, vars: { nickname: string }): void;
  emailChange(to: string, vars: { nickname: string; link: string; hours: number }): void;
  emailChangedNotice(to: string, vars: { nickname: string; newEmail: string }): void;
  invite(to: string, vars: { code: string; link: string; inviter: string }): void;
}

const NOOP_NOTIFIER: AccountNotifier = {
  verifyEmail: () => undefined,
  resetPassword: () => undefined,
  passwordChanged: () => undefined,
  emailChange: () => undefined,
  emailChangedNotice: () => undefined,
  invite: () => undefined,
};

export interface Meta {
  ip?: string | null;
  userAgent?: string | null;
  source?: AuditSource;
}

export interface SessionUser {
  id: string;
  nickname: string;
  email: string | null;
  emailVerified: boolean;
  status: string;
  blockedReason: string | null;
  blockedUntil: Date | null;
  avatar: string | null;
}

const NICKNAME_RE = /^[\p{L}\p{N}_-]{2,24}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESERVED = new Set(['admin', 'administrator', 'system', 'server', 'host', 'root', 'korona', 'koronabar']);

export interface AccountDeps {
  db: Db;
  audit: AuditService;
  perms: PermissionService;
  settings: () => SettingValues;
  notifier?: AccountNotifier;
  /** Zavolá se, když se účet stane aktivním (počáteční vklad apod.). */
  onActivated?: (userId: string) => void | Promise<void>;
  now?: () => Date;
}

export class AccountService {
  private db: Db;
  private limiter: AttemptLimiter;
  private now: () => Date;
  private notifier: AccountNotifier;
  /** Platný hash pro vyrovnání času při neexistujícím uživateli (nelze poznat, zda účet existuje). */
  private dummyHash: Promise<string>;

  constructor(private deps: AccountDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
    this.limiter = new AttemptLimiter(() => this.now().getTime());
    this.notifier = deps.notifier ?? NOOP_NOTIFIER;
    this.dummyHash = hash('dummy-password-for-timing');
  }

  private get s() {
    return this.deps.settings();
  }

  // ---------- hesla ----------

  checkPassword(password: string): void {
    const min = Number(this.s['system.passwordMinLength']);
    if (typeof password !== 'string' || password.length < min || password.length > 200) throw new AccountError('WEAK_PASSWORD', { min });
  }

  private link(path: string, token: string): string {
    return `${String(this.s['system.publicUrl']).replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;
  }

  // ---------- registrace ----------

  async createInvite(
    actorId: string,
    opts: { roleId?: string | null; maxUses?: number; hours?: number; email?: string | null; note?: string | null } = {},
    meta: Meta = {},
  ): Promise<string> {
    const d = this.deps.perms.can(actorId, 'uzivatel.pozvat');
    if (!d.allowed) throw new AccountError('FORBIDDEN');
    if (opts.roleId) {
      const role = this.deps.perms.getRole(opts.roleId);
      if (!role) throw new AccountError('NOT_FOUND');
      // Pozvaný dostane roli, kterou bych mu mohl přidělit i já.
      const power = this.deps.perms.maxPower(actorId);
      if (role.isLocked || (role.power >= power && !this.deps.perms.isMainAdmin(actorId))) throw new AccountError('FORBIDDEN');
    }
    await this.deps.perms.consumeDaily(actorId, 'uzivatel.pozvat', 1).catch(() => {
      throw new AccountError('RATE_LIMITED');
    });
    const hours = opts.hours ?? Number(this.s['system.inviteDefaultHours']);
    const code = inviteCode();
    await this.db.insert(schema.invites).values({
      code,
      createdBy: actorId,
      roleId: opts.roleId ?? null,
      maxUses: opts.maxUses ?? 1,
      email: opts.email?.toLowerCase() ?? null,
      expiresAt: new Date(this.now().getTime() + hours * 3600_000),
      note: opts.note ?? null,
    });
    await this.deps.audit.log({ actorId, action: 'pozvanka.vytvorit', targetType: 'invite', targetId: code, after: { roleId: opts.roleId, maxUses: opts.maxUses ?? 1, email: opts.email }, ip: meta.ip, source: meta.source });
    if (opts.email) {
      const [inviter] = await this.db.select({ n: schema.users.nickname }).from(schema.users).where(eq(schema.users.id, actorId));
      this.notifier.invite(opts.email, { code, link: this.link('/registrace', code).replace('token=', 'kod='), inviter: inviter?.n ?? '' });
    }
    return code;
  }

  async revokeInvite(actorId: string, code: string, meta: Meta = {}): Promise<void> {
    if (!this.deps.perms.can(actorId, 'uzivatel.pozvat').allowed) throw new AccountError('FORBIDDEN');
    await this.db.update(schema.invites).set({ revokedAt: this.now() }).where(eq(schema.invites.code, code));
    await this.deps.audit.log({ actorId, action: 'pozvanka.zrusit', targetType: 'invite', targetId: code, ip: meta.ip, source: meta.source });
  }

  async register(
    input: { inviteCode: string; nickname: string; email: string; password: string; acceptTerms: boolean },
    meta: Meta = {},
  ): Promise<{ userId: string; needsVerification: boolean }> {
    const nickname = input.nickname?.trim() ?? '';
    if (!NICKNAME_RE.test(nickname) || RESERVED.has(nickname.toLowerCase())) throw new AccountError('INVALID_NICKNAME');
    const email = input.email?.trim() ?? '';
    if (!EMAIL_RE.test(email) || email.length > 200) throw new AccountError('INVALID_EMAIL');
    this.checkPassword(input.password);
    if (!input.acceptTerms) throw new AccountError('TERMS_NOT_ACCEPTED');
    const s = this.s;
    const hourly = Number(s['system.mailRequestsPerHour']);
    const key = `register:${meta.ip ?? ''}`;
    if (this.limiter.count(key, 3600_000) >= hourly) throw new AccountError('RATE_LIMITED');
    this.limiter.record(key, 3600_000);

    const passwordHash = await hash(input.password);
    const needsVerification = !!s['system.emailVerificationRequired'];
    const now = this.now();

    let verifyToken: string | undefined;
    const userId = await this.db.transaction(async (trx) => {
      // Pozvánku zamkneme řádkem, aby se souběžně nepoužila nad limit.
      const rows = await trx.execute(sql`select code, role_id, max_uses, uses, email, expires_at, revoked_at from invites where code = ${input.inviteCode.trim().toUpperCase()} for update`);
      const inv = (rows.rows as { code: string; role_id: string | null; max_uses: number; uses: number; email: string | null; expires_at: string | null; revoked_at: string | null }[])[0];
      if (!inv || inv.revoked_at || (inv.expires_at && new Date(inv.expires_at) < now) || inv.uses >= inv.max_uses) throw new AccountError('INVALID_INVITE');
      if (inv.email && inv.email.toLowerCase() !== email.toLowerCase()) throw new AccountError('INVALID_INVITE');
      const dupNick = await trx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.nicknameLower, nickname.toLowerCase()));
      if (dupNick.length) throw new AccountError('NICKNAME_TAKEN');
      const dupMail = await trx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.emailLower, email.toLowerCase()));
      if (dupMail.length) throw new AccountError('EMAIL_TAKEN');
      const [u] = await trx
        .insert(schema.users)
        .values({ nickname, nicknameLower: nickname.toLowerCase(), email, emailLower: email.toLowerCase(), passwordHash, termsAcceptedAt: now, emailVerifiedAt: needsVerification ? null : now })
        .returning({ id: schema.users.id });
      await trx.update(schema.invites).set({ uses: inv.uses + 1 }).where(eq(schema.invites.code, inv.code));
      // Role: s ověřením e-mailu nejdřív Nováček (cílová role čeká v tokenu), bez ověření rovnou cílová.
      const targetRoleId = inv.role_id ?? this.deps.perms.roleByKey(DEFAULT_ROLE_KEY)?.id ?? null;
      const startRoleId = needsVerification ? (this.deps.perms.roleByKey(NEWBIE_ROLE_KEY)?.id ?? targetRoleId) : targetRoleId;
      if (startRoleId) await trx.insert(schema.roleAssignments).values({ userId: u!.id, roleId: startRoleId, scopeType: 'global', scopeId: '', grantedBy: null });
      if (needsVerification) {
        verifyToken = randomToken();
        await trx.insert(schema.emailTokens).values({ tokenHash: sha256(verifyToken), userId: u!.id, kind: 'verify_email', payload: targetRoleId, expiresAt: new Date(now.getTime() + Number(s['system.verifyLinkHours']) * 3600_000) });
      }
      return u!.id;
    });
    await this.deps.perms.reload();
    await this.deps.audit.log({ actorId: userId, action: 'ucet.registrace', targetType: 'user', targetId: userId, after: { nickname, email, inviteCode: input.inviteCode }, ip: meta.ip, source: 'ui' });
    if (needsVerification && verifyToken) {
      const hours = Number(s['system.verifyLinkHours']);
      this.notifier.verifyEmail(email, { nickname, link: this.link('/overit-email', verifyToken), hours });
    } else {
      await this.deps.onActivated?.(userId);
    }
    return { userId, needsVerification };
  }

  /** Pošle (nebo znovu pošle) ověřovací e-mail. */
  async sendVerification(userId: string): Promise<void> {
    const [u] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId));
    if (!u || !u.email || u.emailVerifiedAt) return;
    const [prev] = await this.db.select({ payload: schema.emailTokens.payload }).from(schema.emailTokens).where(and(eq(schema.emailTokens.userId, userId), eq(schema.emailTokens.kind, 'verify_email'))).limit(1);
    const token = randomToken();
    const hours = Number(this.s['system.verifyLinkHours']);
    await this.db.insert(schema.emailTokens).values({ tokenHash: sha256(token), userId, kind: 'verify_email', payload: prev?.payload ?? null, expiresAt: new Date(this.now().getTime() + hours * 3600_000) });
    this.notifier.verifyEmail(u.email, { nickname: u.nickname, link: this.link('/overit-email', token), hours });
  }

  async resendVerification(userId: string): Promise<void> {
    const key = `verify:${userId}`;
    if (this.limiter.count(key, 3600_000) >= Number(this.s['system.mailRequestsPerHour'])) throw new AccountError('RATE_LIMITED');
    this.limiter.record(key, 3600_000);
    await this.sendVerification(userId);
  }

  async verifyEmail(token: string): Promise<{ userId: string }> {
    const row = await this.consumeToken(token, 'verify_email');
    const [u] = await this.db.select().from(schema.users).where(eq(schema.users.id, row.userId));
    if (!u) throw new AccountError('INVALID_TOKEN');
    await this.db.update(schema.users).set({ emailVerifiedAt: this.now() }).where(eq(schema.users.id, u.id));
    // Z Nováčka se stane cílová role (z pozvánky nebo výchozí Hráč).
    const newbie = this.deps.perms.roleByKey(NEWBIE_ROLE_KEY);
    const target = row.payload ?? this.deps.perms.roleByKey(DEFAULT_ROLE_KEY)?.id;
    if (newbie && target && newbie.id !== target) {
      await this.db.delete(schema.roleAssignments).where(and(eq(schema.roleAssignments.userId, u.id), eq(schema.roleAssignments.roleId, newbie.id)));
      await this.db.insert(schema.roleAssignments).values({ userId: u.id, roleId: target, scopeType: 'global', scopeId: '' }).onConflictDoNothing();
    }
    await this.deps.perms.reload();
    await this.deps.audit.log({ actorId: u.id, action: 'ucet.overeni_emailu', targetType: 'user', targetId: u.id, source: 'ui' });
    await this.deps.onActivated?.(u.id);
    return { userId: u.id };
  }

  private async consumeToken(token: string, kind: string) {
    const hashed = sha256(token ?? '');
    const [row] = await this.db
      .update(schema.emailTokens)
      .set({ usedAt: this.now() })
      .where(and(eq(schema.emailTokens.tokenHash, hashed), eq(schema.emailTokens.kind, kind), isNull(schema.emailTokens.usedAt), gt(schema.emailTokens.expiresAt, this.now())))
      .returning();
    if (!row) throw new AccountError('INVALID_TOKEN');
    return row;
  }

  // ---------- přihlášení ----------

  async login(identifier: string, password: string, meta: Meta = {}): Promise<{ token: string; user: SessionUser; expiresAt: Date }> {
    const s = this.s;
    const max = Number(s['system.loginMaxAttempts']);
    const windowMs = Number(s['system.loginLockMinutes']) * 60_000;
    const idKey = `login:${(identifier ?? '').toLowerCase()}`;
    const ipKey = `loginip:${meta.ip ?? ''}`;
    const locked = Math.max(this.limiter.lockedFor(idKey, max, windowMs), this.limiter.lockedFor(ipKey, max * 4, windowMs));
    if (locked > 0) throw new AccountError('LOCKED', { retryAfterSeconds: Math.ceil(locked / 1000) });

    const id = (identifier ?? '').trim().toLowerCase();
    const [u] = await this.db.select().from(schema.users).where(or(eq(schema.users.nicknameLower, id), eq(schema.users.emailLower, id)));
    const ok = u ? await verify(u.passwordHash, password ?? '') : (await verify(await this.dummyHash, password ?? ''), false);
    if (!u || !ok) {
      this.limiter.record(idKey, windowMs);
      this.limiter.record(ipKey, windowMs);
      await this.deps.audit.log({ actorId: u?.id ?? null, action: 'ucet.prihlaseni_selhalo', targetType: 'user', targetId: u?.id, ip: meta.ip, source: 'ui' });
      throw new AccountError('INVALID_CREDENTIALS');
    }
    this.limiter.clear(idKey);
    const token = randomToken();
    const expiresAt = new Date(this.now().getTime() + Number(s['system.sessionDays']) * 86400_000);
    await this.db.insert(schema.sessions).values({ tokenHash: sha256(token), userId: u.id, expiresAt, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null });
    await this.db.update(schema.users).set({ lastSeenAt: this.now() }).where(eq(schema.users.id, u.id));
    await this.deps.audit.log({ actorId: u.id, action: 'ucet.prihlaseni', targetType: 'user', targetId: u.id, ip: meta.ip, source: 'ui' });
    return { token, user: this.toSessionUser(u), expiresAt };
  }

  private toSessionUser(u: typeof schema.users.$inferSelect): SessionUser {
    return { id: u.id, nickname: u.nickname, email: u.email, emailVerified: !!u.emailVerifiedAt, status: u.status, blockedReason: u.blockedReason, blockedUntil: u.blockedUntil, avatar: u.avatar };
  }

  /** Uživatel podle id (pro přístupové tokeny), nebo null. */
  async sessionUserById(userId: string): Promise<SessionUser | null> {
    const [u] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId));
    return u ? this.toSessionUser(u) : null;
  }

  /** Uživatel podle tokenu z cookie, nebo null. */
  async authenticate(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;
    const [row] = await this.db
      .select({ u: schema.users })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, this.now())));
    return row ? this.toSessionUser(row.u) : null;
  }

  /** Ověření hesla před citlivou akcí (znovuzadání hesla). */
  async verifyPassword(userId: string, password: string): Promise<boolean> {
    const [u] = await this.db.select({ h: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, userId));
    return !!u && (await verify(u.h, password ?? ''));
  }

  async logout(token: string): Promise<void> {
    await this.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
  }

  async logoutEverywhere(userId: string, exceptToken?: string): Promise<void> {
    const rows = await this.db.select({ h: schema.sessions.tokenHash }).from(schema.sessions).where(eq(schema.sessions.userId, userId));
    const keep = exceptToken ? sha256(exceptToken) : null;
    for (const r of rows) if (r.h !== keep) await this.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, r.h));
  }

  // ---------- heslo a e-mail ----------

  async changePassword(userId: string, current: string, next: string, keepToken?: string, meta: Meta = {}): Promise<void> {
    const [u] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId));
    if (!u || !(await verify(u.passwordHash, current ?? ''))) throw new AccountError('INVALID_CREDENTIALS');
    this.checkPassword(next);
    await this.db.update(schema.users).set({ passwordHash: await hash(next) }).where(eq(schema.users.id, userId));
    await this.logoutEverywhere(userId, keepToken);
    await this.deps.audit.log({ actorId: userId, action: 'ucet.zmena_hesla', targetType: 'user', targetId: userId, ip: meta.ip, source: 'ui' });
    if (u.email) this.notifier.passwordChanged(u.email, { nickname: u.nickname });
  }

  /** Vždy projde stejně, ať účet existuje, nebo ne (nelze zjišťovat existenci účtů). */
  async requestPasswordReset(identifier: string, meta: Meta = {}): Promise<void> {
    const id = (identifier ?? '').trim().toLowerCase();
    const per = Number(this.s['system.mailRequestsPerHour']);
    const keys = [`reset:${id}`, `resetip:${meta.ip ?? ''}`];
    if (keys.some((k) => this.limiter.count(k, 3600_000) >= per)) return;
    keys.forEach((k) => this.limiter.record(k, 3600_000));
    const [u] = await this.db.select().from(schema.users).where(or(eq(schema.users.nicknameLower, id), eq(schema.users.emailLower, id)));
    if (!u?.email) return;
    const token = randomToken();
    const hours = Number(this.s['system.resetLinkHours']);
    await this.db.insert(schema.emailTokens).values({ tokenHash: sha256(token), userId: u.id, kind: 'reset_password', expiresAt: new Date(this.now().getTime() + hours * 3600_000) });
    await this.deps.audit.log({ actorId: u.id, action: 'ucet.zadost_o_obnovu_hesla', targetType: 'user', targetId: u.id, ip: meta.ip, source: 'ui' });
    this.notifier.resetPassword(u.email, { nickname: u.nickname, link: this.link('/obnova-hesla', token), hours });
  }

  async resetPassword(token: string, newPassword: string, meta: Meta = {}): Promise<void> {
    this.checkPassword(newPassword);
    const row = await this.consumeToken(token, 'reset_password');
    const [u] = await this.db.select().from(schema.users).where(eq(schema.users.id, row.userId));
    if (!u) throw new AccountError('INVALID_TOKEN');
    await this.db.update(schema.users).set({ passwordHash: await hash(newPassword) }).where(eq(schema.users.id, u.id));
    await this.logoutEverywhere(u.id);
    this.limiter.clear(`login:${u.nicknameLower}`);
    await this.deps.audit.log({ actorId: u.id, action: 'ucet.obnova_hesla', targetType: 'user', targetId: u.id, ip: meta.ip, source: 'ui' });
    if (u.email) this.notifier.passwordChanged(u.email, { nickname: u.nickname });
  }

  /** Změna e-mailu: nová adresa se musí ověřit, na starou přijde upozornění. */
  async requestEmailChange(userId: string, password: string, newEmail: string): Promise<void> {
    const [u] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId));
    if (!u || !(await verify(u.passwordHash, password ?? ''))) throw new AccountError('INVALID_CREDENTIALS');
    const email = newEmail.trim();
    if (!EMAIL_RE.test(email)) throw new AccountError('INVALID_EMAIL');
    const dup = await this.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.emailLower, email.toLowerCase()));
    if (dup.length) throw new AccountError('EMAIL_TAKEN');
    const token = randomToken();
    const hours = Number(this.s['system.verifyLinkHours']);
    await this.db.insert(schema.emailTokens).values({ tokenHash: sha256(token), userId, kind: 'change_email', payload: email, expiresAt: new Date(this.now().getTime() + hours * 3600_000) });
    this.notifier.emailChange(email, { nickname: u.nickname, link: this.link('/potvrdit-email', token), hours });
  }

  async confirmEmailChange(token: string): Promise<void> {
    const row = await this.consumeToken(token, 'change_email');
    const [u] = await this.db.select().from(schema.users).where(eq(schema.users.id, row.userId));
    if (!u || !row.payload) throw new AccountError('INVALID_TOKEN');
    const old = u.email;
    const dup = await this.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.emailLower, row.payload.toLowerCase()));
    if (dup.length) throw new AccountError('EMAIL_TAKEN');
    await this.db.update(schema.users).set({ email: row.payload, emailLower: row.payload.toLowerCase(), emailVerifiedAt: this.now() }).where(eq(schema.users.id, u.id));
    await this.deps.audit.log({ actorId: u.id, action: 'ucet.zmena_emailu', targetType: 'user', targetId: u.id, before: { email: old }, after: { email: row.payload }, source: 'ui' });
    if (old) this.notifier.emailChangedNotice(old, { nickname: u.nickname, newEmail: row.payload });
  }

  // ---------- správa uživatelů ----------

  async blockUser(actorId: string, targetId: string, reason: string, until: Date | null, meta: Meta = {}): Promise<void> {
    if (!this.deps.perms.can(actorId, 'uzivatel.blokovat').allowed) throw new AccountError('FORBIDDEN');
    this.deps.perms.assertCanManageUser(actorId, targetId);
    this.deps.perms.assertNotLastMainAdmin(targetId);
    await this.db.update(schema.users).set({ status: 'blocked', blockedReason: reason, blockedUntil: until }).where(eq(schema.users.id, targetId));
    await this.logoutEverywhere(targetId);
    await this.deps.perms.reload();
    await this.deps.audit.log({ actorId, action: 'uzivatel.blokovat', targetType: 'user', targetId, after: { reason, until }, reason, ip: meta.ip, source: meta.source });
  }

  async unblockUser(actorId: string, targetId: string, meta: Meta = {}): Promise<void> {
    if (!this.deps.perms.can(actorId, 'uzivatel.blokovat').allowed) throw new AccountError('FORBIDDEN');
    this.deps.perms.assertCanManageUser(actorId, targetId);
    await this.db.update(schema.users).set({ status: 'active', blockedReason: null, blockedUntil: null }).where(eq(schema.users.id, targetId));
    await this.deps.perms.reload();
    await this.deps.audit.log({ actorId, action: 'uzivatel.odblokovat', targetType: 'user', targetId, ip: meta.ip, source: meta.source });
  }

  async forcePasswordChange(actorId: string, targetId: string, meta: Meta = {}): Promise<void> {
    if (!this.deps.perms.can(actorId, 'uzivatel.vynutit_zmenu_hesla').allowed) throw new AccountError('FORBIDDEN');
    this.deps.perms.assertCanManageUser(actorId, targetId);
    // Staré heslo přestane platit; uživatel si nové nastaví přes „zapomenuté heslo“.
    await this.db.update(schema.users).set({ passwordHash: await hash(randomToken(24)) }).where(eq(schema.users.id, targetId));
    await this.logoutEverywhere(targetId);
    await this.deps.audit.log({ actorId, action: 'uzivatel.vynutit_zmenu_hesla', targetType: 'user', targetId, ip: meta.ip, source: meta.source });
  }

  async markEmailVerified(actorId: string, targetId: string, meta: Meta = {}): Promise<void> {
    if (!this.deps.perms.can(actorId, 'uzivatel.overit_email').allowed) throw new AccountError('FORBIDDEN');
    this.deps.perms.assertCanManageUser(actorId, targetId);
    const token = await this.db.select().from(schema.emailTokens).where(and(eq(schema.emailTokens.userId, targetId), eq(schema.emailTokens.kind, 'verify_email'), isNull(schema.emailTokens.usedAt))).limit(1);
    await this.db.update(schema.users).set({ emailVerifiedAt: this.now() }).where(eq(schema.users.id, targetId));
    // Stejně jako po kliknutí na odkaz: Nováček se stane cílovou rolí.
    const newbie = this.deps.perms.roleByKey(NEWBIE_ROLE_KEY);
    const target = token[0]?.payload ?? this.deps.perms.roleByKey(DEFAULT_ROLE_KEY)?.id;
    if (newbie && target && newbie.id !== target) {
      await this.db.delete(schema.roleAssignments).where(and(eq(schema.roleAssignments.userId, targetId), eq(schema.roleAssignments.roleId, newbie.id)));
      await this.db.insert(schema.roleAssignments).values({ userId: targetId, roleId: target, scopeType: 'global', scopeId: '' }).onConflictDoNothing();
    }
    await this.deps.perms.reload();
    await this.deps.audit.log({ actorId, action: 'uzivatel.overit_email', targetType: 'user', targetId, ip: meta.ip, source: meta.source });
    await this.deps.onActivated?.(targetId);
  }

  async listUsers(actorId: string) {
    if (!this.deps.perms.can(actorId, 'uzivatel.zobrazit').allowed) throw new AccountError('FORBIDDEN');
    const rows = await this.db.select().from(schema.users);
    return rows.map((u) => ({ ...this.toSessionUser(u), createdAt: u.createdAt, lastSeenAt: u.lastSeenAt, roles: this.deps.perms.assignmentsOf(u.id).map((a) => ({ id: a.id, roleId: a.roleId, role: a.role?.name, scopeType: a.scopeType, scopeId: a.scopeId, validTo: a.validTo })) }));
  }

  // ---------- první start a nouzová obnova ----------

  /** Vytvoří prvního hlavního administrátora, pokud žádný není. Vrací vygenerované heslo, pokud nebylo zadáno. */
  async ensureMainAdmin(nickname: string, password?: string): Promise<{ created: boolean; password?: string }> {
    await this.deps.perms.reload();
    if (this.deps.perms.mainAdminIds().length > 0) return { created: false };
    const role = this.deps.perms.roleByKey('main_admin');
    if (!role) throw new Error('Role hlavního administrátora neexistuje (seed nebyl spuštěn).');
    const generated = password ? undefined : randomToken(12);
    const pw = password ?? generated!;
    const lower = nickname.toLowerCase();
    const [existing] = await this.db.select().from(schema.users).where(eq(schema.users.nicknameLower, lower));
    let userId = existing?.id;
    if (existing) {
      await this.db.update(schema.users).set({ passwordHash: await hash(pw), status: 'active', blockedUntil: null, blockedReason: null }).where(eq(schema.users.id, existing.id));
    } else {
      const [u] = await this.db.insert(schema.users).values({ nickname, nicknameLower: lower, passwordHash: await hash(pw), termsAcceptedAt: this.now(), emailVerifiedAt: this.now() }).returning({ id: schema.users.id });
      userId = u!.id;
    }
    await this.deps.perms.grantUnchecked(userId!, role.id);
    await this.deps.audit.log({ actorId: null, action: 'system.prvni_admin', targetType: 'user', targetId: userId, source: 'system' });
    await this.deps.onActivated?.(userId!);
    return { created: true, password: generated };
  }

  /** Nouzová obnova přístupu (CLI): nastaví heslo a přidělí roli hlavního administrátora. */
  async recoverAdmin(nickname: string, password: string): Promise<void> {
    const role = this.deps.perms.roleByKey('main_admin');
    if (!role) throw new Error('Role hlavního administrátora neexistuje.');
    this.checkPassword(password);
    const lower = nickname.toLowerCase();
    const [u] = await this.db.select().from(schema.users).where(eq(schema.users.nicknameLower, lower));
    if (!u) throw new AccountError('NOT_FOUND');
    await this.db.update(schema.users).set({ passwordHash: await hash(password), status: 'active', blockedUntil: null, blockedReason: null }).where(eq(schema.users.id, u.id));
    await this.logoutEverywhere(u.id);
    await this.deps.perms.grantUnchecked(u.id, role.id);
    await this.deps.audit.log({ actorId: null, action: 'system.obnova_admina', targetType: 'user', targetId: u.id, source: 'cli' });
  }
}
