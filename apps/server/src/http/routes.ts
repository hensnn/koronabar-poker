import cookie from '@fastify/cookie';
import { estimateTournament } from '@kb/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { accounts as ledgerAccounts, type CashService, type Ledger } from '@kb/ledger';
import { PERMISSIONS, permissionCategories, type ApiScope, type Scope } from '@kb/shared';
import { AccountError, type AccountService, type SessionUser } from '../auth/accounts.js';
import type { AuditService } from '../auth/audit.js';
import type { PermissionService } from '../auth/permissions.js';
import type { SettingsStore } from '../settings-store.js';
import { SESSION_COOKIE } from './cookies.js';
import { sendError } from './errors.js';
import { schema, type Db } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { EMAIL_TEMPLATES, SECRETS, SMTP_PRESETS, type SettingsTemplate } from '@kb/shared';
import type { EmailService } from '../email/service.js';
import type { ApprovalService } from '../auth/approvals.js';
import type { WalletService } from '../wallet/service.js';
import type { TableManager } from '../tables.js';
import type { TemplateService } from '../templates.js';
import type { MaintenanceService } from '../maintenance.js';
import type { HistoryService, HistoryKind } from '../history.js';
import type { TournamentManager } from '../tournaments.js';
import type { Scheduler } from '../scheduler.js';
import type { SeriesService } from '../series.js';
import type { NotificationService } from '../notifications.js';
import type { PushService } from '../push.js';
import { StatsError, type StatsService } from '../stats.js';
import { SoundError, type SoundService } from '../sounds.js';
import { ChatError } from '../chat/service.js';
import type { ChatImages } from '../chat/images.js';
import type { ProgressService } from '../progress.js';
import { AchievementError, type AchievementService } from '../achievements.js';
import { RatingError, type RatingService } from '../rating.js';
import { PollError, type PollService } from '../polls.js';
import { ThemeError, type ThemeService } from '../themes.js';
import { AssetError, type ThemeAssets } from '../theme-assets.js';
import { LiveError, type LiveCashService } from '../live-cash.js';
import { TvError, type TvService } from '../tv.js';
import { AnnouncerError, type AnnouncerService } from '../announcer.js';
import { EveningError, type EveningService } from '../evenings.js';
import { BetError, type BetService, type HeadBountyService } from '../bets.js';
import { LimitsError, type LimitsService } from '../limits.js';
import { NotesError, type NotesService } from '../notes.js';
import { HandError, type SharedHandService } from '../shared-hands.js';
import { CosmeticError, type CosmeticService } from '../cosmetics.js';
import { IntegrationError, type IntegrationService } from '../integrations/service.js';
import { ApiError, type ApiTokenService, type TokenAuth } from '../api-tokens.js';
import { AssistantError, type AssistantService } from '../assistant/service.js';
import type { McpService } from '../assistant/mcp.js';
import { buildOpenApi } from './openapi.js';
import { buildIcs, checkCalendarToken, calendarToken } from '../calendar.js';
import type { SecretStore } from '../secrets/store.js';

export interface Services {
  db: Db;
  audit: AuditService;
  perms: PermissionService;
  accounts: AccountService;
  settings: SettingsStore;
  ledger: Ledger;
  cash: CashService;
  secrets: SecretStore;
  email: EmailService;
  approvals: ApprovalService;
  wallet: WalletService;
  hooks: { pushWallet: (userId: string) => void };
  tables: () => TableManager;
  tournaments: () => TournamentManager;
  templates: () => TemplateService;
  maintenance: () => MaintenanceService;
  history: () => HistoryService;
  scheduler: () => Scheduler;
  notifications: () => NotificationService;
  push: () => PushService;
  stats: () => StatsService;
  sounds: () => SoundService;
  chatImages: () => ChatImages;
  progress: () => ProgressService;
  achievements: () => AchievementService;
  rating: () => RatingService;
  polls: () => PollService;
  themes: () => ThemeService;
  themeAssets: () => ThemeAssets;
  liveCash: () => LiveCashService;
  tv: () => TvService;
  announcer: () => AnnouncerService;
  evenings: () => EveningService;
  bets: () => BetService;
  headBounties: () => HeadBountyService;
  limits: () => LimitsService;
  notes: () => NotesService;
  sharedHands: () => SharedHandService;
  cosmetics: () => CosmeticService;
  integrations: () => IntegrationService;
  apiTokens: () => ApiTokenService;
  assistant: () => AssistantService;
  mcp: () => McpService;
  chatPost: (userId: string, text: string) => Promise<void>;
  publicUrl: () => string;
  series: () => SeriesService;
  /** Tajný klíč pro podpis odkazu na kalendář. */
  calendarSecret: () => Buffer;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionToken: string | undefined;
    apiAuth: TokenAuth | null;
  }
}

const id = z.string().uuid();
const date = z.coerce.date().nullable().optional();

export async function registerRoutes(app: FastifyInstance, svc: Services, opts: { secureCookie: boolean; allowedOrigins: () => string[] }) {
  await app.register(cookie);
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', undefined);
  app.decorateRequest('apiAuth', null);

  // Ochrana proti CSRF: změny stavu jen z povolených původů a jen jako JSON.
  app.addHook('onRequest', async (req, reply) => {
    req.sessionToken = req.cookies[SESSION_COOKIE];
    req.user = await svc.accounts.authenticate(req.sessionToken);
    // Veřejné API se přihlašuje jen osobním tokenem; cookie se tam nepoužije, aby se nedala zneužít přes jiný web.
    if ((req.url.startsWith('/api/v1/') && !req.url.startsWith('/api/v1/openapi.json')) || req.url === '/api/mcp') {
      req.user = null;
      const raw = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined;
      try {
        req.apiAuth = await svc.apiTokens().authenticate(raw);
        req.user = req.apiAuth.user;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.code === 'RATE_LIMIT') reply.header('retry-after', String(e.params.seconds));
        return reply.status(e.code === 'RATE_LIMIT' ? 429 : e.code === 'DISABLED' ? 503 : 401).send({ code: 'API_' + e.code, params: e.params });
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin && !opts.allowedOrigins().includes(origin)) return reply.status(403).send({ code: 'FORBIDDEN_ORIGIN' });
    }
  });

  const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] ?? null, source: 'ui' as const });
  const need = (req: FastifyRequest): SessionUser => {
    if (!req.user) throw new AccountError('INVALID_CREDENTIALS');
    return req.user;
  };
  const guard = <T>(fn: (req: FastifyRequest, reply: FastifyReply) => Promise<T>) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      return sendError(reply, e);
    }
  };
  const setCookie = (reply: FastifyReply, token: string, expires: Date) =>
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: opts.secureCookie, path: '/', expires });

  const me = (user: SessionUser) => {
    const eff = svc.perms.effective(user.id);
    return {
      user,
      permissions: [...eff.keys()],
      limits: Object.fromEntries([...eff].filter(([, d]) => d.limits).map(([k, d]) => [k, d.limits])),
      approvals: Object.fromEntries([...eff].filter(([, d]) => d.needsApproval).map(([k]) => [k, true])),
      mainAdmin: svc.perms.isMainAdmin(user.id),
      power: svc.perms.maxPower(user.id),
      balance: svc.ledger.balance(ledgerAccounts.wallet(user.id)),
    };
  };

  // ---------- veřejné ----------

  app.get('/health', async () => ({ ok: true }));
  app.get('/api/public/terms', async () => ({ text: String(svc.settings.resolve()['system.termsText']) }));

  // ---------- přihlášení a účet ----------

  app.post('/api/auth/register', guard(async (req, reply) => {
    const body = z.object({ inviteCode: z.string().min(1).max(40), nickname: z.string().max(60), email: z.string().max(250), password: z.string().max(250), acceptTerms: z.boolean() }).parse(req.body);
    return reply.send(await svc.accounts.register(body, meta(req)));
  }));

  app.post('/api/auth/login', guard(async (req, reply) => {
    const body = z.object({ identifier: z.string().min(1).max(250), password: z.string().max(250) }).parse(req.body);
    const r = await svc.accounts.login(body.identifier, body.password, meta(req));
    setCookie(reply, r.token, r.expiresAt);
    return reply.send(me(r.user));
  }));

  app.post('/api/auth/logout', guard(async (req, reply) => {
    if (req.sessionToken) await svc.accounts.logout(req.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  }));

  app.get('/api/auth/me', guard(async (req, reply) => reply.send(me(need(req)))));

  app.post('/api/auth/verify-email', guard(async (req, reply) => {
    const { token } = z.object({ token: z.string().min(1).max(300) }).parse(req.body);
    await svc.accounts.verifyEmail(token);
    return reply.send({ ok: true });
  }));
  app.post('/api/auth/resend-verification', guard(async (req, reply) => {
    await svc.accounts.resendVerification(need(req).id);
    return reply.send({ ok: true });
  }));
  app.post('/api/auth/forgot', guard(async (req, reply) => {
    const { identifier } = z.object({ identifier: z.string().min(1).max(250) }).parse(req.body);
    await svc.accounts.requestPasswordReset(identifier, meta(req));
    // Odpověď je vždy stejná.
    return reply.send({ ok: true });
  }));
  app.post('/api/auth/reset', guard(async (req, reply) => {
    const { token, password } = z.object({ token: z.string().min(1).max(300), password: z.string().max(250) }).parse(req.body);
    await svc.accounts.resetPassword(token, password, meta(req));
    return reply.send({ ok: true });
  }));
  app.post('/api/auth/change-password', guard(async (req, reply) => {
    const { current, next } = z.object({ current: z.string().max(250), next: z.string().max(250) }).parse(req.body);
    await svc.accounts.changePassword(need(req).id, current, next, req.sessionToken, meta(req));
    return reply.send({ ok: true });
  }));
  app.post('/api/auth/change-email', guard(async (req, reply) => {
    const { password, email } = z.object({ password: z.string().max(250), email: z.string().max(250) }).parse(req.body);
    await svc.accounts.requestEmailChange(need(req).id, password, email);
    return reply.send({ ok: true });
  }));
  app.post('/api/auth/confirm-email', guard(async (req, reply) => {
    const { token } = z.object({ token: z.string().min(1).max(300) }).parse(req.body);
    await svc.accounts.confirmEmailChange(token);
    return reply.send({ ok: true });
  }));

  // ---------- nastavení ----------

  app.get('/api/settings/schema', guard(async (_req, reply) => {
    return reply.send({ parameters: svc.settings['registry'].all().filter((d) => !d.secret) });
  }));

  /** Osobní nastavení hráče (vrstva `user` a `userDevice`). */
  app.get('/api/me/settings', guard(async (req, reply) => {
    const u = need(req);
    const device = String((req.query as { device?: string }).device ?? '');
    return reply.send({ user: svc.settings.layer('user', u.id), device: device ? svc.settings.layer('userDevice', `${u.id}:${device}`) : {} });
  }));
  app.put('/api/me/settings', guard(async (req, reply) => {
    const u = need(req);
    const body = z.object({ key: z.string().max(100), value: z.union([z.string().max(5000), z.number(), z.boolean()]), device: z.string().max(100).optional() }).parse(req.body);
    const scope: Scope = body.device ? 'userDevice' : 'user';
    await svc.settings.set(u.id, scope, body.device ? `${u.id}:${body.device}` : u.id, body.key, body.value, { meta: meta(req) });
    return reply.send({ ok: true });
  }));
  app.delete('/api/me/settings/:key', guard(async (req, reply) => {
    const u = need(req);
    const { key } = req.params as { key: string };
    const device = (req.query as { device?: string }).device;
    await svc.settings.reset(u.id, device ? 'userDevice' : 'user', device ? `${u.id}:${device}` : u.id, key, meta(req));
    return reply.send({ ok: true });
  }));
  app.get('/api/settings/global', guard(async (req, reply) => {
    need(req);
    return reply.send({ values: svc.settings.layer('global') });
  }));
  app.put('/api/settings/global', guard(async (req, reply) => {
    const u = need(req);
    const body = z.object({ key: z.string().max(100), value: z.union([z.string().max(5000), z.number(), z.boolean()]) }).parse(req.body);
    await svc.settings.set(u.id, 'global', '', body.key, body.value, { meta: meta(req) });
    return reply.send({ ok: true });
  }));

  // ---------- správa uživatelů a pozvánek ----------

  app.get('/api/admin/users', guard(async (req, reply) => reply.send(await svc.accounts.listUsers(need(req).id))));
  const userAction = (path: string, run: (actor: string, target: string, body: any, m: ReturnType<typeof meta>) => Promise<unknown>, body: z.ZodTypeAny = z.object({}).passthrough()) =>
    app.post(`/api/admin/users/:id/${path}`, guard(async (req, reply) => {
      const target = id.parse((req.params as { id: string }).id);
      await run(need(req).id, target, body.parse(req.body ?? {}), meta(req));
      return reply.send({ ok: true });
    }));
  userAction('block', (a, t, b, m) => svc.accounts.blockUser(a, t, b.reason, b.until ?? null, m), z.object({ reason: z.string().min(1).max(300), until: date }));
  userAction('unblock', (a, t, _b, m) => svc.accounts.unblockUser(a, t, m));
  userAction('force-password', (a, t, _b, m) => svc.accounts.forcePasswordChange(a, t, m));
  userAction('verify-email', (a, t, _b, m) => svc.accounts.markEmailVerified(a, t, m));
  userAction('reset-progress', (a, t, b, m) => svc.maintenance().resetUser(a, t, b, m), z.object({ xp: z.boolean().optional(), achievements: z.boolean().optional(), rating: z.boolean().optional() }));

  // ---------- správa historie ----------
  app.get('/api/admin/history', guard(async (req, reply) => reply.send(await svc.history().overview(need(req).id))));
  app.delete('/api/admin/history/:kind/:id', guard(async (req, reply) => {
    const p = z.object({ kind: z.enum(['tournament', 'cashTable', 'liveCash', 'poll', 'evening', 'sharedHand']), id: z.string().max(100) }).parse(req.params);
    await svc.history().remove(need(req).id, p.kind as HistoryKind, p.id, meta(req));
    return reply.send({ ok: true });
  }));
  app.post('/api/admin/history/purge-hands', guard(async (req, reply) => {
    const b = z.object({ olderThanDays: z.number().int().min(0).max(36500) }).parse(req.body);
    return reply.send({ deleted: await svc.history().purgeHands(need(req).id, b.olderThanDays, meta(req)) });
  }));

  // ---------- údržba: vynulování po testování ----------
  app.get('/api/admin/maintenance', guard(async (req, reply) => reply.send(await svc.maintenance().counts(need(req).id))));
  app.post('/api/admin/maintenance/reset', guard(async (req, reply) => {
    const b = z.object({ games: z.boolean().optional(), xp: z.boolean().optional(), achievements: z.boolean().optional(), rating: z.boolean().optional(), stats: z.boolean().optional(), wallets: z.boolean().optional() }).parse(req.body ?? {});
    return reply.send({ done: await svc.maintenance().reset(need(req).id, b, meta(req)) });
  }));

  app.get('/api/admin/invites', guard(async (req, reply) => {
    const u = need(req);
    if (!svc.perms.can(u.id, 'uzivatel.pozvat').allowed) throw new AccountError('FORBIDDEN');
    return reply.send(await svc.db.select().from(schema.invites));
  }));
  app.post('/api/admin/invites', guard(async (req, reply) => {
    const body = z.object({ roleId: id.nullable().optional(), maxUses: z.number().int().min(1).max(1000).optional(), hours: z.number().int().min(1).max(8760).optional(), email: z.string().email().nullable().optional(), note: z.string().max(300).nullable().optional() }).parse(req.body ?? {});
    return reply.send({ code: await svc.accounts.createInvite(need(req).id, body, meta(req)) });
  }));
  app.delete('/api/admin/invites/:code', guard(async (req, reply) => {
    await svc.accounts.revokeInvite(need(req).id, (req.params as { code: string }).code, meta(req));
    return reply.send({ ok: true });
  }));

  // ---------- role a oprávnění ----------

  app.get('/api/admin/permissions', guard(async (req, reply) => {
    if (!svc.perms.can(need(req).id, 'role.zobrazit').allowed) throw new AccountError('FORBIDDEN');
    return reply.send({ permissions: PERMISSIONS, categories: permissionCategories() });
  }));
  app.get('/api/admin/roles', guard(async (req, reply) => {
    if (!svc.perms.can(need(req).id, 'role.zobrazit').allowed) throw new AccountError('FORBIDDEN');
    return reply.send(svc.perms.listRoles());
  }));
  const permsSchema = z.array(z.object({ key: z.string(), effect: z.enum(['allow', 'deny']).optional(), limits: z.record(z.string(), z.number().int().min(0)).optional(), needsApproval: z.boolean().optional() })).max(200);
  app.post('/api/admin/roles', guard(async (req, reply) => {
    const b = z.object({ key: z.string(), name: z.string(), description: z.string().nullable().optional(), power: z.number().int(), color: z.string().nullable().optional(), icon: z.string().nullable().optional(), permissions: permsSchema }).parse(req.body);
    return reply.send({ id: await svc.perms.createRole(need(req).id, b as never, meta(req)) });
  }));
  app.patch('/api/admin/roles/:id', guard(async (req, reply) => {
    const b = z.object({ name: z.string().optional(), description: z.string().nullable().optional(), power: z.number().int().optional(), color: z.string().nullable().optional(), icon: z.string().nullable().optional(), permissions: permsSchema.optional() }).parse(req.body);
    await svc.perms.updateRole(need(req).id, id.parse((req.params as { id: string }).id), b as never, meta(req));
    return reply.send({ ok: true });
  }));
  app.delete('/api/admin/roles/:id', guard(async (req, reply) => {
    await svc.perms.deleteRole(need(req).id, id.parse((req.params as { id: string }).id), meta(req));
    return reply.send({ ok: true });
  }));
  app.post('/api/admin/assignments', guard(async (req, reply) => {
    const b = z.object({ userId: id, roleId: id, scopeType: z.enum(['global', 'series', 'tournament', 'table', 'channel']).optional(), scopeId: z.string().max(100).optional(), validFrom: date, validTo: date, reason: z.string().max(300).optional() }).parse(req.body);
    const aid = await svc.perms.assignRole(need(req).id, b.userId, b.roleId, { scopeType: b.scopeType, scopeId: b.scopeId, validFrom: b.validFrom ?? null, validTo: b.validTo ?? null }, { ...meta(req), reason: b.reason });
    return reply.send({ id: aid });
  }));
  app.delete('/api/admin/assignments/:id', guard(async (req, reply) => {
    await svc.perms.revokeAssignment(need(req).id, id.parse((req.params as { id: string }).id), meta(req));
    return reply.send({ ok: true });
  }));

  // ---------- audit ----------

  app.get('/api/admin/audit', guard(async (req, reply) => {
    if (!svc.perms.can(need(req).id, 'audit.zobrazit').allowed) throw new AccountError('FORBIDDEN');
    const q = z.object({ actorId: id.optional(), action: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query);
    return reply.send(await svc.audit.list(q));
  }));

  // ---------- tajné údaje (znovuzadání hesla) ----------

  const reauth = async (req: FastifyRequest, password: unknown) => {
    const u = need(req);
    if (typeof password !== 'string' || !(await svc.accounts.verifyPassword(u.id, password))) throw new AccountError('INVALID_CREDENTIALS');
    return u;
  };
  app.get('/api/admin/secrets', guard(async (req, reply) => {
    const u = need(req);
    const allowed = new Set(SECRETS.filter((d) => svc.perms.can(u.id, d.permission).allowed).map((d) => d.key));
    if (allowed.size === 0) throw new AccountError('FORBIDDEN');
    return reply.send((await svc.secrets.status()).filter((s) => allowed.has(s.key)));
  }));
  app.put('/api/admin/secrets/:key', guard(async (req, reply) => {
    const b = z.object({ value: z.string().min(1).max(2000), password: z.string() }).parse(req.body);
    const u = await reauth(req, b.password);
    await svc.secrets.set(u.id, (req.params as { key: string }).key, b.value, meta(req));
    return reply.send({ ok: true });
  }));
  app.post('/api/admin/secrets/:key/delete', guard(async (req, reply) => {
    const b = z.object({ password: z.string() }).parse(req.body);
    const u = await reauth(req, b.password);
    await svc.secrets.delete(u.id, (req.params as { key: string }).key, meta(req));
    return reply.send({ ok: true });
  }));
  app.post('/api/admin/secrets/rotate', guard(async (req, reply) => {
    const b = z.object({ password: z.string() }).parse(req.body);
    const u = await reauth(req, b.password);
    return reply.send(await svc.secrets.rotate(u.id, meta(req)));
  }));

  // ---------- e-mail ----------

  app.get('/api/admin/email/presets', guard(async (_req, reply) => reply.send({ presets: SMTP_PRESETS, templates: EMAIL_TEMPLATES.map((t) => ({ key: t.key, variables: t.variables, security: t.security })) })));
  app.get('/api/admin/email/queue', guard(async (req, reply) => reply.send({ items: await svc.email.list(need(req).id), stats: await svc.email.stats() })));
  app.post('/api/admin/email/test', guard(async (req, reply) => {
    const b = z.object({ to: z.string().email() }).parse(req.body);
    return reply.send(await svc.email.sendTest(need(req).id, b.to));
  }));
  app.get('/api/admin/email/templates', guard(async (req, reply) => {
    if (!svc.perms.can(need(req).id, 'email.sablony').allowed) throw new AccountError('FORBIDDEN');
    return reply.send(await svc.email.listTemplates());
  }));
  app.put('/api/admin/email/templates/:key', guard(async (req, reply) => {
    const b = z.object({ subject: z.string().min(1).max(300), bodyText: z.string().min(1).max(20000), bodyHtml: z.string().max(50000).nullable().optional() }).parse(req.body);
    const r = await svc.email.saveTemplate(need(req).id, (req.params as { key: string }).key, b, meta(req));
    return reply.status(r.unknown.length ? 400 : 200).send(r.unknown.length ? { code: 'UNKNOWN_VARIABLES', params: { variables: r.unknown } } : { ok: true });
  }));
  app.delete('/api/admin/email/templates/:key', guard(async (req, reply) => {
    await svc.email.resetTemplate(need(req).id, (req.params as { key: string }).key);
    return reply.send({ ok: true });
  }));
  app.post('/api/admin/email/templates/:key/preview', guard(async (req, reply) => {
    if (!svc.perms.can(need(req).id, 'email.sablony').allowed) throw new AccountError('FORBIDDEN');
    const b = z.object({ subject: z.string(), bodyText: z.string(), bodyHtml: z.string().nullable().optional(), vars: z.record(z.string(), z.union([z.string(), z.number()])).optional() }).parse(req.body);
    return reply.send(await svc.email.render((req.params as { key: string }).key, b.vars ?? {}, b));
  }));

  /** Adresář hráčů (pro soukromé zprávy a zmínky): jen přezdívky a avatary. */
  app.get('/api/directory', guard(async (req, reply) => {
    const u = need(req);
    if (!svc.perms.can(u.id, 'stul.zobrazit').allowed) throw new AccountError('FORBIDDEN');
    const rows = await svc.db.select({ id: schema.users.id, nickname: schema.users.nickname, avatar: schema.users.avatar, status: schema.users.status }).from(schema.users);
    return reply.send(rows.filter((r) => r.status !== 'blocked').map(({ status: _s, ...r }) => r));
  }));

  // ---------- lobby ----------

  app.get('/api/lobby', guard(async (req, reply) => {
    const u = need(req);
    if (!svc.perms.can(u.id, 'stul.zobrazit').allowed) throw new AccountError('FORBIDDEN');
    return reply.send({
      tables: await svc.tables().lobby(),
      templates: svc.templates().list('cash').map((t) => ({ id: t.id, name: t.name, description: t.description, tags: t.tags, builtin: !!t.builtin, values: t.values })),
    });
  }));
  app.post('/api/lobby/tables', guard(async (req, reply) => {
    const b = z.object({ name: z.string().max(100), templateId: z.string().max(60), settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() }).parse(req.body);
    return reply.send(await svc.tables().createTable(need(req).id, b, meta(req)));
  }));
  app.get('/api/lobby/tables/:id', guard(async (req, reply) => {
    const u = need(req);
    if (!svc.perms.can(u.id, 'stul.zobrazit').allowed) throw new AccountError('FORBIDDEN');
    const d = svc.tables().details((req.params as { id: string }).id);
    if (!d) return reply.status(404).send({ code: 'TABLE_NOT_FOUND' });
    return reply.send({ ...d, canEdit: d.ownerId === u.id ? svc.perms.can(u.id, 'cash.upravit_vlastni').allowed : svc.perms.can(u.id, 'cash.upravit_vse').allowed, isAdmin: svc.perms.can(u.id, 'nastaveni.globalni').allowed });
  }));
  app.patch('/api/lobby/tables/:id', guard(async (req, reply) => {
    const b = z.object({ settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }).parse(req.body);
    return reply.send(await svc.tables().updateSettings(need(req).id, (req.params as { id: string }).id, b.settings, meta(req)));
  }));
  app.post('/api/lobby/tables/:id/pause', guard(async (req, reply) => {
    const b = z.object({ resume: z.boolean().optional() }).parse(req.body ?? {});
    await svc.tables().pause(need(req).id, (req.params as { id: string }).id, !!b.resume, meta(req));
    return reply.send({ ok: true });
  }));
  // ===== 6. kde sedím (tlačítko „Ke stolu“ v nabídce) =====
  app.get('/api/me/seat', guard(async (req, reply) => {
    const u = need(req);
    for (const [tableId, actor] of svc.tables().actors) {
      if (!actor.playersSeated().some((s) => s.userId === u.id)) continue;
      const info = actor.viewFor(null).info;
      const name = svc.tables().row(tableId)?.name ?? (info.tournamentId ? svc.tournaments().nameOf(info.tournamentId) : undefined) ?? tableId;
      return reply.send({ seat: { tableId, name, tournamentId: info.tournamentId ?? null } });
    }
    return reply.send({ seat: null });
  }));
  app.delete('/api/lobby/tables/:id', guard(async (req, reply) => {
    await svc.tables().closeTable(need(req).id, (req.params as { id: string }).id, meta(req));
    return reply.send({ ok: true });
  }));

  // ---------- turnaje ----------

  app.get('/api/admin/finance', guard(async (req, reply) => {
    const u = need(req);
    if (!svc.perms.can(u.id, 'mena.zobrazit_knihu').allowed) throw new AccountError('FORBIDDEN');
    return reply.send(await svc.tournaments().finance());
  }));

  const viewer = (req: FastifyRequest) => {
    const u = need(req);
    if (!svc.perms.can(u.id, 'stul.zobrazit').allowed) throw new AccountError('FORBIDDEN');
    return u;
  };
  const tid = (req: FastifyRequest) => (req.params as { id: string }).id;
  app.get('/api/tournaments', guard(async (req, reply) => {
    viewer(req);
    return reply.send({
      tournaments: await svc.tournaments().lobby(),
      templates: svc.templates().list('tournament').map((t) => ({ id: t.id, name: t.name, description: t.description, tags: t.tags, builtin: !!t.builtin, values: t.values })),
    });
  }));
  app.post('/api/tournaments', guard(async (req, reply) => {
    const b = z.object({ name: z.string().max(100), templateId: z.string().max(60), settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() }).parse(req.body);
    return reply.send(await svc.tournaments().create(need(req).id, b, meta(req)));
  }));
  // Orientační odhad délky turnaje simulací s boty (jen pro ty, kdo turnaje zakládají).
  // ---------- šablony nastavení (vestavěné + vlastní) ----------
  const templateBody = z.object({ name: z.string().max(100), description: z.string().max(300).optional(), kind: z.enum(['cash', 'tournament', 'live']), tags: z.array(z.string().max(30)).max(20).optional(), values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) });
  const templateDto = (t: SettingsTemplate) => ({ id: t.id, kind: t.kind, name: t.name, description: t.description, tags: t.tags, builtin: !!t.builtin, overridden: svc.templates().isOverridden(t.id), values: t.values });
  app.get('/api/admin/templates', guard(async (req, reply) => {
    if (!svc.perms.can(need(req).id, 'nastaveni.globalni').allowed) throw new AccountError('FORBIDDEN');
    return reply.send({ templates: svc.templates().list().map(templateDto) });
  }));
  app.post('/api/admin/templates', guard(async (req, reply) => reply.send(templateDto(await svc.templates().create(need(req).id, templateBody.parse(req.body), meta(req))))));
  app.put('/api/admin/templates/:id', guard(async (req, reply) => reply.send(templateDto(await svc.templates().update(need(req).id, (req.params as { id: string }).id, templateBody.parse(req.body), meta(req))))));
  app.put('/api/admin/templates/order', guard(async (req, reply) => {
    const b = z.object({ kind: z.enum(['cash', 'tournament', 'live']), ids: z.array(z.string().max(100)).max(200) }).parse(req.body);
    await svc.templates().reorder(need(req).id, b.kind, b.ids);
    return reply.send({ ok: true });
  }));
  app.delete('/api/admin/templates/:id', guard(async (req, reply) => {
    await svc.templates().remove(need(req).id, (req.params as { id: string }).id, meta(req));
    return reply.send({ ok: true });
  }));

  app.post('/api/tournaments/estimate', guard(async (req, reply) => {
    const u = need(req);
    if (!svc.perms.can(u.id, 'turnaj.vytvorit').allowed) throw new AccountError('FORBIDDEN');
    const b = z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), players: z.number().int().min(2).max(10) }).parse(req.body);
    const picked = Object.fromEntries(Object.entries(b.values).filter(([k]) => /^(tournament|table|time)\./.test(k)));
    const settings = svc.settings.resolve([{ scope: 'table', values: picked }]);
    return reply.send(estimateTournament(settings, { players: Math.min(b.players, Number(settings['table.seats'])) }));
  }));
  // ---------- plánované turnaje ----------

  const ruleSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('once'), at: z.number() }),
    z.object({ type: z.literal('daily'), time: z.string(), everyDays: z.number().int(), from: z.string() }),
    z.object({ type: z.literal('weekly'), weekday: z.number().int().min(1).max(7), time: z.string(), everyWeeks: z.number().int(), from: z.string() }),
    z.object({ type: z.literal('monthlyNth'), weekday: z.number().int().min(1).max(7), nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]), time: z.string(), from: z.string() }),
  ]);
  const settingsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
  app.post('/api/tournaments/schedule', guard(async (req, reply) => {
    const b = z.object({ name: z.string().max(100), templateId: z.string().max(60), settings: settingsSchema.optional(), startAt: z.number() }).parse(req.body);
    return reply.send(await svc.tournaments().scheduleTournament(need(req).id, b, meta(req)));
  }));
  app.get('/api/schedules', guard(async (req, reply) => {
    viewer(req);
    return reply.send(await svc.scheduler().list());
  }));
  app.post('/api/schedules', guard(async (req, reply) => {
    const b = z.object({ name: z.string().max(100), templateId: z.string().max(60), settings: settingsSchema.optional(), rule: ruleSchema, seriesId: z.string().max(60).nullable().optional() }).parse(req.body);
    return reply.send(await svc.scheduler().createSchedule(need(req).id, b as never));
  }));
  app.patch('/api/schedules/:id', guard(async (req, reply) => {
    const b = z.object({ enabled: z.boolean() }).parse(req.body);
    await svc.scheduler().setEnabled(need(req).id, tid(req), b.enabled);
    return reply.send({ ok: true });
  }));
  app.delete('/api/schedules/:id', guard(async (req, reply) => {
    await svc.scheduler().deleteSchedule(need(req).id, tid(req));
    return reply.send({ ok: true });
  }));

  // Kalendář nadcházejících turnajů (přihlášený uživatel) a export do kalendáře (podepsaný odkaz bez přihlášení).
  const upcoming = (userId: string | null) =>
    svc
      .tournaments()
      .scheduled()
      .filter((t) => t.status === 'registering')
      .map((t) => {
        const m = svc.tournaments();
        const s = m.settingsOf(t.id)!;
        const registered = userId ? m.registeredUsers(t.id).includes(userId) : false;
        return {
          id: t.id,
          name: m.row(t.id)!.name,
          startAt: t.sched.startAt,
          opensAt: t.sched.opensAt,
          registrationOpen: m.registrationOpen(t.id),
          postponed: t.sched.postponed,
          players: m.registeredUsers(t.id).length,
          seats: Number(s['table.seats']),
          minPlayers: Number(s['tournament.minPlayers']),
          buyIn: Number(s['tournament.buyIn']),
          fee: Number(s['tournament.fee']),
          startingStack: Number(s['tournament.startingStack']),
          durationMin: Number(s['tournament.targetMinutes']),
          registered,
          scheduleId: t.sched.scheduleId,
          seriesId: t.sched.seriesId,
        };
      })
      .sort((a, b) => a.startAt - b.startAt);
  app.get('/api/calendar', guard(async (req, reply) => {
    const u = viewer(req);
    const base = String(svc.settings.resolve()['system.publicUrl'] ?? '').replace(/\/$/, '');
    return reply.send({ events: upcoming(u.id), icsUrl: `${base}/api/calendar/${u.id}/${calendarToken(svc.calendarSecret(), u.id)}.ics` });
  }));
  app.get('/api/calendar/:userId/:file', async (req, reply) => {
    const { userId, file } = req.params as { userId: string; file: string };
    const token = file.replace(/\.ics$/, '');
    if (!id.safeParse(userId).success || !checkCalendarToken(svc.calendarSecret(), userId, token)) return reply.status(404).send({ code: 'NOT_FOUND' });
    const base = String(svc.settings.resolve()['system.publicUrl'] ?? '').replace(/\/$/, '');
    const ics = buildIcs(
      upcoming(userId).map((e) => ({
        id: e.id,
        name: e.name,
        startAt: e.startAt,
        durationMin: e.durationMin,
        registered: e.registered,
        url: `${base}/turnaj/${e.id}`,
        description: `Buy-in ${e.buyIn}${e.fee ? ` + poplatek ${e.fee}` : ''}, startovní stack ${e.startingStack}. Přihlášeno ${e.players}/${e.seats}.`,
      })),
      'KoronaBar Poker: turnaje',
    );
    return reply.header('content-type', 'text/calendar; charset=utf-8').send(ics);
  });

  // Série a ligy.
  const seriesConfig = z.object({ mode: z.enum(['table', 'linear']), table: z.array(z.number()).max(100), participation: z.number(), linearFactor: z.number(), bestOf: z.number().int(), finalTopN: z.number().int() }).partial();
  app.get('/api/series', guard(async (req, reply) => {
    viewer(req);
    return reply.send(await svc.series().list());
  }));
  app.post('/api/series', guard(async (req, reply) => {
    const b = z.object({ name: z.string().max(100), config: seriesConfig.optional() }).parse(req.body);
    return reply.send(await svc.series().create(need(req).id, b));
  }));
  app.get('/api/series/:id', guard(async (req, reply) => {
    viewer(req);
    return reply.send(await svc.series().view(tid(req)));
  }));
  app.patch('/api/series/:id', guard(async (req, reply) => {
    const b = z.object({ name: z.string().max(100).optional(), config: seriesConfig.optional() }).parse(req.body);
    await svc.series().update(need(req).id, tid(req), b);
    return reply.send({ ok: true });
  }));
  app.delete('/api/series/:id', guard(async (req, reply) => {
    await svc.series().remove(need(req).id, tid(req));
    return reply.send({ ok: true });
  }));
  app.post('/api/series/:id/final', guard(async (req, reply) => {
    const b = z.object({ templateId: z.string().max(60), settings: settingsSchema.optional(), startAt: z.number() }).parse(req.body);
    return reply.send(await svc.series().createFinal(need(req).id, tid(req), b));
  }));

  // Upozornění v aplikaci.
  // ---------- motivy vzhledu ----------
  const themeGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof ThemeError)) throw e;
        reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400).send({ error: 'THEME_' + e.code, params: e.params });
      }
    });
  app.get('/api/themes', themeGuard(async (req, reply) => reply.send(await svc.themes().list(need(req).id))));
  app.get('/api/themes/pending', themeGuard(async (req, reply) => reply.send({ themes: await svc.themes().pending(need(req).id) })));
  app.put('/api/themes/locked', themeGuard(async (req, reply) => reply.send({ locked: await svc.themes().setLocked(need(req).id, ((req.body ?? {}) as { tokens?: string[] }).tokens ?? []) })));
  app.post('/api/themes', themeGuard(async (req, reply) => reply.send(await svc.themes().create(need(req).id, (req.body ?? {}) as never))));
  app.patch('/api/themes/:id', themeGuard(async (req, reply) => reply.send(await svc.themes().update(need(req).id, (req.params as { id: string }).id, (req.body ?? {}) as never))));
  app.delete('/api/themes/:id', themeGuard(async (req, reply) => {
    await svc.themes().remove(need(req).id, (req.params as { id: string }).id);
    reply.send({ ok: true });
  }));
  app.post('/api/themes/:id/share', themeGuard(async (req, reply) => reply.send({ status: await svc.themes().share(need(req).id, (req.params as { id: string }).id, ((req.body ?? {}) as { on?: boolean }).on !== false) })));
  app.post('/api/themes/:id/review', themeGuard(async (req, reply) => {
    await svc.themes().review(need(req).id, (req.params as { id: string }).id, ((req.body ?? {}) as { approve?: boolean }).approve === true);
    reply.send({ ok: true });
  }));
  app.post('/api/themes/:id/hide', themeGuard(async (req, reply) => {
    await svc.themes().hide(need(req).id, (req.params as { id: string }).id, ((req.body ?? {}) as { hidden?: boolean }).hidden !== false);
    reply.send({ ok: true });
  }));

  // ---------- živá hra ----------
  const liveGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof LiveError)) throw e;
        reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400).send({ error: 'LIVE_' + e.code, params: e.params });
      }
    });
  const liveId = (req: FastifyRequest) => (req.params as { id: string }).id;
  const liveUser = z.object({ userId: z.string().uuid() });
  app.post('/api/tournaments/:id/live/register', guard(async (req, reply) => {
    const b = liveUser.parse(req.body);
    await svc.tournaments().liveRegister(need(req).id, tid(req), b.userId, meta(req));
    return reply.send({ ok: true });
  }));
  app.post('/api/tournaments/:id/live/unregister', guard(async (req, reply) => {
    const b = liveUser.parse(req.body);
    await svc.tournaments().liveUnregister(need(req).id, tid(req), b.userId, meta(req));
    return reply.send({ ok: true });
  }));
  app.post('/api/tournaments/:id/live/buy', guard(async (req, reply) => {
    const b = liveUser.extend({ what: z.enum(['rebuy', 'addon', 'reenter']) }).parse(req.body);
    await svc.tournaments().liveBuy(need(req).id, tid(req), b.userId, b.what, meta(req));
    return reply.send({ ok: true });
  }));
  app.post('/api/tournaments/:id/live/move', guard(async (req, reply) => {
    const b = liveUser.extend({ toTable: z.string().min(1).max(100) }).parse(req.body);
    await svc.tournaments().liveMove(need(req).id, tid(req), b.userId, b.toTable, meta(req));
    return reply.send({ ok: true });
  }));
  app.post('/api/tournaments/:id/live/eliminate', guard(async (req, reply) => {
    const b = z.object({ victimId: z.string().uuid(), killers: z.array(z.string().uuid()).max(20).default([]) }).parse(req.body);
    await svc.tournaments().liveEliminate(need(req).id, tid(req), b.victimId, b.killers, meta(req));
    return reply.send({ ok: true });
  }));
  app.get('/api/live-cash', liveGuard(async (req, reply) => {
    viewer(req);
    reply.send({ games: await svc.liveCash().list() });
  }));
  app.post('/api/live-cash', liveGuard(async (req, reply) => {
    const b = z.object({ name: z.string().max(100) }).parse(req.body);
    reply.send(await svc.liveCash().create(need(req).id, b.name, meta(req)));
  }));
  app.get('/api/live-cash/:id', liveGuard(async (req, reply) => reply.send(await svc.liveCash().view(liveId(req), viewer(req).id))));
  app.post('/api/live-cash/:id/buyin', liveGuard(async (req, reply) => {
    const b = liveUser.extend({ amount: z.number().int() }).parse(req.body);
    await svc.liveCash().buyIn(need(req).id, liveId(req), b.userId, b.amount, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/live-cash/:id/fee', liveGuard(async (req, reply) => {
    const b = liveUser.extend({ amount: z.number().int() }).parse(req.body);
    await svc.liveCash().timeFee(need(req).id, liveId(req), b.userId, b.amount, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/live-cash/:id/cashout', liveGuard(async (req, reply) => {
    const b = liveUser.extend({ amount: z.number().int() }).parse(req.body);
    await svc.liveCash().cashOut(need(req).id, liveId(req), b.userId, b.amount, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/live-cash/:id/close', liveGuard(async (req, reply) => {
    await svc.liveCash().close(need(req).id, liveId(req), meta(req));
    reply.send({ ok: true });
  }));

  // ---------- TV režim ----------
  const tvGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof TvError)) throw e;
        reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : e.code === 'UNAUTHORIZED' ? 401 : e.code === 'RATE' ? 429 : 400).send({ error: 'TV_' + e.code, params: e.params });
      }
    });
  const bearer = (req: FastifyRequest) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined;
  app.post('/api/tv/pair', tvGuard(async (req, reply) => {
    const b = z.object({ code: z.string().max(40) }).parse(req.body);
    reply.header('cache-control', 'no-store').send(await svc.tv().pair(b.code, req.ip));
  }));
  app.get('/api/tv/snapshot', tvGuard(async (req, reply) => {
    reply.header('cache-control', 'no-store').send(await svc.tv().snapshot(bearer(req)));
  }));
  app.get('/api/tv/devices', tvGuard(async (req, reply) => reply.send({ devices: await svc.tv().devices(need(req).id), layouts: await svc.tv().layouts() })));
  app.post('/api/tv/devices', tvGuard(async (req, reply) => {
    const b = z.object({ name: z.string().max(100), layoutId: z.string().max(30).nullable().optional() }).parse(req.body);
    reply.send(await svc.tv().createDevice(need(req).id, b.name, b.layoutId ?? null, meta(req)));
  }));
  app.post('/api/tv/devices/:id/code', tvGuard(async (req, reply) => reply.send(await svc.tv().renewCode(need(req).id, (req.params as { id: string }).id, meta(req)))));
  app.patch('/api/tv/devices/:id', tvGuard(async (req, reply) => {
    const b = z.object({ name: z.string().max(100).optional(), layoutId: z.string().max(30).nullable().optional() }).parse(req.body);
    await svc.tv().updateDevice(need(req).id, (req.params as { id: string }).id, b, meta(req));
    reply.send({ ok: true });
  }));
  app.delete('/api/tv/devices/:id', tvGuard(async (req, reply) => {
    await svc.tv().removeDevice(need(req).id, (req.params as { id: string }).id, meta(req));
    reply.send({ ok: true });
  }));
  app.put('/api/tv/layouts', tvGuard(async (req, reply) => {
    const b = z.object({ layouts: z.array(z.unknown()).max(20) }).parse(req.body);
    reply.send({ layouts: await svc.tv().saveLayouts(need(req).id, b.layouts, meta(req)) });
  }));

  // ---------- hlasatel ----------
  const annGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof AnnouncerError)) throw e;
        reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : e.code === 'SOURCE_FAILED' ? 502 : 400).send({ error: 'ANNOUNCER_' + e.code, params: e.params });
      }
    });
  const sendAudio = (reply: FastifyReply, a: { data: Buffer; mime: string }) => reply.header('content-type', a.mime).header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff').send(a.data);
  app.get('/api/announcer/audio/:id', annGuard(async (req, reply) => {
    viewer(req);
    sendAudio(reply, await svc.announcer().audioFor((req.params as { id: string }).id, 'user'));
  }));
  app.get('/api/tv/announcer/audio/:id', annGuard(async (req, reply) => {
    try {
      await svc.tv().authenticate(bearer(req));
    } catch (e) {
      if (e instanceof TvError) return reply.code(401).send({ error: 'TV_' + e.code });
      throw e;
    }
    sendAudio(reply, await svc.announcer().audioFor((req.params as { id: string }).id, 'tv'));
  }));
  app.get('/api/tv/sounds/:id', annGuard(async (req, reply) => {
    try {
      await svc.tv().authenticate(bearer(req));
    } catch (e) {
      if (e instanceof TvError) return reply.code(401).send({ error: 'TV_' + e.code });
      throw e;
    }
    const id = (req.params as { id: string }).id;
    if (!svc.tv().jingleSoundAllowed(id)) return reply.code(404).send({ error: 'SOUND_NOT_FOUND' });
    sendAudio(reply, await svc.sounds().rawAudio(id));
  }));
  app.get('/api/announcer/config', annGuard(async (req, reply) => reply.send(await svc.announcer().config(need(req).id))));
  app.put('/api/announcer/templates', annGuard(async (req, reply) => {
    const b = z.object({ templates: z.record(z.string(), z.unknown()) }).parse(req.body);
    await svc.announcer().saveTemplates(need(req).id, b.templates, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/announcer/sample', annGuard(async (req, reply) => {
    const b = z.object({ source: z.enum(['piper', 'google']), text: z.string().max(200) }).parse(req.body);
    sendAudio(reply, await svc.announcer().sample(need(req).id, b.source, b.text));
  }));
  app.post('/api/announcer/connection', annGuard(async (req, reply) => {
    const b = z.object({ source: z.enum(['piper', 'google']) }).parse(req.body);
    reply.send(await svc.announcer().testConnection(need(req).id, b.source));
  }));
  app.post('/api/announcer/pregenerate', annGuard(async (req, reply) => reply.send(await svc.announcer().pregenerate(need(req).id))));
  app.post('/api/announcer/cache/clear', annGuard(async (req, reply) => {
    await svc.announcer().clearCache(need(req).id, meta(req));
    reply.send({ ok: true });
  }));

  // ---------- AI asistent ----------
  const asGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof AssistantError)) throw e;
        const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : e.code === 'LIMIT_USER' || e.code === 'LIMIT_GLOBAL' ? 429 : e.code === 'PROVIDER' ? 502 : e.code === 'DISABLED' ? 503 : 400;
        reply.code(status).send({ code: 'ASSISTANT_' + e.code, params: e.params });
      }
    });
  const aid = (req: FastifyRequest) => (req.params as { id: string }).id;
  const akey = (req: FastifyRequest) => (req.params as { key: string }).key;
  app.get('/api/assistant/status', asGuard(async (req, reply) => reply.send(await svc.assistant().status(need(req).id))));
  app.get('/api/assistant/history', asGuard(async (req, reply) => reply.send({ messages: await svc.assistant().history(need(req).id) })));
  app.delete('/api/assistant/history', asGuard(async (req, reply) => {
    await svc.assistant().clearHistory(need(req).id);
    reply.send({ ok: true });
  }));
  app.post('/api/assistant/chat', asGuard(async (req, reply) => {
    const b = z.object({ text: z.string().max(4000), context: z.string().max(20).optional(), targetId: z.string().max(80).optional() }).parse(req.body);
    reply.send(await svc.assistant().chat(need(req).id, b));
  }));
  app.get('/api/assistant/proposals', asGuard(async (req, reply) => reply.send({ proposals: await svc.assistant().proposals(need(req).id, (req.query as { status?: string }).status) })));
  app.post('/api/assistant/proposals/:id/confirm', asGuard(async (req, reply) => {
    const b = z.object({ edits: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() }).parse(req.body ?? {});
    reply.send(await svc.assistant().apply(need(req).id, aid(req), b.edits));
  }));
  app.post('/api/assistant/proposals/:id/reject', asGuard(async (req, reply) => reply.send(await svc.assistant().reject(need(req).id, aid(req)))));
  app.get('/api/assistant/prompts', asGuard(async (req, reply) => reply.send({ prompts: await svc.assistant().prompts(need(req).id) })));
  app.put('/api/assistant/prompts/:key', asGuard(async (req, reply) => {
    const b = z.object({ text: z.string().max(9000) }).parse(req.body);
    reply.send(await svc.assistant().savePrompt(need(req).id, akey(req), b.text, meta(req)));
  }));
  app.get('/api/assistant/prompts/:key/versions', asGuard(async (req, reply) => reply.send({ versions: await svc.assistant().promptVersions(need(req).id, akey(req)) })));
  app.post('/api/assistant/prompts/:key/revert', asGuard(async (req, reply) => {
    const b = z.object({ version: z.number().int() }).parse(req.body);
    reply.send(await svc.assistant().revertPrompt(need(req).id, akey(req), b.version, meta(req)));
  }));
  app.post('/api/assistant/prompts/reset', asGuard(async (req, reply) => {
    const b = z.object({ key: z.string().max(60).nullable().optional() }).parse(req.body ?? {});
    await svc.assistant().resetPrompt(need(req).id, b.key ?? null, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/assistant/sandbox', asGuard(async (req, reply) => {
    const b = z.object({ text: z.string().max(4000), context: z.string().max(20).optional(), targetId: z.string().max(80).optional() }).parse(req.body);
    reply.send(await svc.assistant().sandbox(need(req).id, b));
  }));
  app.post('/api/assistant/test', asGuard(async (req, reply) => reply.send(await svc.assistant().test(need(req).id))));
  // MCP server: JSON-RPC přes HTTP, jen s tokenem s rozsahem mcp
  app.get('/api/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ code: 'METHOD_NOT_ALLOWED' }));
  app.post('/api/mcp', async (req, reply) => {
    const auth = req.apiAuth;
    if (!auth) return reply.code(401).send({ code: 'API_UNAUTHORIZED' });
    if (!svc.settings.resolve()['mcp.enabled'] || !svc.settings.resolve()['assistant.enabled']) return reply.code(503).send({ code: 'MCP_DISABLED' });
    if (!auth.scopes.includes('mcp')) return reply.code(403).send({ code: 'API_SCOPE', params: { scope: 'mcp' } });
    const msgs = Array.isArray(req.body) ? req.body : [req.body];
    const out = [];
    for (const m of msgs) {
      const r = await svc.mcp().handle(auth, (m ?? {}) as never);
      if (r) out.push(r);
    }
    if (out.length === 0) return reply.code(202).send();
    return reply.send(Array.isArray(req.body) ? out : out[0]);
  });
  app.get('/api/mcp/tools', asGuard(async (req, reply) => {
    const u = need(req);
    if (!svc.perms.can(u.id, 'asistent.spravovat').allowed) throw new AssistantError('FORBIDDEN');
    reply.send({ enabled: !!svc.settings.resolve()['mcp.enabled'], tools: await svc.mcp().tools(u.id, true) });
  }));
  app.get('/api/mcp/log', asGuard(async (req, reply) => {
    if (!svc.perms.can(need(req).id, 'asistent.spravovat').allowed) throw new AssistantError('FORBIDDEN');
    reply.send({ calls: await svc.mcp().log() });
  }));
  app.get('/api/assistant/usage', asGuard(async (req, reply) => reply.send(await svc.assistant().usage(need(req).id))));

  // ---------- osobní tokeny a REST API ----------
  const tokGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : e.code === 'DISABLED' ? 503 : 400).send({ code: 'API_' + e.code, params: e.params });
      }
    });
  app.get('/api/tokens', tokGuard(async (req, reply) => reply.send(await svc.apiTokens().list(need(req).id))));
  app.get('/api/tokens/all', tokGuard(async (req, reply) => reply.send({ tokens: await svc.apiTokens().listAll(need(req).id) })));
  app.post('/api/tokens', tokGuard(async (req, reply) => {
    const b = z.object({ name: z.string().max(80), scopes: z.array(z.string()).max(20), expiresInDays: z.number() }).parse(req.body);
    reply.send(await svc.apiTokens().create(need(req).id, b, meta(req)));
  }));
  app.delete('/api/tokens/:id', tokGuard(async (req, reply) => {
    await svc.apiTokens().revoke(need(req).id, (req.params as { id: string }).id, meta(req));
    reply.send({ ok: true });
  }));

  app.get('/api/v1/openapi.json', async (_req, reply) => reply.send(buildOpenApi(svc.publicUrl() || '/')));
  const v1 = (scope: ApiScope | null, fn: (req: FastifyRequest, reply: FastifyReply, userId: string) => Promise<unknown>) =>
    guard(async (req, reply) => {
      const auth = req.apiAuth;
      if (!auth) return reply.code(401).send({ code: 'API_UNAUTHORIZED' });
      if (scope && !auth.scopes.includes(scope)) return reply.code(403).send({ code: 'API_SCOPE', params: { scope } });
      return fn(req, reply, auth.user.id);
    });
  const apiMeta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] ?? null, source: 'api' as const });
  app.get('/api/v1/me', v1(null, async (req, reply) => reply.send({ id: req.apiAuth!.user.id, nickname: req.apiAuth!.user.nickname, scopes: req.apiAuth!.scopes })));
  app.get('/api/v1/tournaments', v1('tournaments:read', async (_req, reply) => reply.send({ tournaments: await svc.tournaments().lobby() })));
  app.get('/api/v1/tournaments/:id', v1('tournaments:read', async (req, reply, uid) => reply.send(await svc.tournaments().view((req.params as { id: string }).id, uid))));
  app.post('/api/v1/tournaments/:id/register', v1('tournaments:register', async (req, reply, uid) => {
    await svc.tournaments().register(uid, (req.params as { id: string }).id, apiMeta(req));
    reply.send({ ok: true });
  }));
  app.get('/api/v1/seasons', v1('stats:read', async (_req, reply) => reply.send({ seasons: await svc.stats().seasons() })));
  app.get('/api/v1/leaderboard', v1('stats:read', async (req, reply) => {
    try {
      reply.send({ rows: await svc.stats().leaderboard(await svc.stats().range((req.query as { season?: string }).season)) });
    } catch (e) {
      statsErr(e, reply);
    }
  }));
  app.get('/api/v1/stats/me', v1('stats:read', async (req, reply, uid) => {
    try {
      reply.send(await svc.stats().playerStats(uid, uid, await svc.stats().range((req.query as { season?: string }).season)));
    } catch (e) {
      statsErr(e, reply);
    }
  }));
  app.get('/api/v1/wallet', v1('wallet:read', async (_req, reply, uid) => reply.send({ balance: svc.ledger.balance(ledgerAccounts.wallet(uid)) })));
  app.get('/api/v1/evenings', v1('evenings:read', async (_req, reply, uid) => reply.send(await svc.evenings().list(uid))));
  app.post('/api/v1/chat/messages', v1('chat:write', async (req, reply, uid) => {
    const b = z.object({ text: z.string().min(1).max(2000) }).parse(req.body);
    await svc.chatPost(uid, b.text);
    reply.send({ ok: true });
  }));

  // ---------- napojení ven ----------
  const intGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof IntegrationError)) throw e;
        reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400).send({ code: 'INTEGRATION_' + e.code, params: e.params });
      }
    });
  const endpointBody = z.object({ name: z.string().max(80), url: z.string().max(500), events: z.array(z.string()).optional(), enabled: z.boolean().optional() });
  app.get('/api/integrations', intGuard(async (req, reply) => reply.send(await svc.integrations().overview(need(req).id))));
  app.get('/api/integrations/webhooks', intGuard(async (req, reply) => reply.send({ endpoints: await svc.integrations().endpoints(need(req).id) })));
  app.post('/api/integrations/webhooks', intGuard(async (req, reply) => reply.send({ id: await svc.integrations().createEndpoint(need(req).id, endpointBody.parse(req.body), meta(req)) })));
  app.patch('/api/integrations/webhooks/:id', intGuard(async (req, reply) => {
    await svc.integrations().updateEndpoint(need(req).id, (req.params as { id: string }).id, endpointBody.partial().parse(req.body), meta(req));
    reply.send({ ok: true });
  }));
  app.delete('/api/integrations/webhooks/:id', intGuard(async (req, reply) => {
    await svc.integrations().removeEndpoint(need(req).id, (req.params as { id: string }).id, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/integrations/webhooks/:id/test', intGuard(async (req, reply) => reply.send(await svc.integrations().testEndpoint(need(req).id, (req.params as { id: string }).id))));
  app.post('/api/integrations/mqtt/test', intGuard(async (req, reply) => reply.send(await svc.integrations().testMqtt(need(req).id))));
  app.post('/api/integrations/discord/test', intGuard(async (req, reply) => reply.send(await svc.integrations().testDiscord(need(req).id))));
  app.put('/api/integrations/events/:channel', intGuard(async (req, reply) => {
    const u = need(req);
    const channel = (req.params as { channel: string }).channel;
    if (channel !== 'mqtt' && channel !== 'discord') throw new IntegrationError('INVALID', { field: 'channel' });
    const body = z.object({ events: z.array(z.string()) }).parse(req.body);
    svc.integrations(); // oprávnění ověří přehled
    await svc.integrations().overview(u.id);
    await svc.settings.set(u.id, 'global', '', channel === 'mqtt' ? 'integrations.mqttEvents' : 'integrations.discordEvents', svc.integrations().parseSelection(body.events));
    reply.send({ ok: true });
  }));
  app.get('/api/integrations/deliveries', intGuard(async (req, reply) => {
    const q = req.query as { status?: string; limit?: string };
    reply.send({ deliveries: await svc.integrations().deliveries(need(req).id, { status: q.status, limit: q.limit ? Number(q.limit) : undefined }) });
  }));
  app.post('/api/integrations/deliveries/:id/retry', intGuard(async (req, reply) => {
    await svc.integrations().retry(need(req).id, (req.params as { id: string }).id, meta(req));
    reply.send({ ok: true });
  }));

  // ---------- kosmetika a obchod ----------
  const cosGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof CosmeticError)) throw e;
        reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400).send({ code: 'COSMETIC_' + e.code, params: e.params });
      }
    });
  const ckey = (req: FastifyRequest) => (req.params as { key: string }).key;
  const cosmeticBody = z.object({
    kind: z.string(),
    name: z.string().max(60),
    description: z.string().max(300).optional(),
    look: z.object({ color: z.string().optional(), style: z.string().optional(), icon: z.string().max(16).optional(), extra: z.number().optional() }),
    acquire: z.object({ level: z.number().optional(), rank: z.string().optional(), achievement: z.string().optional(), season: z.object({ place: z.number(), seasonId: z.string().optional() }).optional() }),
    price: z.number().nullable(),
    availableFrom: z.number().nullable().optional(),
    availableUntil: z.number().nullable().optional(),
    enabled: z.boolean().optional(),
  });
  app.get('/api/cosmetics', cosGuard(async (req, reply) => reply.send(await svc.cosmetics().catalog(need(req).id))));
  app.get('/api/cosmetics/looks', cosGuard(async (req, reply) => {
    need(req);
    const ids = String((req.query as { ids?: string }).ids ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x));
    reply.send({ looks: await svc.cosmetics().looks(ids) });
  }));
  app.get('/api/cosmetics/table', cosGuard(async (req, reply) => reply.send(await svc.cosmetics().mineTable(need(req).id))));
  app.post('/api/cosmetics', cosGuard(async (req, reply) => {
    const key = await svc.cosmetics().create(need(req).id, cosmeticBody.parse(req.body) as never, meta(req));
    reply.send({ key });
  }));
  app.patch('/api/cosmetics/:key', cosGuard(async (req, reply) => {
    await svc.cosmetics().update(need(req).id, ckey(req), cosmeticBody.partial().parse(req.body) as never, meta(req));
    reply.send({ ok: true });
  }));
  app.delete('/api/cosmetics/:key', cosGuard(async (req, reply) => reply.send(await svc.cosmetics().remove(need(req).id, ckey(req), meta(req)))));
  app.post('/api/cosmetics/:key/buy', cosGuard(async (req, reply) => {
    await svc.cosmetics().buy(need(req).id, ckey(req), meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/cosmetics/:key/equip', cosGuard(async (req, reply) => {
    const b = z.object({ on: z.boolean() }).parse(req.body);
    await svc.cosmetics().equip(need(req).id, ckey(req), b.on);
    reply.send({ ok: true });
  }));
  app.post('/api/cosmetics/:key/grant', cosGuard(async (req, reply) => {
    const b = z.object({ userId: z.string().uuid() }).parse(req.body);
    await svc.cosmetics().grant(need(req).id, b.userId, ckey(req), meta(req));
    reply.send({ ok: true });
  }));

  // ---------- sdílené handy ----------
  const handGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof HandError)) throw e;
        reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400).send({ code: 'HAND_' + e.code, params: e.params });
      }
    });
  const sid = (req: FastifyRequest) => (req.params as { id: string }).id;
  app.post('/api/stats/hands/:id/share', handGuard(async (req, reply) => {
    const b = z.object({ reveal: z.boolean().optional(), poll: z.boolean().optional(), channelId: z.string().uuid().nullable().optional() }).parse(req.body ?? {});
    reply.send(await svc.sharedHands().share(need(req).id, sid(req), b, meta(req)));
  }));
  app.get('/api/shared-hands/:id', handGuard(async (req, reply) => reply.send(await svc.sharedHands().view(need(req).id, sid(req)))));
  app.patch('/api/shared-hands/:id', handGuard(async (req, reply) => {
    const b = z.object({ reveal: z.boolean() }).parse(req.body);
    await svc.sharedHands().setReveal(need(req).id, sid(req), b.reveal, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/shared-hands/:id/comments', handGuard(async (req, reply) => {
    const b = z.object({ body: z.string().max(1000) }).parse(req.body);
    reply.send(await svc.sharedHands().comment(need(req).id, sid(req), b.body, meta(req)));
  }));
  app.delete('/api/shared-hands/comments/:id', handGuard(async (req, reply) => {
    await svc.sharedHands().deleteComment(need(req).id, sid(req), meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/shared-hands/:id/reactions', handGuard(async (req, reply) => {
    const b = z.object({ emoji: z.string().max(8) }).parse(req.body);
    await svc.sharedHands().react(need(req).id, sid(req), b.emoji);
    reply.send({ ok: true });
  }));

  // ---------- osobní limity a poznámky o hráčích ----------
  const limGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof LimitsError)) throw e;
        reply.code(400).send({ code: 'LIMITS_' + e.code, params: e.params });
      }
    });
  app.get('/api/limits/me', limGuard(async (req, reply) => reply.send(await svc.limits().view(need(req).id))));
  app.put('/api/limits/me', limGuard(async (req, reply) => {
    const b = z.object({ limits: z.record(z.string(), z.number()) }).parse(req.body);
    reply.send(await svc.limits().set(need(req).id, b.limits, meta(req)));
  }));
  app.post('/api/limits/break', limGuard(async (req, reply) => {
    const b = z.object({ hours: z.number() }).parse(req.body);
    reply.send({ until: await svc.limits().setBreak(need(req).id, b.hours, meta(req)) });
  }));
  const noteGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof NotesError)) throw e;
        reply.code(e.code === 'NOT_FOUND' ? 404 : 400).send({ code: 'NOTE_' + e.code, params: e.params });
      }
    });
  app.get('/api/notes', noteGuard(async (req, reply) => reply.send(await svc.notes().list(need(req).id))));
  app.get('/api/notes/export.json', noteGuard(async (req, reply) => {
    reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', 'attachment; filename="poznamky.json"').send(await svc.notes().export(need(req).id));
  }));
  app.put('/api/notes/player/:id', noteGuard(async (req, reply) => {
    const b = z.object({ note: z.string().max(2000).optional(), labelId: z.string().uuid().nullable().optional() }).parse(req.body);
    await svc.notes().put(need(req).id, (req.params as { id: string }).id, b.note ?? '', b.labelId ?? null, meta(req));
    reply.send({ ok: true });
  }));
  app.delete('/api/notes/player/:id', noteGuard(async (req, reply) => {
    await svc.notes().remove(need(req).id, (req.params as { id: string }).id);
    reply.send({ ok: true });
  }));
  app.post('/api/notes/labels', noteGuard(async (req, reply) => {
    const b = z.object({ name: z.string().max(60), color: z.string().max(20) }).parse(req.body);
    reply.send(await svc.notes().createLabel(need(req).id, b.name, b.color));
  }));
  app.patch('/api/notes/labels/:id', noteGuard(async (req, reply) => {
    const b = z.object({ name: z.string().max(60), color: z.string().max(20) }).parse(req.body);
    await svc.notes().updateLabel(need(req).id, (req.params as { id: string }).id, b.name, b.color);
    reply.send({ ok: true });
  }));
  app.delete('/api/notes/labels/:id', noteGuard(async (req, reply) => {
    await svc.notes().deleteLabel(need(req).id, (req.params as { id: string }).id);
    reply.send({ ok: true });
  }));

  // ---------- sázky a odměny na hlavu ----------
  const betGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof BetError)) throw e;
        reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400).send({ error: 'BET_' + e.code, params: e.params });
      }
    });
  const betId = (req: FastifyRequest) => (req.params as { id: string }).id;
  app.get('/api/tournaments/:id/bets', betGuard(async (req, reply) => {
    const u = viewer(req);
    reply.send({ ...(await svc.bets().list(u.id, tid(req))), headBounties: await svc.headBounties().list(tid(req)) });
  }));
  app.post('/api/tournaments/:id/bets', betGuard(async (req, reply) => {
    const b = z
      .object({ subject: z.string().max(20), params: z.object({ userId: z.string().max(80).optional(), a: z.string().max(80).optional(), b: z.string().max(80).optional(), place: z.number().int().optional(), text: z.string().max(300).optional() }).default({}), title: z.string().max(120).optional(), direct: z.boolean().optional(), close: z.string().max(20).optional(), side: z.string().max(5).optional(), amount: z.number().int().optional() })
      .parse(req.body);
    reply.send(await svc.bets().create(need(req).id, { tournamentId: tid(req), ...b }, meta(req)));
  }));
  app.post('/api/bets/:id/stake', betGuard(async (req, reply) => {
    const b = z.object({ side: z.string().max(5), amount: z.number().int() }).parse(req.body);
    await svc.bets().stake(need(req).id, betId(req), b.side, b.amount, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/bets/:id/close', betGuard(async (req, reply) => {
    await svc.bets().close(need(req).id, betId(req), meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/bets/:id/cancel', betGuard(async (req, reply) => {
    await svc.bets().cancel(need(req).id, betId(req), meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/bets/:id/result', betGuard(async (req, reply) => {
    const b = z.object({ outcome: z.string().max(5) }).parse(req.body);
    await svc.bets().propose(need(req).id, betId(req), b.outcome, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/bets/:id/respond', betGuard(async (req, reply) => {
    const b = z.object({ accept: z.boolean() }).parse(req.body);
    await svc.bets().respond(need(req).id, betId(req), b.accept, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/bets/:id/decide', betGuard(async (req, reply) => {
    const b = z.object({ outcome: z.string().max(5) }).parse(req.body);
    await svc.bets().decide(need(req).id, betId(req), b.outcome, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/tournaments/:id/bounties', betGuard(async (req, reply) => {
    const b = z.object({ targetId: z.string().uuid(), amount: z.number().int() }).parse(req.body);
    reply.send(await svc.headBounties().post(need(req).id, tid(req), b.targetId, b.amount, meta(req)));
  }));

  // ---------- herní večery ----------
  const evGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof EveningError)) throw e;
        reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400).send({ error: 'EVENING_' + e.code, params: e.params });
      }
    });
  const eid = (req: FastifyRequest) => (req.params as { id: string }).id;
  const gameBody = z.object({ kind: z.enum(['tournament', 'live_cash', 'cash']), ref: z.string().min(1).max(80) });
  app.get('/api/evenings', evGuard(async (req, reply) => {
    viewer(req);
    reply.send(await svc.evenings().list(need(req).id));
  }));
  app.post('/api/evenings', evGuard(async (req, reply) => {
    const b = z.object({ name: z.string().max(100) }).parse(req.body);
    reply.send(await svc.evenings().create(need(req).id, b.name, meta(req)));
  }));
  app.get('/api/evenings/:id', evGuard(async (req, reply) => reply.send(await svc.evenings().view(eid(req), viewer(req).id))));
  app.get('/api/evenings/:id/export.csv', evGuard(async (req, reply) => {
    const csv = await svc.evenings().csv(viewer(req).id, eid(req));
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="vecer.csv"').send(csv);
  }));
  app.get('/api/evenings/:id/candidates', evGuard(async (req, reply) => reply.send(await svc.evenings().candidates(need(req).id, eid(req)))));
  app.patch('/api/evenings/:id', evGuard(async (req, reply) => {
    const b = z.object({ name: z.string().max(100) }).parse(req.body);
    await svc.evenings().rename(need(req).id, eid(req), b.name, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/evenings/:id/games', evGuard(async (req, reply) => {
    const b = gameBody.parse(req.body);
    await svc.evenings().addGame(need(req).id, eid(req), b.kind, b.ref, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/evenings/:id/games/remove', evGuard(async (req, reply) => {
    const b = gameBody.parse(req.body);
    await svc.evenings().removeGame(need(req).id, eid(req), b.kind, b.ref, meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/evenings/:id/close', evGuard(async (req, reply) => {
    await svc.evenings().close(need(req).id, eid(req), meta(req));
    reply.send({ ok: true });
  }));
  app.post('/api/evenings/:id/hand-vote', evGuard(async (req, reply) => {
    reply.send({ started: await svc.evenings().startHandVote(need(req).id, eid(req)) });
  }));
  app.post('/api/evenings/:id/recompute', evGuard(async (req, reply) => {
    await svc.evenings().recompute(need(req).id, eid(req), meta(req));
    reply.send({ ok: true });
  }));
  app.delete('/api/evenings/:id', evGuard(async (req, reply) => {
    await svc.evenings().remove(need(req).id, eid(req), meta(req));
    reply.send({ ok: true });
  }));

  const assetGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof AssetError)) throw e;
        reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400).send({ error: 'ASSET_' + e.code, params: e.params });
      }
    });
  app.get('/api/theme-assets', assetGuard(async (req, reply) => reply.send({ assets: await svc.themeAssets().list(need(req).id) })));
  app.post('/api/theme-assets', { bodyLimit: 16 * 1024 * 1024 }, assetGuard(async (req, reply) => {
    const b = (req.body ?? {}) as { kind?: string; data?: string };
    reply.send(await svc.themeAssets().upload(need(req).id, String(b.kind ?? ''), Buffer.from(String(b.data ?? ''), 'base64')));
  }));
  app.get('/api/theme-assets/:id', assetGuard(async (req, reply) => {
    need(req);
    const a = await svc.themeAssets().read((req.params as { id: string }).id);
    reply
      .header('content-type', a.mime)
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(a.data);
  }));
  app.delete('/api/theme-assets/:id', assetGuard(async (req, reply) => {
    await svc.themeAssets().remove(need(req).id, (req.params as { id: string }).id);
    reply.send({ ok: true });
  }));

  // ---------- ankety ----------
  const pollGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        if (!(e instanceof PollError)) throw e;
        const status = e.code === 'FORBIDDEN' || e.code === 'NOT_ELIGIBLE' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
        reply.code(status).send({ error: 'POLL_' + e.code, params: e.params });
      }
    });
  const pid = (req: FastifyRequest) => (req.params as { id: string }).id;
  app.get('/api/polls', pollGuard(async (req, reply) => {
    const scope = (req.query as { scope?: string }).scope;
    reply.send({ polls: await svc.polls().list(need(req).id, scope === 'closed' || scope === 'mine' ? scope : 'open') });
  }));
  app.post('/api/polls', pollGuard(async (req, reply) => reply.send({ id: await svc.polls().create(need(req).id, (req.body ?? {}) as never) })));
  app.post('/api/polls/preview', pollGuard(async (req, reply) => reply.send(await svc.polls().preview(need(req).id, ((req.body ?? {}) as { condition?: unknown }).condition))));
  app.get('/api/poll-templates', pollGuard(async (req, reply) => reply.send({ templates: await svc.polls().templates(need(req).id) })));
  app.post('/api/poll-templates', pollGuard(async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; data?: Record<string, unknown> };
    reply.send({ id: await svc.polls().saveTemplate(need(req).id, String(b.name ?? ''), b.data ?? {}) });
  }));
  app.delete('/api/poll-templates/:id', pollGuard(async (req, reply) => {
    await svc.polls().deleteTemplate(need(req).id, pid(req));
    reply.send({ ok: true });
  }));
  app.get('/api/polls/:id', pollGuard(async (req, reply) => reply.send(await svc.polls().view(need(req).id, pid(req)))));
  app.patch('/api/polls/:id', pollGuard(async (req, reply) => {
    await svc.polls().update(need(req).id, pid(req), (req.body ?? {}) as never);
    reply.send({ ok: true });
  }));
  app.post('/api/polls/:id/vote', pollGuard(async (req, reply) => {
    await svc.polls().vote(need(req).id, pid(req), ((req.body ?? {}) as { answer?: unknown }).answer as never);
    reply.send({ ok: true });
  }));
  app.post('/api/polls/:id/option', pollGuard(async (req, reply) => {
    const b = (req.body ?? {}) as { label?: string; emoji?: string };
    reply.send({ id: await svc.polls().addOption(need(req).id, pid(req), String(b.label ?? ''), b.emoji) });
  }));
  app.post('/api/polls/:id/close', pollGuard(async (req, reply) => {
    await svc.polls().close(need(req).id, pid(req));
    reply.send({ ok: true });
  }));
  app.post('/api/polls/:id/cancel', pollGuard(async (req, reply) => {
    await svc.polls().cancel(need(req).id, pid(req));
    reply.send({ ok: true });
  }));
  app.post('/api/polls/:id/extend', pollGuard(async (req, reply) => {
    await svc.polls().extend(need(req).id, pid(req), Number(((req.body ?? {}) as { minutes?: number }).minutes));
    reply.send({ ok: true });
  }));
  app.post('/api/polls/:id/tie', pollGuard(async (req, reply) => {
    await svc.polls().decideTie(need(req).id, pid(req), String(((req.body ?? {}) as { option?: string }).option ?? ''));
    reply.send({ ok: true });
  }));
  app.post('/api/polls/:id/action', pollGuard(async (req, reply) => {
    await svc.polls().confirmAction(need(req).id, pid(req), ((req.body ?? {}) as { approve?: boolean }).approve === true);
    reply.send({ ok: true });
  }));
  app.post('/api/polls/:id/pin', pollGuard(async (req, reply) => {
    await svc.polls().pin(need(req).id, pid(req), ((req.body ?? {}) as { on?: boolean }).on !== false);
    reply.send({ ok: true });
  }));
  app.get('/api/polls/:id/export.csv', pollGuard(async (req, reply) => {
    const csv = await svc.polls().exportCsv(need(req).id, pid(req));
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="anketa.csv"').send(csv);
  }));

  // ---------- herní rating ----------
  const ratingOn = (reply: FastifyReply) => {
    if (svc.settings.resolve()['rating.enabled']) return true;
    reply.code(404).send({ error: 'NOT_FOUND' });
    return false;
  };
  const scopeOf = (v: unknown) => (v === 'cash' ? 'cash' : 'tournament') as 'cash' | 'tournament';
  app.get('/api/rating/me', guard(async (req, reply) => {
    const u = need(req);
    if (!ratingOn(reply)) return;
    reply.send(await svc.rating().ratingOf(u.id));
  }));
  app.get('/api/rating/player/:id', guard(async (req, reply) => {
    need(req);
    if (!ratingOn(reply)) return;
    reply.send(await svc.rating().ratingOf((req.params as { id: string }).id));
  }));
  app.get('/api/rating/history', guard(async (req, reply) => {
    const u = need(req);
    if (!ratingOn(reply)) return;
    const q = req.query as { scope?: string; limit?: string };
    reply.send({ events: await svc.rating().history(u.id, scopeOf(q.scope), q.limit ? Number(q.limit) : 30) });
  }));
  app.get('/api/rating/leaderboard', guard(async (req, reply) => {
    need(req);
    if (!ratingOn(reply)) return;
    reply.send({ rows: await svc.rating().leaderboard(scopeOf((req.query as { scope?: string }).scope)) });
  }));
  app.get('/api/rating/season', guard(async (req, reply) => {
    need(req);
    if (!ratingOn(reply)) return;
    const q = req.query as { scope?: string; season?: string };
    const seasons = await svc.stats().seasons();
    const now = Date.now();
    const season = q.season && q.season !== 'current' ? seasons.find((x) => x.id === q.season) : seasons.find((x) => x.startsAt <= now && (x.endsAt === null || x.endsAt > now));
    if (!season) return reply.send({ season: null, seasons, rows: [] });
    reply.send({ season, seasons, rows: await svc.rating().seasonLeaderboard(scopeOf(q.scope), new Date(season.startsAt), season.endsAt ? new Date(season.endsAt) : null) });
  }));
  app.get('/api/rating/duel', guard(async (req, reply) => {
    const u = need(req);
    if (!ratingOn(reply)) return;
    const q = req.query as { a?: string; b?: string };
    reply.send(await svc.rating().duel(q.a === 'me' || !q.a ? u.id : q.a, String(q.b ?? '')));
  }));
  app.get('/api/rating/flags', guard(async (req, reply) => {
    try {
      reply.send({ flags: await svc.rating().flags(need(req).id) });
    } catch (e) {
      if (!(e instanceof RatingError)) throw e;
      reply.code(403).send({ error: 'FORBIDDEN' });
    }
  }));
  app.post('/api/rating/flags/:id', guard(async (req, reply) => {
    const b = (req.body ?? {}) as { status?: string; note?: string };
    if (b.status !== 'dismissed' && b.status !== 'confirmed') return reply.code(400).send({ error: 'INVALID_MESSAGE' });
    try {
      await svc.rating().resolveFlag(need(req).id, Number((req.params as { id: string }).id), b.status, b.note);
      reply.send({ ok: true });
    } catch (e) {
      if (!(e instanceof RatingError)) throw e;
      reply.code(403).send({ error: 'FORBIDDEN' });
    }
  }));
  app.post('/api/rating/reset', guard(async (req, reply) => {
    try {
      reply.send({ players: await svc.rating().softResetAll(need(req).id) });
    } catch (e) {
      if (!(e instanceof RatingError)) throw e;
      reply.code(403).send({ error: 'FORBIDDEN' });
    }
  }));

  // ---------- zpětný přepočet XP a ratingu ----------
  app.post('/api/recompute', guard(async (req, reply) => {
    const u = need(req);
    if (!svc.perms.can(u.id, 'statistiky.sezony').allowed) return reply.code(403).send({ error: 'FORBIDDEN' });
    const b = (req.body ?? {}) as { what?: string; preview?: boolean };
    const preview = b.preview !== false;
    const out: { xp?: unknown; rating?: unknown; preview: boolean } = { preview };
    if (b.what === 'xp' || b.what === 'both') out.xp = await svc.progress().recompute(preview);
    if (b.what === 'rating' || b.what === 'both') out.rating = await svc.rating().recompute(u.id, preview);
    reply.send(out);
  }));

  // ---------- úspěchy ----------
  const achErr = (e: unknown, reply: FastifyReply) => {
    if (!(e instanceof AchievementError)) throw e;
    return reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400).send({ error: e.code === 'FORBIDDEN' || e.code === 'NOT_FOUND' ? e.code : 'ACHIEVEMENT_' + e.code, params: e.params });
  };
  app.get('/api/achievements', guard(async (req, reply) => reply.send({ achievements: await svc.achievements().list(need(req).id) })));
  app.get('/api/achievements/all', guard(async (req, reply) => {
    const u = need(req);
    if (!svc.perms.can(u.id, 'statistiky.uspechy').allowed) return reply.code(403).send({ error: 'FORBIDDEN' });
    reply.send({ achievements: await svc.achievements().list(u.id, { all: true }) });
  }));
  app.post('/api/achievements', guard(async (req, reply) => {
    try {
      reply.send({ key: await svc.achievements().create(need(req).id, (req.body ?? {}) as never) });
    } catch (e) {
      achErr(e, reply);
    }
  }));
  app.patch('/api/achievements/:key', guard(async (req, reply) => {
    try {
      await svc.achievements().update(need(req).id, (req.params as { key: string }).key, (req.body ?? {}) as never);
      reply.send({ ok: true });
    } catch (e) {
      achErr(e, reply);
    }
  }));
  app.delete('/api/achievements/:key', guard(async (req, reply) => {
    try {
      await svc.achievements().remove(need(req).id, (req.params as { key: string }).key);
      reply.send({ ok: true });
    } catch (e) {
      achErr(e, reply);
    }
  }));

  // ---------- postup: XP a hodnosti ----------
  app.get('/api/progress/me', guard(async (req, reply) => {
    const u = need(req);
    reply.send({ ...(await svc.progress().progressOf(u.id)), recent: await svc.progress().recent(u.id) });
  }));
  app.get('/api/progress/table', guard(async (req, reply) => {
    need(req);
    reply.send({ levels: svc.progress().table(Number((req.query as { count?: string }).count) || 30) });
  }));
  app.get('/api/progress/brief', guard(async (req, reply) => {
    need(req);
    const ids = String((req.query as { ids?: string }).ids ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x));
    reply.send({ players: await svc.progress().brief(ids) });
  }));

  // ---------- obrázky v chatu ----------
  app.post('/api/chat/images', { bodyLimit: 32 * 1024 * 1024 }, guard(async (req, reply) => {
    const u = need(req);
    try {
      const data = Buffer.from(String(((req.body ?? {}) as { data?: string }).data ?? ''), 'base64');
      reply.send(await svc.chatImages().upload(u.id, data));
    } catch (e) {
      if (!(e instanceof ChatError)) throw e;
      reply.code(400).send({ error: 'CHAT_' + e.code, params: e.params });
    }
  }));
  app.get('/api/chat/images/:id', guard(async (req, reply) => {
    try {
      const img = await svc.chatImages().read(need(req).id, (req.params as { id: string }).id);
      reply
        .header('content-type', img.mime)
        .header('cache-control', 'private, max-age=86400')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send(img.data);
    } catch (e) {
      if (!(e instanceof ChatError)) throw e;
      reply.code(404).send({ error: 'NOT_FOUND' });
    }
  }));

  // ---------- zvukové emotikony ----------
  const soundErr = (e: unknown, reply: FastifyReply) => {
    if (!(e instanceof SoundError)) throw e;
    const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : e.code === 'TOOL_MISSING' ? 503 : 400;
    return reply.code(status).send({ error: e.code === 'FORBIDDEN' || e.code === 'NOT_FOUND' ? e.code : 'SOUND_' + e.code, params: e.params });
  };
  const soundGuard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    guard(async (req, reply) => {
      try {
        await fn(req, reply);
      } catch (e) {
        soundErr(e, reply);
      }
    });
  const UPLOAD = { bodyLimit: 32 * 1024 * 1024 };
  const parseUpload = (req: FastifyRequest) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return {
      name: String(b.name ?? ''),
      shortcut: String(b.shortcut ?? ''),
      emoji: typeof b.emoji === 'string' ? b.emoji : undefined,
      category: typeof b.category === 'string' ? b.category : undefined,
      data: Buffer.from(String(b.data ?? ''), 'base64'),
      ext: String(b.ext ?? ''),
      startMs: typeof b.startMs === 'number' ? b.startMs : undefined,
      endMs: typeof b.endMs === 'number' ? b.endMs : undefined,
      share: b.share === true,
    };
  };
  app.get('/api/sounds', soundGuard(async (req, reply) => {
    const u = need(req);
    reply.send({ sounds: await svc.sounds().list(u.id), mutes: await svc.sounds().mutes(u.id), usage: await svc.sounds().usage() });
  }));
  app.get('/api/sounds/pending', soundGuard(async (req, reply) => reply.send({ sounds: await svc.sounds().pending(need(req).id) })));
  app.get('/api/sounds/all', soundGuard(async (req, reply) => reply.send({ sounds: await svc.sounds().all(need(req).id) })));
  app.post('/api/sounds/check', { ...UPLOAD }, soundGuard(async (req, reply) => reply.send(await svc.sounds().check(need(req).id, parseUpload(req)))));
  app.post('/api/sounds', { ...UPLOAD }, soundGuard(async (req, reply) => reply.send(await svc.sounds().upload(need(req).id, parseUpload(req)))));
  app.get('/api/sounds/:id/audio', soundGuard(async (req, reply) => {
    const a = await svc.sounds().audio(need(req).id, (req.params as { id: string }).id);
    reply.header('content-type', a.mime).header('cache-control', 'private, max-age=3600').send(a.data);
  }));
  app.patch('/api/sounds/:id', soundGuard(async (req, reply) => {
    await svc.sounds().update(need(req).id, (req.params as { id: string }).id, (req.body ?? {}) as never);
    reply.send({ ok: true });
  }));
  app.delete('/api/sounds/:id', soundGuard(async (req, reply) => {
    await svc.sounds().remove(need(req).id, (req.params as { id: string }).id);
    reply.send({ ok: true });
  }));
  app.post('/api/sounds/:id/share', soundGuard(async (req, reply) => {
    const on = ((req.body ?? {}) as { on?: boolean }).on !== false;
    reply.send({ status: await svc.sounds().share(need(req).id, (req.params as { id: string }).id, on) });
  }));
  app.post('/api/sounds/:id/review', soundGuard(async (req, reply) => {
    await svc.sounds().review(need(req).id, (req.params as { id: string }).id, ((req.body ?? {}) as { approve?: boolean }).approve === true);
    reply.send({ ok: true });
  }));
  app.post('/api/sounds/:id/hide', soundGuard(async (req, reply) => {
    await svc.sounds().hide(need(req).id, (req.params as { id: string }).id, ((req.body ?? {}) as { hidden?: boolean }).hidden !== false);
    reply.send({ ok: true });
  }));
  app.post('/api/sounds/:id/favorite', soundGuard(async (req, reply) => {
    await svc.sounds().favorite(need(req).id, (req.params as { id: string }).id, ((req.body ?? {}) as { on?: boolean }).on !== false);
    reply.send({ ok: true });
  }));
  app.post('/api/sounds/mute', soundGuard(async (req, reply) => {
    const b = (req.body ?? {}) as { kind?: string; target?: string; on?: boolean };
    await svc.sounds().setMute(need(req).id, String(b.kind ?? ''), String(b.target ?? ''), b.on !== false);
    reply.send({ ok: true });
  }));
  app.post('/api/sounds/:id/play', soundGuard(async (req, reply) => {
    const b = (req.body ?? {}) as { kind?: string; id?: string };
    if ((b.kind !== 'table' && b.kind !== 'channel') || !b.id) return reply.code(400).send({ error: 'SOUND_BAD_STATE' });
    reply.send(await svc.sounds().play(need(req).id, (req.params as { id: string }).id, { kind: b.kind, id: String(b.id) }));
  }));

  // ---------- statistiky ----------
  const statsErr = (e: unknown, reply: FastifyReply) => {
    if (!(e instanceof StatsError)) throw e;
    return reply.code(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400).send({ error: e.code });
  };
  app.get('/api/stats/seasons', guard(async (req, reply) => {
    need(req);
    reply.send({ seasons: await svc.stats().seasons() });
  }));
  app.post('/api/stats/seasons', guard(async (req, reply) => {
    try {
      reply.send({ id: await svc.stats().createSeason(need(req).id, (req.body ?? {}) as never) });
    } catch (e) {
      statsErr(e, reply);
    }
  }));
  app.patch('/api/stats/seasons/:id', guard(async (req, reply) => {
    try {
      await svc.stats().updateSeason(need(req).id, (req.params as { id: string }).id, (req.body ?? {}) as never);
      reply.send({ ok: true });
    } catch (e) {
      statsErr(e, reply);
    }
  }));
  app.delete('/api/stats/seasons/:id', guard(async (req, reply) => {
    try {
      await svc.stats().deleteSeason(need(req).id, (req.params as { id: string }).id);
      reply.send({ ok: true });
    } catch (e) {
      statsErr(e, reply);
    }
  }));
  app.get('/api/stats/leaderboard', guard(async (req, reply) => {
    need(req);
    try {
      const range = await svc.stats().range((req.query as { season?: string }).season);
      reply.send({ rows: await svc.stats().leaderboard(range) });
    } catch (e) {
      statsErr(e, reply);
    }
  }));
  app.get('/api/stats/player/:id', guard(async (req, reply) => {
    const u = need(req);
    try {
      const id = (req.params as { id: string }).id === 'me' ? u.id : (req.params as { id: string }).id;
      const range = await svc.stats().range((req.query as { season?: string }).season);
      reply.send(await svc.stats().playerStats(u.id, id, range));
    } catch (e) {
      statsErr(e, reply);
    }
  }));
  app.get('/api/stats/hands', guard(async (req, reply) => {
    const q = req.query as { limit?: string; before?: string; tableId?: string };
    reply.send({ hands: await svc.stats().myHands(need(req).id, { limit: q.limit ? Number(q.limit) : undefined, before: q.before ? Number(q.before) : undefined, tableId: q.tableId?.slice(0, 80) || undefined }) });
  }));
  app.get('/api/stats/hands/:id', guard(async (req, reply) => {
    try {
      reply.send(await svc.stats().handDetail(need(req).id, (req.params as { id: string }).id));
    } catch (e) {
      statsErr(e, reply);
    }
  }));
  app.get('/api/push/key', guard(async (req, reply) => {
    need(req);
    reply.send({ publicKey: await svc.push().publicKey() });
  }));
  app.get('/api/push/status', guard(async (req, reply) => reply.send({ devices: await svc.push().count(need(req).id) })));
  app.post('/api/push/subscribe', guard(async (req, reply) => {
    const u = need(req);
    try {
      await svc.push().subscribe(u.id, (req.body ?? {}) as never, String(req.headers['user-agent'] ?? ''));
    } catch {
      return reply.code(400).send({ error: 'INVALID_SUBSCRIPTION' });
    }
    reply.send({ ok: true });
  }));
  app.post('/api/push/unsubscribe', guard(async (req, reply) => {
    await svc.push().unsubscribe(need(req).id, String(((req.body ?? {}) as { endpoint?: string }).endpoint ?? ''));
    reply.send({ ok: true });
  }));
  app.get('/api/notifications', guard(async (req, reply) => reply.send(await svc.notifications().list(need(req).id))));
  app.post('/api/notifications/read', guard(async (req, reply) => {
    await svc.notifications().markRead(need(req).id);
    return reply.send({ ok: true });
  }));

  app.get('/api/tournaments/:id', guard(async (req, reply) => reply.send(await svc.tournaments().view(tid(req), viewer(req).id))));
  app.get('/api/tournaments/:id/details', guard(async (req, reply) => {
    const u = viewer(req);
    const m = svc.tournaments();
    const row = m.row(tid(req));
    const tour = m.get(tid(req));
    if (!row || !tour) return reply.status(404).send({ code: 'TOURNAMENT_NOT_FOUND' });
    const actor = svc.tables().actors.get(row.id);
    const owner = row.ownerId === u.id && svc.perms.can(u.id, 'turnaj.upravit_vlastni').allowed;
    return reply.send({
      id: row.id,
      name: row.name,
      ownerId: row.ownerId,
      templateId: row.templateId,
      values: m.settingsOf(row.id),
      overrides: row.settings,
      pending: m.pendingChanges(row.id),
      started: tour.state().status !== 'registering',
      handInProgress: m.tableIdsOf(row.id).some((tableId) => svc.tables().actors.get(tableId)?.handInProgress()),
      canEdit: owner || svc.perms.can(u.id, 'turnaj.upravit_vse').allowed,
      isAdmin: svc.perms.can(u.id, 'nastaveni.globalni').allowed,
    });
  }));
  app.patch('/api/tournaments/:id', guard(async (req, reply) => {
    const b = z.object({ settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }).parse(req.body);
    return reply.send(await svc.tournaments().updateSettings(need(req).id, tid(req), b.settings, meta(req)));
  }));
  const tAction = (path: string, fn: (m: TournamentManager, userId: string, id: string, req: FastifyRequest) => Promise<void>) =>
    app.post(`/api/tournaments/:id/${path}`, guard(async (req, reply) => {
      await fn(svc.tournaments(), need(req).id, tid(req), req);
      return reply.send({ ok: true });
    }));
  app.get('/api/tournaments/:id/deal', guard(async (req, reply) => reply.send({ ...svc.tournaments().dealOptions(tid(req), viewer(req).id), serverTime: Date.now() })));
  app.post('/api/tournaments/:id/deal/propose', guard(async (req, reply) => {
    const b = z.object({ method: z.enum(['icm', 'chipChop', 'equal', 'custom']), keep: z.number().int().min(0).optional(), custom: z.record(z.string(), z.number().int()).optional() }).parse(req.body);
    await svc.tournaments().proposeDeal(need(req).id, tid(req), b, meta(req));
    return reply.send({ ok: true });
  }));
  app.post('/api/tournaments/:id/deal/vote', guard(async (req, reply) => {
    const b = z.object({ yes: z.boolean() }).parse(req.body);
    await svc.tournaments().voteDeal(need(req).id, tid(req), b.yes);
    return reply.send({ ok: true });
  }));
  app.post('/api/tournaments/:id/pause-vote', guard(async (req, reply) => {
    try {
      return reply.send({ id: await svc.polls().startPauseVote(need(req).id, tid(req)) });
    } catch (e) {
      if (!(e instanceof PollError)) throw e;
      const code = e.code === 'LIMIT' ? (e.params.reason === 'running' ? 'POLL_PAUSE_RUNNING' : 'POLL_PAUSE_COOLDOWN') : e.code === 'NOT_ELIGIBLE' ? 'POLL_PAUSE_NOT_ALLOWED' : 'POLL_' + e.code;
      return reply.code(e.code === 'NOT_FOUND' ? 404 : 400).send({ error: code, params: e.params });
    }
  }));
  tAction('deal/cancel', (m, u, id) => m.cancelDeal(u, id));
  tAction('register', (m, u, id, req) => m.register(u, id, meta(req)));
  tAction('unregister', (m, u, id, req) => m.unregister(u, id, meta(req)));
  tAction('rebuy', (m, u, id) => m.rebuy(u, id));
  tAction('addon', (m, u, id) => m.addon(u, id));
  tAction('reenter', (m, u, id) => m.reenter(u, id));
  tAction('start', (m, u, id, req) => m.start(u, id, meta(req)));
  tAction('pause', (m, u, id, req) => m.pause(u, id, false, meta(req)));
  tAction('resume', (m, u, id, req) => m.pause(u, id, true, meta(req)));
  tAction('cancel', (m, u, id, req) => m.cancel(u, id, meta(req)));
  app.delete('/api/tournaments/:id', guard(async (req, reply) => {
    await svc.tournaments().deleteFromHistory(need(req).id, tid(req), meta(req));
    return reply.send({ ok: true });
  }));

  // ---------- peněženka, žádosti, schvalování, vyúčtování ----------

  app.get('/api/wallet/history', guard(async (req, reply) => reply.send(await svc.wallet.walletHistory(need(req).id))));
  const amount = z.number().int().positive();
  app.post('/api/admin/wallet/topup', guard(async (req, reply) => {
    const b = z.object({ userId: id, amount, reason: z.string().min(1).max(300) }).parse(req.body);
    const r = await svc.wallet.topUp(need(req).id, b.userId, b.amount, b.reason, meta(req));
    if (r.done) svc.hooks.pushWallet(b.userId);
    return reply.send(r);
  }));
  app.post('/api/admin/wallet/debit', guard(async (req, reply) => {
    const b = z.object({ userId: id, amount, reason: z.string().min(1).max(300) }).parse(req.body);
    const r = await svc.wallet.debit(need(req).id, b.userId, b.amount, b.reason, meta(req));
    if (r.done) svc.hooks.pushWallet(b.userId);
    return reply.send(r);
  }));
  app.post('/api/admin/wallet/adjust', guard(async (req, reply) => {
    const b = z.object({ entries: z.array(z.object({ account: z.string().min(1).max(100), amount: z.number().int() })).min(2).max(20), reason: z.string().min(1).max(300) }).parse(req.body);
    return reply.send(await svc.wallet.adjust(need(req).id, b.entries, b.reason, meta(req)));
  }));
  app.get('/api/admin/ledger', guard(async (req, reply) => reply.send(await svc.wallet.ledgerOverview(need(req).id))));
  app.get('/api/admin/house', guard(async (req, reply) => reply.send(svc.wallet.houseBalances(need(req).id))));

  app.post('/api/requests', guard(async (req, reply) => {
    const b = z.object({ kind: z.enum(['dobiti', 'role', 'schvaleni']), amount: amount.optional(), message: z.string().max(500).optional() }).parse(req.body);
    return reply.send({ id: await svc.wallet.createRequest(need(req).id, b) });
  }));
  app.get('/api/requests', guard(async (req, reply) => {
    const q = z.object({ all: z.enum(['1', 'true']).optional(), status: z.string().optional() }).parse(req.query);
    return reply.send(await svc.wallet.listRequests(need(req).id, { all: !!q.all, status: q.status }));
  }));
  app.post('/api/requests/:id/decide', guard(async (req, reply) => {
    const b = z.object({ approve: z.boolean(), note: z.string().max(300).nullable().optional() }).parse(req.body);
    const rid = id.parse((req.params as { id: string }).id);
    const r = await svc.wallet.decideRequest(need(req).id, rid, b.approve, b.note ?? null, meta(req));
    const [row] = await svc.db.select({ userId: schema.userRequests.userId }).from(schema.userRequests).where(eq(schema.userRequests.id, rid));
    if (row) svc.hooks.pushWallet(row.userId);
    return reply.send(r);
  }));
  app.delete('/api/requests/:id', guard(async (req, reply) => {
    await svc.wallet.cancelRequest(need(req).id, id.parse((req.params as { id: string }).id));
    return reply.send({ ok: true });
  }));

  app.get('/api/approvals', guard(async (req, reply) => reply.send(await svc.approvals.list(need(req).id, (req.query as { status?: string }).status))));
  app.post('/api/approvals/:id/decide', guard(async (req, reply) => {
    const b = z.object({ approve: z.boolean(), note: z.string().max(300).nullable().optional() }).parse(req.body);
    const r = await svc.approvals.decide(need(req).id, id.parse((req.params as { id: string }).id), b.approve, b.note ?? null, meta(req));
    return reply.send(r);
  }));

  app.get('/api/settlement', guard(async (req, reply) => {
    const q = z.object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() }).parse(req.query);
    const now = Date.now();
    const seated = svc.tables().list().flatMap((row) => (svc.tables().get(row.id)?.playersSeated() ?? []).map((s) => ({ userId: s.userId, tableId: row.id, chips: s.chips + s.pendingChips })));
    const r = await svc.wallet.settlementForPeriod(need(req).id, q.from ?? now - 24 * 3600_000, q.to ?? now, seated);
    return reply.send({ ...r, note: 'Převody jsou jen ve virtuální měně, která nemá žádnou peněžní hodnotu.' });
  }));

  app.get('/api/tables/:id/settlement', guard(async (req, reply) => {
    const tableId = (req.params as { id: string }).id;
    const actor = svc.tables().get(tableId);
    const seated = actor ? actor.playersSeated().map((s) => ({ userId: s.userId, chips: s.chips + s.pendingChips })) : [];
    const r = await svc.wallet.settlementForTable(need(req).id, tableId, seated);
    return reply.send({ ...r, note: 'Převody jsou jen ve virtuální měně, která nemá žádnou peněžní hodnotu.' });
  }));

  void eq;
}
