import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { PermissionChecker } from '@kb/shared';
import type { AuditService, AuditSource } from './auth/audit.js';
import { schema, type Db } from './db/index.js';
import type { TableManager } from './tables.js';
import type { TournamentManager } from './tournaments.js';

export class HistoryError extends Error {
  constructor(public readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'STATE' | 'INVALID') {
    super(code);
  }
}

interface Deps {
  db: Db;
  perms: PermissionChecker;
  audit: AuditService;
  tables: () => TableManager;
  tournaments: () => TournamentManager;
  now: () => number;
}

type Meta = { ip?: string | null; source?: AuditSource; reason?: string | null };

export type HistoryKind = 'tournament' | 'cashTable' | 'liveCash' | 'poll' | 'evening' | 'sharedHand';

export interface HistoryItem {
  kind: HistoryKind;
  id: string;
  name: string;
  status: string;
  at: number;
  /** Doplňující údaj (počet hand, autor…). */
  detail: string;
}

export interface HistoryOverview {
  items: HistoryItem[];
  hands: { total: number; oldest: number | null };
}

const DONE_TOURNAMENT = new Set(['finished', 'cancelled']);
const DONE_POLL = new Set(['closed', 'cancelled', 'tie']);

/**
 * Správa historie (oprávnění `historie.spravovat`): přehled uložených a už skončených věcí – turnaje, zavřené
 * cash stoly, živé cash hry, ankety, herní večery, sdílené handy – a jejich nevratné smazání. Rating, XP a
 * účetní kniha se nemažou (peníze nikdy nemizí); mažou se jen záznamy o průběhu.
 */
export class HistoryService {
  constructor(private deps: Deps) {}

  private can(actorId: string): void {
    if (!this.deps.perms.can(actorId, 'historie.spravovat').allowed) throw new HistoryError('FORBIDDEN');
  }

  async overview(actorId: string): Promise<HistoryOverview> {
    this.can(actorId);
    const db = this.deps.db;
    const users = new Map((await db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users)).map((u) => [u.id, u.nickname]));
    const nick = (id: string | null) => (id ? (users.get(id) ?? '–') : '–');
    const handCounts = new Map((await db.select({ tableId: schema.hands.tableId, n: sql<number>`count(*)::int` }).from(schema.hands).groupBy(schema.hands.tableId)).map((r) => [r.tableId, Number(r.n)]));
    const items: HistoryItem[] = [];
    const tournaments = this.deps.tournaments();
    for (const t of await tournaments.lobby()) if (DONE_TOURNAMENT.has(t.status)) items.push({ kind: 'tournament', id: t.id, name: t.name, status: t.status, at: t.createdAt, detail: `${t.players} ${'hráčů'}` });
    for (const r of await db.select().from(schema.gameTables).where(eq(schema.gameTables.status, 'closed'))) items.push({ kind: 'cashTable', id: r.id, name: r.name, status: r.status, at: r.createdAt.getTime(), detail: `${handCounts.get(r.id) ?? 0} hand` });
    for (const r of await db.select().from(schema.liveCashGames).where(eq(schema.liveCashGames.status, 'closed'))) items.push({ kind: 'liveCash', id: r.id, name: r.name, status: r.status, at: r.createdAt.getTime(), detail: nick(r.ownerId) });
    for (const r of await db.select({ id: schema.polls.id, title: schema.polls.title, status: schema.polls.status, endsAt: schema.polls.endsAt, founderId: schema.polls.founderId }).from(schema.polls).where(inArray(schema.polls.status, [...DONE_POLL]))) items.push({ kind: 'poll', id: r.id, name: r.title, status: r.status, at: r.endsAt.getTime(), detail: nick(r.founderId) });
    for (const r of await db.select().from(schema.evenings).where(eq(schema.evenings.status, 'closed'))) items.push({ kind: 'evening', id: r.id, name: r.name, status: r.status, at: r.startsAt.getTime(), detail: nick(r.createdBy) });
    for (const r of await db.select().from(schema.sharedHands)) items.push({ kind: 'sharedHand', id: r.id, name: r.handId, status: 'shared', at: r.createdAt.getTime(), detail: nick(r.sharedBy) });
    items.sort((a, b) => b.at - a.at);
    const [h] = await db.select({ n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${schema.hands.playedAt})` }).from(schema.hands);
    return { items, hands: { total: Number(h?.n ?? 0), oldest: h?.oldest ? new Date(h.oldest).getTime() : null } };
  }

  /** Smaže jednu položku historie (nevratné). */
  async remove(actorId: string, kind: HistoryKind, id: string, meta: Meta = {}): Promise<void> {
    this.can(actorId);
    const db = this.deps.db;
    switch (kind) {
      case 'tournament':
        await this.deps.tournaments().deleteFromHistory(actorId, id, meta);
        return;
      case 'cashTable': {
        const [row] = await db.select().from(schema.gameTables).where(eq(schema.gameTables.id, id));
        if (!row) throw new HistoryError('NOT_FOUND');
        if (row.status !== 'closed' || this.deps.tables().get(id)) throw new HistoryError('STATE');
        await db.delete(schema.hands).where(eq(schema.hands.tableId, id));
        await db.delete(schema.tableState).where(eq(schema.tableState.tableId, id));
        await db.delete(schema.eveningGames).where(and(eq(schema.eveningGames.kind, 'cash'), eq(schema.eveningGames.ref, id)));
        await db.delete(schema.chatChannels).where(eq(schema.chatChannels.key, `table:${id}`));
        await db.delete(schema.gameTables).where(eq(schema.gameTables.id, id));
        break;
      }
      case 'liveCash': {
        const [row] = await db.select().from(schema.liveCashGames).where(eq(schema.liveCashGames.id, id));
        if (!row) throw new HistoryError('NOT_FOUND');
        if (row.status !== 'closed') throw new HistoryError('STATE');
        await db.delete(schema.eveningGames).where(and(eq(schema.eveningGames.kind, 'live_cash'), eq(schema.eveningGames.ref, id)));
        await db.delete(schema.liveCashGames).where(eq(schema.liveCashGames.id, id));
        break;
      }
      case 'poll': {
        const [row] = await db.select({ status: schema.polls.status }).from(schema.polls).where(eq(schema.polls.id, id));
        if (!row) throw new HistoryError('NOT_FOUND');
        if (!DONE_POLL.has(row.status)) throw new HistoryError('STATE');
        await db.delete(schema.polls).where(eq(schema.polls.id, id));
        break;
      }
      case 'evening': {
        const [row] = await db.select({ status: schema.evenings.status }).from(schema.evenings).where(eq(schema.evenings.id, id));
        if (!row) throw new HistoryError('NOT_FOUND');
        if (row.status !== 'closed') throw new HistoryError('STATE');
        await db.delete(schema.evenings).where(eq(schema.evenings.id, id));
        break;
      }
      case 'sharedHand': {
        const [row] = await db.select({ id: schema.sharedHands.id }).from(schema.sharedHands).where(eq(schema.sharedHands.id, id));
        if (!row) throw new HistoryError('NOT_FOUND');
        await db.delete(schema.sharedHands).where(eq(schema.sharedHands.id, id));
        break;
      }
      default:
        throw new HistoryError('INVALID');
    }
    await this.deps.audit.log({ actorId, action: 'historie.smazat', targetType: kind, targetId: id, ...meta });
  }

  /** Smaže uložené handy starší než N dní (i jejich sdílení). Výsledky her, rating a XP zůstávají. */
  async purgeHands(actorId: string, olderThanDays: number, meta: Meta = {}): Promise<number> {
    this.can(actorId);
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) throw new HistoryError('INVALID');
    const db = this.deps.db;
    const before = new Date(this.deps.now() - olderThanDays * 86_400_000);
    const old = await db.select({ id: schema.hands.id }).from(schema.hands).where(lt(schema.hands.playedAt, before));
    if (old.length === 0) return 0;
    const ids = old.map((h) => h.id);
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      await db.delete(schema.sharedHands).where(inArray(schema.sharedHands.handId, part));
      await db.delete(schema.hands).where(or(inArray(schema.hands.id, part)));
    }
    await this.deps.audit.log({ actorId, action: 'historie.smazat_handy', targetType: 'system', after: { olderThanDays, deleted: ids.length }, ...meta });
    return ids.length;
  }
}
