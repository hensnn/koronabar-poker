import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { THEME_SCHEMA_VERSION, TOKEN_DEFS, importTheme, migrateTheme, type Theme } from '@kb/tokens';
import type { PermissionChecker, SettingValues } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';

export type ThemeErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'LIMIT' | 'BAD_STATE';

export class ThemeError extends Error {
  constructor(
    public code: ThemeErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export interface ThemeDto {
  id: string;
  name: string;
  status: string;
  ownerId: string | null;
  ownerNickname: string | null;
  mine: boolean;
  theme: Theme;
  updatedAt: number;
}

const LOCK_KEY = 'theme:locked';

/**
 * Vlastní motivy vzhledu: ukládání, sdílení se schvalováním, zamčené prvky a výchozí motiv.
 * Motiv je jen data (tokeny); hodnoty se ověřují podle schématu tokenů, takže nejde vložit CSS ani skript.
 */
export class ThemeService {
  constructor(
    private deps: {
      db: Db;
      perms: PermissionChecker;
      audit: AuditService;
      settings: () => SettingValues;
      now: () => number;
      notify?: (userId: string, kind: string, params: Record<string, unknown>) => Promise<void>;
    },
  ) {}

  private can(userId: string, key: string): boolean {
    return this.deps.perms.can(userId, key).allowed;
  }

  // ---------- zamčené prvky ----------

  async locked(): Promise<string[]> {
    const [r] = await this.deps.db.select().from(schema.systemMeta).where(eq(schema.systemMeta.key, LOCK_KEY));
    return Array.isArray(r?.value) ? (r!.value as string[]) : [];
  }

  async setLocked(actorId: string, tokens: string[]): Promise<string[]> {
    if (!this.can(actorId, 'motiv.zamknout_prvky')) throw new ThemeError('FORBIDDEN');
    const known = new Set(TOKEN_DEFS.map((d) => d.key));
    const clean = [...new Set(tokens)].filter((k) => known.has(k));
    await this.deps.db.insert(schema.systemMeta).values({ key: LOCK_KEY, value: clean }).onConflictDoUpdate({ target: schema.systemMeta.key, set: { value: clean } });
    await this.deps.audit.log({ actorId, action: 'motiv.zamknuto', targetType: 'theme', after: { tokens: clean } });
    return clean;
  }

  /** Odstraní zamčené tokeny z motivu (nesmí se přepsat výchozí hodnotou). */
  private async stripLocked(t: Theme): Promise<Theme> {
    const locked = new Set(await this.locked());
    if (locked.size === 0) return t;
    const strip = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([k]) => !locked.has(k)));
    return { ...t, light: strip(t.light), dark: strip(t.dark) };
  }

  // ---------- čtení ----------

  private dto(r: typeof schema.themes.$inferSelect, userId: string, nick: string | null): ThemeDto {
    return { id: r.id, name: r.name, status: r.status, ownerId: r.ownerId, ownerNickname: nick, mine: r.ownerId === userId, theme: { ...(r.data as unknown as Theme), id: r.id, name: r.name, builtin: false }, updatedAt: r.updatedAt.getTime() };
  }

  /** Vlastní motivy, které uživatel smí používat: jeho a sdílené. */
  async list(userId: string): Promise<{ themes: ThemeDto[]; locked: string[]; defaultId: string }> {
    const rows = await this.deps.db.select().from(schema.themes).where(or(eq(schema.themes.ownerId, userId), eq(schema.themes.status, 'shared'))).orderBy(desc(schema.themes.updatedAt));
    const owners = [...new Set(rows.map((r) => r.ownerId).filter((x): x is string => !!x))];
    const nicks = new Map(owners.length ? (await this.deps.db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, owners))).map((u) => [u.id, u.n]) : []);
    return { themes: rows.map((r) => this.dto(r, userId, r.ownerId ? (nicks.get(r.ownerId) ?? null) : null)), locked: await this.locked(), defaultId: String(this.deps.settings()['theme.defaultId']) };
  }

  /** Fronta ke schválení pro kurátora. */
  async pending(actorId: string): Promise<ThemeDto[]> {
    if (!this.can(actorId, 'motiv.schvalit')) throw new ThemeError('FORBIDDEN');
    const rows = await this.deps.db.select().from(schema.themes).where(eq(schema.themes.status, 'pending'));
    const owners = [...new Set(rows.map((r) => r.ownerId).filter((x): x is string => !!x))];
    const nicks = new Map(owners.length ? (await this.deps.db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, owners))).map((u) => [u.id, u.n]) : []);
    return rows.map((r) => this.dto(r, actorId, r.ownerId ? (nicks.get(r.ownerId) ?? null) : null));
  }

  private async load(id: string) {
    const [r] = await this.deps.db.select().from(schema.themes).where(eq(schema.themes.id, id));
    if (!r) throw new ThemeError('NOT_FOUND');
    return r;
  }

  // ---------- úpravy ----------

  private async clean(raw: unknown, name: string): Promise<{ theme: Theme; dropped: string[] }> {
    const candidate = { schemaVersion: THEME_SCHEMA_VERSION, id: 'x', name, ...(raw as object) };
    const imp = importTheme(JSON.stringify(candidate));
    if (!imp.ok) throw new ThemeError('INVALID', { field: 'theme' });
    return { theme: await this.stripLocked(migrateTheme(imp.theme)), dropped: imp.dropped };
  }

  async create(userId: string, input: { name: string; theme?: unknown }): Promise<{ id: string; dropped: string[] }> {
    if (!this.can(userId, 'motiv.vytvorit')) throw new ThemeError('FORBIDDEN');
    const name = (input.name ?? '').trim();
    if (!name || name.length > 60) throw new ThemeError('INVALID', { field: 'name' });
    const mine = (await this.deps.db.select({ id: schema.themes.id }).from(schema.themes).where(eq(schema.themes.ownerId, userId))).length;
    const max = Number(this.deps.settings()['theme.maxPerUser']);
    if (mine >= max) throw new ThemeError('LIMIT', { max });
    const { theme, dropped } = await this.clean(input.theme ?? { light: {}, dark: {} }, name);
    const [row] = await this.deps.db
      .insert(schema.themes)
      .values({ ownerId: userId, name, data: { schemaVersion: theme.schemaVersion, light: theme.light, dark: theme.dark }, status: 'private', updatedAt: new Date(this.deps.now()) })
      .returning({ id: schema.themes.id });
    await this.deps.audit.log({ actorId: userId, action: 'motiv.vytvoren', targetType: 'theme', targetId: row!.id, after: { name } });
    return { id: row!.id, dropped };
  }

  async update(userId: string, id: string, input: { name?: string; theme?: unknown }): Promise<{ dropped: string[] }> {
    const r = await this.load(id);
    if (r.ownerId !== userId) throw new ThemeError('FORBIDDEN');
    const name = input.name !== undefined ? input.name.trim() : r.name;
    if (!name || name.length > 60) throw new ThemeError('INVALID', { field: 'name' });
    let data = r.data;
    let dropped: string[] = [];
    if (input.theme !== undefined) {
      const c = await this.clean(input.theme, name);
      data = { schemaVersion: c.theme.schemaVersion, light: c.theme.light, dark: c.theme.dark } as unknown as typeof r.data;
      dropped = c.dropped;
    }
    // úprava sdíleného motivu ho vrací ke schválení (když se schvaluje)
    const status = r.status === 'shared' && this.deps.settings()['theme.requireApproval'] ? 'pending' : r.status;
    await this.deps.db.update(schema.themes).set({ name, data, status, updatedAt: new Date(this.deps.now()) }).where(eq(schema.themes.id, id));
    await this.deps.audit.log({ actorId: userId, action: 'motiv.upraven', targetType: 'theme', targetId: id, after: { name } });
    return { dropped };
  }

  async remove(userId: string, id: string): Promise<void> {
    const r = await this.load(id);
    if (r.ownerId !== userId && !this.can(userId, 'motiv.schvalit')) throw new ThemeError('FORBIDDEN');
    await this.deps.db.delete(schema.themes).where(eq(schema.themes.id, id));
    await this.deps.audit.log({ actorId: userId, action: 'motiv.smazan', targetType: 'theme', targetId: id, after: { name: r.name } });
  }

  async share(userId: string, id: string, on: boolean): Promise<string> {
    const r = await this.load(id);
    if (r.ownerId !== userId) throw new ThemeError('FORBIDDEN');
    if (r.status === 'hidden') throw new ThemeError('BAD_STATE');
    const status = on ? (this.deps.settings()['theme.requireApproval'] ? 'pending' : 'shared') : 'private';
    await this.deps.db.update(schema.themes).set({ status }).where(eq(schema.themes.id, id));
    await this.deps.audit.log({ actorId: userId, action: on ? 'motiv.nabidnut' : 'motiv.stazen', targetType: 'theme', targetId: id });
    return status;
  }

  async review(actorId: string, id: string, approve: boolean): Promise<void> {
    if (!this.can(actorId, 'motiv.schvalit')) throw new ThemeError('FORBIDDEN');
    const r = await this.load(id);
    if (r.status !== 'pending') throw new ThemeError('BAD_STATE');
    await this.deps.db.update(schema.themes).set({ status: approve ? 'shared' : 'private' }).where(eq(schema.themes.id, id));
    await this.deps.audit.log({ actorId, action: approve ? 'motiv.schvalen' : 'motiv.zamitnut', targetType: 'theme', targetId: id });
    if (r.ownerId) await this.deps.notify?.(r.ownerId, approve ? 'themeApproved' : 'themeRejected', { name: r.name });
  }

  async hide(actorId: string, id: string, hidden: boolean): Promise<void> {
    if (!this.can(actorId, 'motiv.schvalit')) throw new ThemeError('FORBIDDEN');
    const r = await this.load(id);
    await this.deps.db.update(schema.themes).set({ status: hidden ? 'hidden' : 'private' }).where(and(eq(schema.themes.id, id)));
    await this.deps.audit.log({ actorId, action: hidden ? 'motiv.skryt' : 'motiv.zobrazen', targetType: 'theme', targetId: id, after: { name: r.name } });
  }
}
