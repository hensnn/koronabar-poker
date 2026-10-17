import { desc, eq, and, gte, lte, type SQL } from 'drizzle-orm';
import { schema, type Db } from '../db/index.js';

export type AuditSource = 'ui' | 'assistant' | 'api' | 'mcp' | 'cli' | 'system';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  source?: AuditSource;
  reason?: string | null;
}

/** Tajné hodnoty se do audit logu nikdy nezapisují; vyřadí se podle jména pole. */
const SECRET_FIELD = /(password|passwd|secret|token|apikey|api_key|ciphertext|nonce)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_FIELD.test(k) ? '[skryto]' : redact(v)]));
  }
  return value;
}

export class AuditService {
  constructor(private db: Db) {}

  async log(e: AuditEntry): Promise<void> {
    await this.db.insert(schema.auditLog).values({
      actorId: e.actorId ?? null,
      action: e.action,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      before: e.before === undefined ? null : redact(e.before),
      after: e.after === undefined ? null : redact(e.after),
      ip: e.ip ?? null,
      source: e.source ?? 'ui',
      reason: e.reason ?? null,
    });
  }

  async list(filter: { actorId?: string; action?: string; from?: Date; to?: Date; limit?: number } = {}) {
    const conds: SQL[] = [];
    if (filter.actorId) conds.push(eq(schema.auditLog.actorId, filter.actorId));
    if (filter.action) conds.push(eq(schema.auditLog.action, filter.action));
    if (filter.from) conds.push(gte(schema.auditLog.at, filter.from));
    if (filter.to) conds.push(lte(schema.auditLog.at, filter.to));
    return this.db
      .select()
      .from(schema.auditLog)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.auditLog.id))
      .limit(Math.min(filter.limit ?? 100, 1000));
  }
}
