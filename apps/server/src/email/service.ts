import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { EMAIL_TEMPLATES, emailTemplateDef, type PermissionChecker, type SettingValues } from '@kb/shared';
import type { AccountNotifier } from '../auth/accounts.js';
import type { AuditService } from '../auth/audit.js';
import { schema, type Db } from '../db/index.js';
import type { SecretStore } from '../secrets/store.js';

export interface MailMessage {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
}
export interface MailTransport {
  send(msg: MailMessage): Promise<void>;
}
export interface SmtpConfig {
  host: string;
  port: number;
  security: 'none' | 'starttls' | 'tls';
  user: string;
  pass: string;
}

export function createSmtpTransport(cfg: SmtpConfig): MailTransport {
  const t = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.security === 'tls',
    requireTLS: cfg.security === 'starttls',
    ignoreTLS: cfg.security === 'none',
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return { send: async (m) => void (await t.sendMail(m)) };
}

export interface MailErrorInfo {
  /** Překladový klíč srozumitelné hlášky. */
  key: string;
  params?: Record<string, unknown>;
  detail: string;
}

/** Převede chybu SMTP na srozumitelnou českou hlášku (klíč překladu). */
export function translateSmtpError(e: unknown, cfg?: { host?: string; port?: number }): MailErrorInfo {
  const err = e as { code?: string; responseCode?: number; message?: string; response?: string };
  const detail = String(err?.message ?? e).slice(0, 300);
  const params = { host: cfg?.host ?? '', port: cfg?.port ?? '' };
  if (err?.code === 'EAUTH' || err?.responseCode === 535 || /Username and Password not accepted|Invalid login/i.test(detail)) return { key: 'email.error.auth', params, detail };
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNECTION', 'EDNS', 'ECONNRESET'].includes(err?.code ?? '')) return { key: 'email.error.connect', params, detail };
  if (err?.code === 'ESOCKET' || /wrong version number|SSL|TLS/i.test(detail)) return { key: 'email.error.tls', params, detail };
  if (err?.responseCode === 550 || err?.responseCode === 553 || err?.responseCode === 554) return { key: 'email.error.rejected', params, detail };
  if (err?.responseCode === 421 || err?.responseCode === 450 || err?.responseCode === 452) return { key: 'email.error.limit', params, detail };
  return { key: 'email.error.unknown', params, detail };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Dosadí {proměnné}; v HTML se hodnoty escapují. Neznámé proměnné zůstanou beze změny. */
export function fillTemplate(text: string, vars: Record<string, string | number>, html = false): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? (html ? escapeHtml(String(vars[k])) : String(vars[k])) : m));
}

/** Proměnné použité v šabloně, které nepatří mezi povolené (kvůli kontrole při ukládání). */
export function unknownVariables(text: string, allowed: string[]): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].filter((k) => !allowed.includes(k));
}

function textToHtml(text: string): string {
  const body = escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>\n');
  return `<!doctype html><html><body style="font-family:sans-serif;line-height:1.5">${body}</body></html>`;
}

export interface EmailDeps {
  db: Db;
  audit: AuditService;
  perms: PermissionChecker;
  secrets: SecretStore;
  settings: () => SettingValues;
  now?: () => Date;
  /** Továrna na transport (testy dodají falešný). */
  transport?: (cfg: SmtpConfig) => MailTransport;
}

export class EmailService {
  private now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(private deps: EmailDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ---------- šablony ----------

  async template(key: string) {
    const def = emailTemplateDef(key);
    if (!def) throw new Error(`Neznámá šablona ${key}`);
    const [row] = await this.deps.db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.key, key));
    return { key, variables: def.variables, security: def.security, subject: row?.subject ?? def.subject, bodyText: row?.bodyText ?? def.text, bodyHtml: row?.bodyHtml ?? null, custom: !!row };
  }

  async listTemplates() {
    return Promise.all(EMAIL_TEMPLATES.map((t) => this.template(t.key)));
  }

  async saveTemplate(actorId: string, key: string, input: { subject: string; bodyText: string; bodyHtml?: string | null }, meta: { ip?: string | null } = {}): Promise<{ unknown: string[] }> {
    if (!this.deps.perms.can(actorId, 'email.sablony').allowed) throw new Error('FORBIDDEN');
    const def = emailTemplateDef(key);
    if (!def) throw new Error('NOT_FOUND');
    const unknown = unknownVariables(`${input.subject}\n${input.bodyText}\n${input.bodyHtml ?? ''}`, def.variables);
    if (unknown.length) return { unknown };
    await this.deps.db
      .insert(schema.emailTemplates)
      .values({ key, subject: input.subject, bodyText: input.bodyText, bodyHtml: input.bodyHtml ?? null, updatedBy: actorId })
      .onConflictDoUpdate({ target: schema.emailTemplates.key, set: { subject: input.subject, bodyText: input.bodyText, bodyHtml: input.bodyHtml ?? null, updatedBy: actorId, updatedAt: new Date() } });
    await this.deps.audit.log({ actorId, action: 'email.sablona_zmenena', targetType: 'email_template', targetId: key, after: { subject: input.subject }, ip: meta.ip });
    return { unknown: [] };
  }

  async resetTemplate(actorId: string, key: string): Promise<void> {
    if (!this.deps.perms.can(actorId, 'email.sablony').allowed) throw new Error('FORBIDDEN');
    await this.deps.db.delete(schema.emailTemplates).where(eq(schema.emailTemplates.key, key));
    await this.deps.audit.log({ actorId, action: 'email.sablona_reset', targetType: 'email_template', targetId: key });
  }

  async render(key: string, vars: Record<string, string | number>, override?: { subject: string; bodyText: string; bodyHtml?: string | null }) {
    const t = override ? { subject: override.subject, bodyText: override.bodyText, bodyHtml: override.bodyHtml ?? null } : await this.template(key);
    const text = fillTemplate(t.bodyText, vars);
    return {
      subject: fillTemplate(t.subject, vars),
      text,
      html: t.bodyHtml ? fillTemplate(t.bodyHtml, vars, true) : textToHtml(text),
    };
  }

  // ---------- fronta ----------

  async enqueue(key: string, to: string, vars: Record<string, string | number>): Promise<number> {
    const def = emailTemplateDef(key);
    if (!def) throw new Error(`Neznámá šablona ${key}`);
    const r = await this.render(key, vars);
    const [row] = await this.deps.db
      .insert(schema.emailQueue)
      .values({ toAddress: to, kind: key, subject: r.subject, bodyText: r.text, bodyHtml: r.html, priority: def.security ? 'security' : 'normal', nextAttemptAt: this.now() })
      .returning({ id: schema.emailQueue.id });
    return row!.id;
  }

  async stats() {
    const rows = await this.deps.db.select({ status: schema.emailQueue.status, n: sql<number>`count(*)::int` }).from(schema.emailQueue).groupBy(schema.emailQueue.status);
    return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  }

  async list(actorId: string, limit = 100) {
    if (!this.deps.perms.can(actorId, 'email.fronta').allowed) throw new Error('FORBIDDEN');
    return this.deps.db.select().from(schema.emailQueue).orderBy(desc(schema.emailQueue.id)).limit(Math.min(limit, 500));
  }

  private async smtpConfig(): Promise<{ cfg: SmtpConfig; from: string; replyTo?: string } | null> {
    const s = this.deps.settings();
    if (!s['email.enabled']) return null;
    const pass = await this.deps.secrets.reveal('smtp.password');
    const host = String(s['email.smtpHost']);
    if (!host || !pass) return null;
    const name = String(s['email.fromName']);
    const addr = String(s['email.fromAddress']) || String(s['email.smtpUser']);
    return {
      cfg: { host, port: Number(s['email.smtpPort']), security: s['email.smtpSecurity'] as SmtpConfig['security'], user: String(s['email.smtpUser']), pass },
      from: name ? `"${name.replace(/"/g, '')}" <${addr}>` : addr,
      replyTo: String(s['email.replyTo']) || undefined,
    };
  }

  private makeTransport(cfg: SmtpConfig): MailTransport {
    return (this.deps.transport ?? createSmtpTransport)(cfg);
  }

  /**
   * Jeden průchod frontou. Bezpečnostní e-maily se posílají vždy, ostatní jen do denního limitu
   * (zbytek se odloží). Při chybě se zkusí znovu s rostoucí prodlevou, po vyčerpání pokusů je chyba trvalá.
   */
  async processQueue(): Promise<{ sent: number; failed: number; deferred: number; skipped: boolean }> {
    if (this.processing) return { sent: 0, failed: 0, deferred: 0, skipped: true };
    this.processing = true;
    try {
      const conf = await this.smtpConfig();
      if (!conf) return { sent: 0, failed: 0, deferred: 0, skipped: true };
      const transport = this.makeTransport(conf.cfg);
      const s = this.deps.settings();
      const limit = Number(s['email.dailyLimit']);
      const maxAttempts = Number(s['email.maxAttempts']);
      const now = this.now();
      const dayAgo = new Date(now.getTime() - 24 * 3600_000);
      const [sentRow] = await this.deps.db.select({ n: sql<number>`count(*)::int` }).from(schema.emailQueue).where(and(eq(schema.emailQueue.status, 'sent'), gte(schema.emailQueue.sentAt, dayAgo)));
      let sentToday = sentRow?.n ?? 0;
      const due = await this.deps.db
        .select()
        .from(schema.emailQueue)
        .where(and(eq(schema.emailQueue.status, 'pending'), lte(schema.emailQueue.nextAttemptAt, now)))
        // bezpečnostní napřed, pak podle stáří
        .orderBy(sql`case when ${schema.emailQueue.priority} = 'security' then 0 else 1 end`, asc(schema.emailQueue.id))
        .limit(50);
      let sent = 0;
      let failed = 0;
      let deferred = 0;
      for (const m of due) {
        if (m.priority !== 'security' && sentToday >= limit) {
          await this.deps.db.update(schema.emailQueue).set({ nextAttemptAt: new Date(now.getTime() + 3600_000), lastError: 'email.error.dailyLimit' }).where(eq(schema.emailQueue.id, m.id));
          deferred++;
          continue;
        }
        try {
          await transport.send({ from: conf.from, to: m.toAddress, replyTo: conf.replyTo, subject: m.subject, text: m.bodyText, html: m.bodyHtml ?? undefined });
          await this.deps.db.update(schema.emailQueue).set({ status: 'sent', sentAt: this.now(), attempts: m.attempts + 1, lastError: null }).where(eq(schema.emailQueue.id, m.id));
          sent++;
          sentToday++;
        } catch (e) {
          const info = translateSmtpError(e, conf.cfg);
          const attempts = m.attempts + 1;
          const exhausted = attempts >= maxAttempts;
          await this.deps.db
            .update(schema.emailQueue)
            .set({ attempts, lastError: `${info.key}|${info.detail}`, status: exhausted ? 'failed' : 'pending', nextAttemptAt: new Date(now.getTime() + Math.min(6 * 3600_000, 60_000 * 5 ** (attempts - 1))) })
            .where(eq(schema.emailQueue.id, m.id));
          if (exhausted) failed++;
        }
      }
      return { sent, failed, deferred, skipped: false };
    } finally {
      this.processing = false;
    }
  }

  /** Pravidelné zpracování fronty (výchozí každých 15 s). */
  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.processQueue().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Tlačítko „Odeslat testovací e-mail“: odešle hned a vrací srozumitelný výsledek. */
  async sendTest(actorId: string, to: string): Promise<{ ok: true } | { ok: false; error: MailErrorInfo }> {
    if (!this.deps.perms.can(actorId, 'email.spravovat_smtp').allowed) throw new Error('FORBIDDEN');
    const conf = await this.smtpConfig();
    if (!conf) return { ok: false, error: { key: 'email.error.notConfigured', detail: '' } };
    try {
      await this.makeTransport(conf.cfg).send({ from: conf.from, to, replyTo: conf.replyTo, subject: 'Zkušební e-mail – KoronaBar Poker', text: 'Odesílání e-mailů z aplikace KoronaBar Poker funguje.' });
      await this.deps.audit.log({ actorId, action: 'email.test_odeslan', targetType: 'email', targetId: to });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: translateSmtpError(e, conf.cfg) };
    }
  }

  /** Notifikátor pro účty: vyplní šablony a uloží do fronty. */
  notifier(): AccountNotifier {
    const q = (key: string, to: string, vars: Record<string, string | number>) => void this.enqueue(key, to, vars).catch((e) => console.error('Fronta e-mailů:', e));
    return {
      verifyEmail: (to, v) => q('overeni_emailu', to, { prezdivka: v.nickname, odkaz: v.link, platnost: v.hours }),
      resetPassword: (to, v) => q('obnova_hesla', to, { prezdivka: v.nickname, odkaz: v.link, platnost: v.hours }),
      passwordChanged: (to, v) => q('zmena_hesla', to, { prezdivka: v.nickname }),
      emailChange: (to, v) => q('zmena_emailu', to, { prezdivka: v.nickname, odkaz: v.link, platnost: v.hours }),
      emailChangedNotice: (to, v) => q('email_zmenen', to, { prezdivka: v.nickname, novy_email: v.newEmail }),
      invite: (to, v) => q('pozvanka', to, { kod: v.code, odkaz: v.link, zvouci: v.inviter }),
    };
  }
}
