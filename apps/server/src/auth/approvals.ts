import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from '../db/index.js';
import type { AuditService, AuditSource } from './audit.js';
import { PermissionError, type PermissionService } from './permissions.js';

export type ApprovalExecutor = (payload: Record<string, unknown>, requestedBy: string) => Promise<unknown>;

export interface ApprovalNotify {
  (e: { kind: 'requested' | 'decided'; approvalId: string; action: string; requestedBy: string; decidedBy?: string; approved?: boolean }): void;
}

/**
 * Princip čtyř očí: vybrané akce navrhne jedna osoba a provede se až po schválení jinou osobou
 * s příslušným oprávněním. Nikdo nesmí schválit vlastní požadavek. Provedení jde stejnou cestou
 * (registrovaný „executor“) jako přímé provedení, takže platí stejné kontroly a audit.
 */
export class ApprovalService {
  private executors = new Map<string, ApprovalExecutor>();

  constructor(
    private db: Db,
    private perms: PermissionService,
    private audit: AuditService,
    private opts: { now?: () => Date; notify?: ApprovalNotify; expiryHours?: () => number } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  register(action: string, executor: ApprovalExecutor): void {
    this.executors.set(action, executor);
  }

  async request(actorId: string, action: string, payload: Record<string, unknown>, meta: { ip?: string | null; source?: AuditSource; reason?: string } = {}): Promise<string> {
    const [row] = await this.db.insert(schema.approvalRequests).values({ action, payload, requestedBy: actorId, createdAt: this.now() }).returning({ id: schema.approvalRequests.id });
    await this.audit.log({ actorId, action: 'schvalovani.zadost', targetType: 'approval', targetId: row!.id, after: { action, payload }, ...meta });
    this.opts.notify?.({ kind: 'requested', approvalId: row!.id, action, requestedBy: actorId });
    return row!.id;
  }

  private expired(createdAt: Date): boolean {
    const hours = this.opts.expiryHours?.() ?? 72;
    return this.now().getTime() - createdAt.getTime() > hours * 3600_000;
  }

  /** Žádosti: vlastní, a ty, které smím rozhodnout (u akcí, na které mám oprávnění). */
  async list(actorId: string, status?: string) {
    const rows = await this.db.select().from(schema.approvalRequests).where(status ? eq(schema.approvalRequests.status, status) : undefined).orderBy(desc(schema.approvalRequests.createdAt)).limit(200);
    const canDecide = this.perms.can(actorId, 'schvalovani.rozhodovat').allowed;
    return rows
      .filter((r) => r.requestedBy === actorId || (canDecide && this.perms.can(actorId, r.action).allowed))
      .map((r) => ({ ...r, status: r.status === 'pending' && this.expired(r.createdAt) ? 'expired' : r.status }));
  }

  async decide(approverId: string, id: string, approve: boolean, note: string | null = null, meta: { ip?: string | null; source?: AuditSource } = {}): Promise<{ status: string; result?: unknown }> {
    const [req] = await this.db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, id));
    if (!req) throw new PermissionError('NOT_FOUND');
    if (req.requestedBy === approverId) throw new PermissionError('FORBIDDEN', { reason: 'self_approval' });
    if (!this.perms.can(approverId, 'schvalovani.rozhodovat').allowed || !this.perms.can(approverId, req.action).allowed) throw new PermissionError('FORBIDDEN');
    if (req.status !== 'pending') throw new PermissionError('INVALID', { field: 'status', status: req.status });
    if (this.expired(req.createdAt)) {
      await this.db.update(schema.approvalRequests).set({ status: 'expired' }).where(eq(schema.approvalRequests.id, id));
      throw new PermissionError('INVALID', { field: 'status', status: 'expired' });
    }
    // Rozhodnutí se zapíše jen jednou (podmínka na stav), i při souběžném schvalování.
    const [claimed] = await this.db
      .update(schema.approvalRequests)
      .set({ status: approve ? 'approved' : 'rejected', decidedBy: approverId, decidedAt: this.now(), decisionNote: note })
      .where(and(eq(schema.approvalRequests.id, id), eq(schema.approvalRequests.status, 'pending')))
      .returning({ id: schema.approvalRequests.id });
    if (!claimed) throw new PermissionError('INVALID', { field: 'status' });
    let result: unknown;
    let status = approve ? 'approved' : 'rejected';
    if (approve) {
      const exec = this.executors.get(req.action);
      if (!exec) throw new Error(`Chybí executor pro akci ${req.action}`);
      try {
        result = await exec(req.payload as Record<string, unknown>, req.requestedBy);
        status = 'executed';
      } catch (e) {
        status = 'failed';
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      await this.db.update(schema.approvalRequests).set({ status, result: result as never }).where(eq(schema.approvalRequests.id, id));
    }
    await this.audit.log({ actorId: approverId, action: approve ? 'schvalovani.schvaleno' : 'schvalovani.zamitnuto', targetType: 'approval', targetId: id, after: { action: req.action, status }, reason: note, ...meta });
    this.opts.notify?.({ kind: 'decided', approvalId: id, action: req.action, requestedBy: req.requestedBy, decidedBy: approverId, approved: approve });
    return { status, result };
  }

  async pendingFor(userIds: string[]) {
    return userIds.length ? this.db.select().from(schema.approvalRequests).where(and(inArray(schema.approvalRequests.requestedBy, userIds), eq(schema.approvalRequests.status, 'pending'))) : [];
  }
}
