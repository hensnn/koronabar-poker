import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { formatStructure, parseStructure, StructureError, type PermissionChecker } from '@kb/shared';
import type { AuditService, AuditSource } from './auth/audit.js';
import { schema, type Db } from './db/index.js';

export class BlindStructureError extends Error {
  constructor(
    public readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID',
    public readonly detail?: string,
  ) {
    super(code);
  }
}

interface Deps {
  db: Db;
  perms: PermissionChecker;
  audit: AuditService;
}

type Meta = { ip?: string | null; source?: AuditSource; reason?: string | null };

export interface BlindStructureInput {
  name: string;
  description?: string;
  levels: string;
  startingStack: number;
  levelMinutes: number;
}

export interface BlindStructureDto {
  id: string;
  name: string;
  description: string;
  levels: string;
  startingStack: number;
  levelMinutes: number;
  updatedAt: number;
}

/** Pojmenované struktury blindů: správce je zakládá a upravuje, kdokoli je vidí při zakládání turnaje. */
export class BlindStructureService {
  constructor(private deps: Deps) {}

  private can(actorId: string): void {
    if (!this.deps.perms.can(actorId, 'nastaveni.globalni').allowed) throw new BlindStructureError('FORBIDDEN');
  }

  private dto(r: typeof schema.blindStructures.$inferSelect): BlindStructureDto {
    return { id: r.id, name: r.name, description: r.description, levels: r.levels, startingStack: r.startingStack, levelMinutes: r.levelMinutes, updatedAt: r.updatedAt.getTime() };
  }

  private check(input: BlindStructureInput): Required<BlindStructureInput> {
    const name = input.name?.trim() ?? '';
    if (name.length < 2 || name.length > 60) throw new BlindStructureError('INVALID', 'name');
    let levels: string;
    try {
      levels = formatStructure(parseStructure(input.levels ?? ''));
    } catch (e) {
      throw new BlindStructureError('INVALID', e instanceof StructureError ? e.code : 'levels');
    }
    const startingStack = Math.floor(Number(input.startingStack));
    const levelMinutes = Math.floor(Number(input.levelMinutes));
    if (!Number.isFinite(startingStack) || startingStack < 1) throw new BlindStructureError('INVALID', 'startingStack');
    if (!Number.isFinite(levelMinutes) || levelMinutes < 1 || levelMinutes > 240) throw new BlindStructureError('INVALID', 'levelMinutes');
    return { name, description: (input.description ?? '').trim().slice(0, 300), levels, startingStack, levelMinutes };
  }

  async list(): Promise<BlindStructureDto[]> {
    const rows = await this.deps.db.select().from(schema.blindStructures);
    return rows.map((r) => this.dto(r)).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  }

  async get(id: string): Promise<BlindStructureDto | undefined> {
    const [r] = await this.deps.db.select().from(schema.blindStructures).where(eq(schema.blindStructures.id, id));
    return r ? this.dto(r) : undefined;
  }

  async create(actorId: string, input: BlindStructureInput, meta: Meta = {}): Promise<BlindStructureDto> {
    this.can(actorId);
    const v = this.check(input);
    const id = `bs-${v.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'struktura'}-${randomBytes(3).toString('hex')}`;
    const [row] = await this.deps.db.insert(schema.blindStructures).values({ id, ...v, updatedBy: actorId }).returning();
    await this.deps.audit.log({ actorId, action: 'struktura.vytvorit', targetType: 'blindStructure', targetId: id, after: v, ...meta });
    return this.dto(row!);
  }

  async update(actorId: string, id: string, input: BlindStructureInput, meta: Meta = {}): Promise<BlindStructureDto> {
    this.can(actorId);
    const before = await this.get(id);
    if (!before) throw new BlindStructureError('NOT_FOUND');
    const v = this.check(input);
    const [row] = await this.deps.db.update(schema.blindStructures).set({ ...v, updatedBy: actorId, updatedAt: new Date() }).where(eq(schema.blindStructures.id, id)).returning();
    await this.deps.audit.log({ actorId, action: 'struktura.upravit', targetType: 'blindStructure', targetId: id, before, after: v, ...meta });
    return this.dto(row!);
  }

  async remove(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    this.can(actorId);
    const before = await this.get(id);
    if (!before) throw new BlindStructureError('NOT_FOUND');
    await this.deps.db.delete(schema.blindStructures).where(eq(schema.blindStructures.id, id));
    await this.deps.audit.log({ actorId, action: 'struktura.smazat', targetType: 'blindStructure', targetId: id, before, ...meta });
  }
}
