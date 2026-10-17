import { and, desc, eq } from 'drizzle-orm';
import { API_SCOPES, isApiScope, TOKEN_PREFIX, type ApiScope, type PermissionChecker, type SettingValues } from '@kb/shared';
import type { SessionUser, AccountService } from './auth/accounts.js';
import type { AuditService } from './auth/audit.js';
import { AttemptLimiter } from './auth/rate-limit.js';
import { randomToken, sha256 } from './auth/crypto.js';
import { schema, type Db } from './db/index.js';

export type ApiErrorCode = 'DISABLED' | 'UNAUTHORIZED' | 'SCOPE' | 'FORBIDDEN' | 'RATE_LIMIT' | 'INVALID' | 'LIMIT' | 'NOT_FOUND';

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

interface Deps {
  db: Db;
  perms: PermissionChecker;
  audit: AuditService;
  accounts: Pick<AccountService, 'sessionUserById'>;
  settings: () => SettingValues;
  now: () => number;
}

type Meta = { ip?: string | null };

export interface TokenAuth {
  user: SessionUser;
  tokenId: string;
  /** Rozsah, který token skutečně má teď: průnik zvoleného a toho, co majitel smí. */
  scopes: ApiScope[];
}

export interface TokenDto {
  id: string;
  name: string;
  hint: string;
  scopes: string[];
  expiresAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
  expired: boolean;
  owner?: string;
}

/**
 * Osobní přístupové tokeny. Token se ukládá jen jako otisk a nikdy nemá víc oprávnění než jeho majitel: rozsah se
 * vybírá z fixní nabídky a při každém volání se znovu ověřuje, že majitel potřebné oprávnění pořád má.
 */
export class ApiTokenService {
  private limiter: AttemptLimiter;
  private touched = new Map<string, number>();

  constructor(private deps: Deps) {
    this.limiter = new AttemptLimiter(deps.now);
  }

  private s() {
    return this.deps.settings();
  }

  /** Které scope smí majitel právě teď. */
  allowedScopes(userId: string): ApiScope[] {
    return (Object.keys(API_SCOPES) as ApiScope[]).filter((sc) => {
      const perm = API_SCOPES[sc].permission;
      return perm === null || this.deps.perms.can(userId, perm).allowed;
    });
  }

  async create(userId: string, input: { name: string; scopes: string[]; expiresInDays: number }, meta: Meta = {}): Promise<{ id: string; token: string }> {
    if (!this.s()['api.enabled']) throw new ApiError('DISABLED');
    if (!this.deps.perms.can(userId, 'api.tokeny').allowed) throw new ApiError('FORBIDDEN');
    const name = input.name?.trim() ?? '';
    if (name.length < 2 || name.length > 60) throw new ApiError('INVALID', { field: 'name' });
    const scopes = [...new Set(input.scopes ?? [])];
    if (scopes.length === 0 || scopes.some((x) => !isApiScope(x))) throw new ApiError('INVALID', { field: 'scopes' });
    const allowed = this.allowedScopes(userId);
    const over = scopes.find((x) => !allowed.includes(x as ApiScope));
    if (over) throw new ApiError('FORBIDDEN', { scope: over });
    const max = Number(this.s()['api.maxExpiryDays']);
    if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > max) throw new ApiError('INVALID', { field: 'expiry', max });
    const now = this.deps.now();
    const live = (await this.deps.db.select().from(schema.apiTokens).where(and(eq(schema.apiTokens.userId, userId)))).filter((t) => !t.revokedAt && t.expiresAt.getTime() > now);
    const limit = Number(this.s()['api.maxTokensPerUser']);
    if (live.length >= limit) throw new ApiError('LIMIT', { max: limit });
    const token = TOKEN_PREFIX + randomToken(32);
    const [row] = await this.deps.db
      .insert(schema.apiTokens)
      .values({ userId, name, tokenHash: sha256(token), hint: token.slice(0, TOKEN_PREFIX.length + 4), scopes, expiresAt: new Date(now + input.expiresInDays * 86_400_000) })
      .returning({ id: schema.apiTokens.id });
    await this.deps.audit.log({ actorId: userId, action: 'api.token_vytvorit', targetType: 'api_token', targetId: row!.id, after: { name, scopes, days: input.expiresInDays }, ...meta });
    return { id: row!.id, token };
  }

  private dto(r: typeof schema.apiTokens.$inferSelect, owner?: string): TokenDto {
    return { id: r.id, name: r.name, hint: r.hint, scopes: r.scopes, expiresAt: r.expiresAt.getTime(), lastUsedAt: r.lastUsedAt?.getTime() ?? null, revoked: !!r.revokedAt, expired: r.expiresAt.getTime() <= this.deps.now(), ...(owner ? { owner } : {}) };
  }

  async list(userId: string): Promise<{ tokens: TokenDto[]; allowed: ApiScope[] }> {
    const rows = await this.deps.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, userId)).orderBy(desc(schema.apiTokens.createdAt));
    return { tokens: rows.map((r) => this.dto(r)), allowed: this.allowedScopes(userId) };
  }

  /** Všechny tokeny všech hráčů (správce). */
  async listAll(actorId: string): Promise<TokenDto[]> {
    if (!this.deps.perms.can(actorId, 'api.spravovat').allowed) throw new ApiError('FORBIDDEN');
    const rows = await this.deps.db
      .select({ t: schema.apiTokens, nick: schema.users.nickname })
      .from(schema.apiTokens)
      .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
      .orderBy(desc(schema.apiTokens.createdAt));
    return rows.map((r) => this.dto(r.t, r.nick));
  }

  /** Zruší token: majitel svůj, správce (oprávnění api.spravovat) kterýkoli. */
  async revoke(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    const [row] = await this.deps.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, id));
    if (!row) throw new ApiError('NOT_FOUND');
    if (row.userId !== actorId && !this.deps.perms.can(actorId, 'api.spravovat').allowed) throw new ApiError('NOT_FOUND');
    if (row.revokedAt) return;
    await this.deps.db.update(schema.apiTokens).set({ revokedAt: new Date(this.deps.now()) }).where(eq(schema.apiTokens.id, id));
    await this.deps.audit.log({ actorId, action: 'api.token_zrusit', targetType: 'api_token', targetId: id, after: { owner: row.userId }, ...meta });
  }

  /** Ověří token z hlavičky a započítá volání do limitu. */
  async authenticate(raw: string | undefined): Promise<TokenAuth> {
    if (!this.s()['api.enabled']) throw new ApiError('DISABLED');
    if (!raw || !raw.startsWith(TOKEN_PREFIX)) throw new ApiError('UNAUTHORIZED');
    const [row] = await this.deps.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, sha256(raw)));
    const now = this.deps.now();
    if (!row || row.revokedAt || row.expiresAt.getTime() <= now) throw new ApiError('UNAUTHORIZED');
    const max = Number(this.s()['api.rateLimitPerMinute']);
    const key = `api:${row.id}`;
    const wait = this.limiter.lockedFor(key, max, 60_000);
    if (wait > 0) throw new ApiError('RATE_LIMIT', { seconds: Math.ceil(wait / 1000) });
    this.limiter.record(key, 60_000);
    const user = await this.deps.accounts.sessionUserById(row.userId);
    if (!user || (user.status === 'blocked' && (!user.blockedUntil || user.blockedUntil.getTime() > now))) throw new ApiError('UNAUTHORIZED');
    const allowed = this.allowedScopes(row.userId);
    const scopes = row.scopes.filter((x): x is ApiScope => isApiScope(x) && allowed.includes(x));
    if (now - (this.touched.get(row.id) ?? 0) > 60_000) {
      this.touched.set(row.id, now);
      void this.deps.db.update(schema.apiTokens).set({ lastUsedAt: new Date(now) }).where(eq(schema.apiTokens.id, row.id)).catch(() => undefined);
    }
    return { user, tokenId: row.id, scopes };
  }
}
