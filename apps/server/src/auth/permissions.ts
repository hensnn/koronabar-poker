import { and, eq, gte, sql } from 'drizzle-orm';
import {
  permissionDef,
  permissionKeys,
  type Decision,
  type LimitKey,
  type PermissionChecker,
  type PermissionContext,
} from '@kb/shared';
import { schema, type Db } from '../db/index.js';
import type { AuditService, AuditSource } from './audit.js';

export type PermissionErrorCode =
  | 'FORBIDDEN'
  | 'HIERARCHY'
  | 'LOCKED_ROLE'
  | 'LAST_MAIN_ADMIN'
  | 'NOT_FOUND'
  | 'ROLE_IN_USE'
  | 'EXCEEDS_OWN_PERMISSIONS'
  | 'DUPLICATE_KEY'
  | 'INVALID'
  | 'LIMIT_EXCEEDED';

export class PermissionError extends Error {
  constructor(
    public readonly code: PermissionErrorCode,
    public readonly params?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  power: number;
  color: string | null;
  icon: string | null;
  isSystem: boolean;
  isLocked: boolean;
}
export interface RolePermRow {
  roleId: string;
  permission: string;
  effect: 'allow' | 'deny';
  limits: Partial<Record<LimitKey, number>> | null;
  needsApproval: boolean;
}
export interface AssignmentRow {
  id: string;
  userId: string;
  roleId: string;
  scopeType: string;
  scopeId: string;
  validFrom: Date | null;
  validTo: Date | null;
  grantedBy: string | null;
  reason: string | null;
}
interface UserInfo {
  status: string;
  blockedUntil: Date | null;
}

export interface Meta {
  ip?: string | null;
  source?: AuditSource;
  reason?: string | null;
}

export interface RoleInput {
  key: string;
  name: string;
  description?: string | null;
  power: number;
  color?: string | null;
  icon?: string | null;
  permissions: { key: string; effect?: 'allow' | 'deny'; limits?: Partial<Record<LimitKey, number>>; needsApproval?: boolean }[];
}

interface Grant {
  limits: Partial<Record<LimitKey, number>> | undefined;
  needsApproval: boolean;
}

/**
 * Služba oprávnění. Role, přidělení a stavy uživatelů drží v paměti (rozhodování je synchronní,
 * volá se při každé zprávě), změny jdou do DB a cache se po nich znovu načte.
 *
 * Pravidla: oprávnění = sjednocení rolí v platném rozsahu a čase, zákaz má přednost, hlavní
 * administrátor (zamčená role) má vše. Správa rolí a uživatelů se řídí silou: smím spravovat
 * jen role a uživatele s nižší silou, než je moje nejvyšší role, a nikomu nedám oprávnění, které
 * sám nemám.
 */
export class PermissionService implements PermissionChecker {
  private roles = new Map<string, RoleRow>();
  private rolePerms = new Map<string, RolePermRow[]>();
  private assignments = new Map<string, AssignmentRow[]>();
  private users = new Map<string, UserInfo>();
  private listeners = new Set<() => void>();

  constructor(
    private db: Db,
    private audit: AuditService,
    private now: () => Date = () => new Date(),
  ) {}

  // ---------- cache ----------

  async reload(): Promise<void> {
    const [roles, perms, assigns, users] = await Promise.all([
      this.db.select().from(schema.roles),
      this.db.select().from(schema.rolePermissions),
      this.db.select().from(schema.roleAssignments),
      this.db.select({ id: schema.users.id, status: schema.users.status, blockedUntil: schema.users.blockedUntil }).from(schema.users),
    ]);
    this.roles = new Map(roles.map((r) => [r.id, r]));
    this.rolePerms = new Map();
    for (const p of perms) {
      const list = this.rolePerms.get(p.roleId) ?? [];
      list.push({ ...p, effect: p.effect === 'deny' ? 'deny' : 'allow' });
      this.rolePerms.set(p.roleId, list);
    }
    this.assignments = new Map();
    for (const a of assigns) {
      const list = this.assignments.get(a.userId) ?? [];
      list.push(a);
      this.assignments.set(a.userId, list);
    }
    this.users = new Map(users.map((u) => [u.id, { status: u.status, blockedUntil: u.blockedUntil }]));
    for (const l of this.listeners) l();
  }

  /** Odběr změn rolí a oprávnění (server pak upozorní připojené klienty). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- rozhodování ----------

  private activeAssignments(userId: string, ctx?: PermissionContext): AssignmentRow[] {
    const t = this.now().getTime();
    return (this.assignments.get(userId) ?? []).filter((a) => {
      if (a.validFrom && a.validFrom.getTime() > t) return false;
      if (a.validTo && a.validTo.getTime() < t) return false;
      if (a.scopeType === 'global') return true;
      return !!ctx?.scopeType && a.scopeType === ctx.scopeType && a.scopeId === (ctx.scopeId ?? '');
    });
  }

  private isBlocked(userId: string): boolean {
    const u = this.users.get(userId);
    if (!u) return true;
    if (u.status === 'blocked') return !u.blockedUntil || u.blockedUntil.getTime() > this.now().getTime();
    return false;
  }

  /** Spojí oprávnění všech platných rolí. `undefined` = žádné oprávnění nebo zákaz. */
  private grant(userId: string, permission: string, ctx?: PermissionContext): Grant | 'denied' | undefined {
    let locked = false;
    const allows: RolePermRow[] = [];
    for (const a of this.activeAssignments(userId, ctx)) {
      const role = this.roles.get(a.roleId);
      if (!role) continue;
      if (role.isLocked) locked = true;
      for (const p of this.rolePerms.get(role.id) ?? []) {
        if (p.permission !== permission) continue;
        if (p.effect === 'deny') return 'denied';
        allows.push(p);
      }
    }
    if (locked) return { limits: undefined, needsApproval: false };
    if (allows.length === 0) return undefined;
    const limitKeys = new Set<LimitKey>();
    for (const p of allows) for (const k of Object.keys(p.limits ?? {}) as LimitKey[]) limitKeys.add(k);
    const limits: Partial<Record<LimitKey, number>> = {};
    for (const k of limitKeys) {
      // Neomezené, pokud některá z rolí limit nemá; jinak nejvolnější.
      if (allows.some((p) => p.limits?.[k] === undefined)) continue;
      limits[k] = Math.max(...allows.map((p) => p.limits![k]!));
    }
    return { limits: Object.keys(limits).length ? limits : undefined, needsApproval: allows.every((p) => p.needsApproval) };
  }

  can(userId: string | null, permission: string, ctx: PermissionContext = {}): Decision {
    if (!userId) return { allowed: false, reasonKey: 'permission.notLoggedIn' };
    if (!permissionDef(permission)) return { allowed: false, reasonKey: 'permission.unknown' };
    if (this.isBlocked(userId)) return { allowed: false, reasonKey: 'permission.blocked' };
    const g = this.grant(userId, permission, ctx);
    if (g === 'denied' || g === undefined) return { allowed: false, reasonKey: 'permission.denied' };
    if (ctx.amount !== undefined && g.limits?.maxPerOperation !== undefined && ctx.amount > g.limits.maxPerOperation) {
      return { allowed: false, reasonKey: 'permission.limitExceeded', limits: g.limits };
    }
    return { allowed: true, needsApproval: g.needsApproval || undefined, limits: g.limits };
  }

  /** Všechna oprávnění uživatele v daném rozsahu (pro klienta a pro kontrolu „nedám, co nemám“). */
  effective(userId: string, ctx?: PermissionContext): Map<string, Decision> {
    const out = new Map<string, Decision>();
    for (const key of permissionKeys()) {
      const d = this.can(userId, key, ctx);
      if (d.allowed) out.set(key, d);
    }
    return out;
  }

  /** Nejvyšší síla z globálních rolí (pro hierarchii). */
  maxPower(userId: string): number {
    let max = -1;
    for (const a of this.activeAssignments(userId)) {
      const role = this.roles.get(a.roleId);
      if (role && role.power > max) max = role.power;
    }
    return max;
  }

  isMainAdmin(userId: string): boolean {
    return this.activeAssignments(userId).some((a) => this.roles.get(a.roleId)?.isLocked);
  }

  mainAdminIds(): string[] {
    const ids: string[] = [];
    for (const userId of this.assignments.keys()) if (this.isMainAdmin(userId) && !this.isBlocked(userId)) ids.push(userId);
    return ids;
  }

  listRoles(): (RoleRow & { permissions: RolePermRow[] })[] {
    return [...this.roles.values()].sort((a, b) => b.power - a.power || a.key.localeCompare(b.key)).map((r) => ({ ...r, permissions: this.rolePerms.get(r.id) ?? [] }));
  }
  getRole(id: string): RoleRow | undefined {
    return this.roles.get(id);
  }
  roleByKey(key: string): RoleRow | undefined {
    return [...this.roles.values()].find((r) => r.key === key);
  }
  assignmentsOf(userId: string): (AssignmentRow & { role: RoleRow | undefined })[] {
    return (this.assignments.get(userId) ?? []).map((a) => ({ ...a, role: this.roles.get(a.roleId) }));
  }

  // ---------- omezení denním limitem ----------

  /** Ověří denní limit (maxPerDay) a zapíše spotřebu. Volá se u peněžních operací. */
  async consumeDaily(userId: string, permission: string, amount: number, ctx: PermissionContext = {}): Promise<void> {
    const d = this.can(userId, permission, { ...ctx, amount });
    if (!d.allowed) throw new PermissionError(d.reasonKey === 'permission.limitExceeded' ? 'LIMIT_EXCEEDED' : 'FORBIDDEN', { limits: d.limits });
    const perDay = d.limits?.maxPerDay;
    if (perDay !== undefined) {
      const since = new Date(this.now().getTime() - 24 * 3600 * 1000);
      const [row] = await this.db
        .select({ sum: sql<number>`coalesce(sum(${schema.permissionUsage.amount}), 0)::bigint` })
        .from(schema.permissionUsage)
        .where(and(eq(schema.permissionUsage.userId, userId), eq(schema.permissionUsage.permission, permission), gte(schema.permissionUsage.at, since)));
      if (Number(row?.sum ?? 0) + amount > perDay) throw new PermissionError('LIMIT_EXCEEDED', { limits: d.limits, used: Number(row?.sum ?? 0) });
    }
    await this.db.insert(schema.permissionUsage).values({ userId, permission, amount, at: this.now() });
  }

  // ---------- správa rolí (s hierarchií) ----------

  private requirePower(actorId: string): number {
    const p = this.maxPower(actorId);
    if (p < 0) throw new PermissionError('FORBIDDEN');
    return p;
  }

  /** Aktér nesmí udělit oprávnění (ani volnější limit), které sám nemá. */
  private assertSubset(actorId: string, perms: RoleInput['permissions']): void {
    if (this.isMainAdmin(actorId)) return;
    const mine = this.effective(actorId);
    for (const p of perms) {
      if ((p.effect ?? 'allow') === 'deny') continue;
      const own = mine.get(p.key);
      if (!own) throw new PermissionError('EXCEEDS_OWN_PERMISSIONS', { permission: p.key });
      for (const [k, v] of Object.entries(p.limits ?? {}) as [LimitKey, number][]) {
        const cap = own.limits?.[k];
        if (cap !== undefined && v > cap) throw new PermissionError('EXCEEDS_OWN_PERMISSIONS', { permission: p.key, limit: k });
      }
      // Neomezené oprávnění nelze předat, pokud mám jen omezené.
      for (const k of Object.keys(own.limits ?? {}) as LimitKey[]) {
        if (p.limits?.[k] === undefined) throw new PermissionError('EXCEEDS_OWN_PERMISSIONS', { permission: p.key, limit: k });
      }
    }
  }

  private validateRoleInput(input: RoleInput): void {
    if (!/^[a-z0-9_]{2,40}$/.test(input.key)) throw new PermissionError('INVALID', { field: 'key' });
    if (!input.name.trim() || input.name.length > 60) throw new PermissionError('INVALID', { field: 'name' });
    if (!Number.isInteger(input.power) || input.power < 0 || input.power > 100) throw new PermissionError('INVALID', { field: 'power' });
    for (const p of input.permissions) {
      const def = permissionDef(p.key);
      if (!def) throw new PermissionError('INVALID', { field: 'permissions', permission: p.key });
      for (const k of Object.keys(p.limits ?? {})) if (!def.limits?.includes(k as LimitKey)) throw new PermissionError('INVALID', { field: 'limits', permission: p.key, limit: k });
      if (p.needsApproval && !def.approvalCapable) throw new PermissionError('INVALID', { field: 'needsApproval', permission: p.key });
    }
  }

  async createRole(actorId: string, input: RoleInput, meta: Meta = {}): Promise<string> {
    if (!this.can(actorId, 'role.vytvorit').allowed) throw new PermissionError('FORBIDDEN');
    const power = this.requirePower(actorId);
    this.validateRoleInput(input);
    if (input.power >= power && !this.isMainAdmin(actorId)) throw new PermissionError('HIERARCHY');
    if (input.power >= 100) throw new PermissionError('HIERARCHY');
    if (this.roleByKey(input.key)) throw new PermissionError('DUPLICATE_KEY');
    this.assertSubset(actorId, input.permissions);
    const id = await this.insertRole(input, false, false);
    await this.reload();
    await this.audit.log({ actorId, action: 'role.vytvorit', targetType: 'role', targetId: id, after: input, ...meta });
    return id;
  }

  /** Vložení role bez kontrol oprávnění (seed při prvním startu, import). */
  async insertRole(input: RoleInput, isSystem: boolean, isLocked: boolean): Promise<string> {
    return this.db.transaction(async (trx) => {
      const [row] = await trx
        .insert(schema.roles)
        .values({ key: input.key, name: input.name, description: input.description ?? null, power: input.power, color: input.color ?? null, icon: input.icon ?? null, isSystem, isLocked })
        .returning({ id: schema.roles.id });
      const id = row!.id;
      // Při opakování stejného oprávnění platí poslední záznam (např. běžné + s limitem).
      const unique = [...new Map(input.permissions.map((p) => [p.key, p])).values()];
      if (unique.length) {
        await trx.insert(schema.rolePermissions).values(
          unique.map((p) => ({ roleId: id, permission: p.key, effect: p.effect ?? 'allow', limits: p.limits ?? null, needsApproval: p.needsApproval ?? false })),
        );
      }
      return id;
    });
  }

  async updateRole(actorId: string, roleId: string, patch: Partial<Omit<RoleInput, 'key'>>, meta: Meta = {}): Promise<void> {
    if (!this.can(actorId, 'role.upravit').allowed) throw new PermissionError('FORBIDDEN');
    const role = this.roles.get(roleId);
    if (!role) throw new PermissionError('NOT_FOUND');
    if (role.isLocked) throw new PermissionError('LOCKED_ROLE');
    const power = this.requirePower(actorId);
    if (role.power >= power && !this.isMainAdmin(actorId)) throw new PermissionError('HIERARCHY');
    const next: RoleInput = {
      key: role.key,
      name: patch.name ?? role.name,
      description: patch.description ?? role.description,
      power: patch.power ?? role.power,
      color: patch.color ?? role.color,
      icon: patch.icon ?? role.icon,
      permissions: patch.permissions ?? (this.rolePerms.get(roleId) ?? []).map((p) => ({ key: p.permission, effect: p.effect, limits: p.limits ?? undefined, needsApproval: p.needsApproval })),
    };
    this.validateRoleInput(next);
    if (next.power >= power && !this.isMainAdmin(actorId)) throw new PermissionError('HIERARCHY');
    if (next.power >= 100) throw new PermissionError('HIERARCHY');
    // Přidaná oprávnění musí aktér sám mít; odebrat může cokoli.
    const before = this.rolePerms.get(roleId) ?? [];
    if (patch.permissions) {
      const added = patch.permissions.filter((p) => {
        const old = before.find((b) => b.permission === p.key && b.effect === (p.effect ?? 'allow'));
        return !old || JSON.stringify(old.limits ?? {}) !== JSON.stringify(p.limits ?? {});
      });
      this.assertSubset(actorId, added);
    }
    await this.db.transaction(async (trx) => {
      await trx.update(schema.roles).set({ name: next.name, description: next.description ?? null, power: next.power, color: next.color ?? null, icon: next.icon ?? null }).where(eq(schema.roles.id, roleId));
      if (patch.permissions) {
        await trx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
        if (next.permissions.length) {
          await trx.insert(schema.rolePermissions).values(next.permissions.map((p) => ({ roleId, permission: p.key, effect: p.effect ?? 'allow', limits: p.limits ?? null, needsApproval: p.needsApproval ?? false })));
        }
      }
    });
    await this.reload();
    await this.audit.log({ actorId, action: 'role.upravit', targetType: 'role', targetId: roleId, before: { ...role, permissions: before }, after: next, ...meta });
  }

  async deleteRole(actorId: string, roleId: string, meta: Meta = {}): Promise<void> {
    if (!this.can(actorId, 'role.smazat').allowed) throw new PermissionError('FORBIDDEN');
    const role = this.roles.get(roleId);
    if (!role) throw new PermissionError('NOT_FOUND');
    if (role.isLocked) throw new PermissionError('LOCKED_ROLE');
    const power = this.requirePower(actorId);
    if (role.power >= power && !this.isMainAdmin(actorId)) throw new PermissionError('HIERARCHY');
    const inUse = [...this.assignments.values()].some((l) => l.some((a) => a.roleId === roleId));
    if (inUse) throw new PermissionError('ROLE_IN_USE');
    await this.db.delete(schema.roles).where(eq(schema.roles.id, roleId));
    await this.reload();
    await this.audit.log({ actorId, action: 'role.smazat', targetType: 'role', targetId: roleId, before: role, ...meta });
  }

  // ---------- přidělování rolí ----------

  async assignRole(
    actorId: string,
    targetUserId: string,
    roleId: string,
    opts: { scopeType?: string; scopeId?: string; validFrom?: Date | null; validTo?: Date | null } = {},
    meta: Meta = {},
  ): Promise<string> {
    const scopeType = opts.scopeType ?? 'global';
    const scopeId = opts.scopeId ?? '';
    if (scopeType !== 'global' && !scopeId) throw new PermissionError('INVALID', { field: 'scopeId' });
    if (!this.can(actorId, 'role.prirazovat', scopeType === 'global' ? {} : { scopeType: scopeType as 'table', scopeId }).allowed) throw new PermissionError('FORBIDDEN');
    const role = this.roles.get(roleId);
    if (!role) throw new PermissionError('NOT_FOUND', { what: 'role' });
    if (!this.users.has(targetUserId)) throw new PermissionError('NOT_FOUND', { what: 'user' });
    if (opts.validFrom && opts.validTo && opts.validTo <= opts.validFrom) throw new PermissionError('INVALID', { field: 'validTo' });
    const actorIsMain = this.isMainAdmin(actorId);
    const power = this.requirePower(actorId);
    if (role.isLocked && !actorIsMain) throw new PermissionError('LOCKED_ROLE');
    if (!role.isLocked && role.power >= power && !actorIsMain) throw new PermissionError('HIERARCHY');
    // Smím spravovat jen uživatele s nižší silou, než mám já (sám sebe ne).
    if (!actorIsMain && this.maxPower(targetUserId) >= power) throw new PermissionError('HIERARCHY');
    if (actorId === targetUserId && !actorIsMain) throw new PermissionError('HIERARCHY');
    if (!role.isLocked) {
      this.assertSubset(actorId, (this.rolePerms.get(roleId) ?? []).map((p) => ({ key: p.permission, effect: p.effect, limits: p.limits ?? undefined })));
    }
    const [row] = await this.db
      .insert(schema.roleAssignments)
      .values({ userId: targetUserId, roleId, scopeType, scopeId, validFrom: opts.validFrom ?? null, validTo: opts.validTo ?? null, grantedBy: actorId, reason: meta.reason ?? null })
      .onConflictDoUpdate({
        target: [schema.roleAssignments.userId, schema.roleAssignments.roleId, schema.roleAssignments.scopeType, schema.roleAssignments.scopeId],
        set: { validFrom: opts.validFrom ?? null, validTo: opts.validTo ?? null, grantedBy: actorId },
      })
      .returning({ id: schema.roleAssignments.id });
    await this.reload();
    await this.audit.log({ actorId, action: 'role.prirazeni', targetType: 'user', targetId: targetUserId, after: { roleId, role: role.key, scopeType, scopeId, validFrom: opts.validFrom, validTo: opts.validTo }, ...meta });
    return row!.id;
  }

  async revokeAssignment(actorId: string, assignmentId: string, meta: Meta = {}): Promise<void> {
    const found = [...this.assignments.values()].flat().find((a) => a.id === assignmentId);
    if (!found) throw new PermissionError('NOT_FOUND');
    const role = this.roles.get(found.roleId);
    if (!role) throw new PermissionError('NOT_FOUND');
    if (!this.can(actorId, 'role.prirazovat', found.scopeType === 'global' ? {} : { scopeType: found.scopeType as 'table', scopeId: found.scopeId }).allowed) throw new PermissionError('FORBIDDEN');
    const actorIsMain = this.isMainAdmin(actorId);
    const power = this.requirePower(actorId);
    if (role.isLocked) {
      if (!actorIsMain) throw new PermissionError('LOCKED_ROLE');
      // Poslední hlavní administrátor nesmí zmizet.
      const others = this.mainAdminIds().filter((id) => id !== found.userId);
      if (this.mainAdminIds().includes(found.userId) && others.length === 0) throw new PermissionError('LAST_MAIN_ADMIN');
    } else if (!actorIsMain && (role.power >= power || this.maxPower(found.userId) >= power)) {
      throw new PermissionError('HIERARCHY');
    }
    await this.db.delete(schema.roleAssignments).where(eq(schema.roleAssignments.id, assignmentId));
    await this.reload();
    await this.audit.log({ actorId, action: 'role.odebrani', targetType: 'user', targetId: found.userId, before: { roleId: role.id, role: role.key, scopeType: found.scopeType, scopeId: found.scopeId }, ...meta });
  }

  /** Vložení přidělení bez kontrol (první hlavní administrátor, registrace s pozvánkou, CLI). */
  async grantUnchecked(userId: string, roleId: string, grantedBy: string | null = null): Promise<void> {
    await this.db
      .insert(schema.roleAssignments)
      .values({ userId, roleId, scopeType: 'global', scopeId: '', grantedBy })
      .onConflictDoNothing();
    await this.reload();
  }

  /** Ochrana: lze uživatele zablokovat nebo smazat, aniž by zmizel poslední hlavní administrátor? */
  assertNotLastMainAdmin(userId: string): void {
    const main = this.mainAdminIds();
    if (main.includes(userId) && main.length <= 1) throw new PermissionError('LAST_MAIN_ADMIN');
  }

  /** Zda smí aktér spravovat cílového uživatele (blokace, úprava, smazání): nižší síla, ne sám sebe. */
  assertCanManageUser(actorId: string, targetUserId: string): void {
    if (this.isMainAdmin(actorId)) return;
    const power = this.requirePower(actorId);
    if (actorId === targetUserId || this.maxPower(targetUserId) >= power) throw new PermissionError('HIERARCHY');
  }
}
