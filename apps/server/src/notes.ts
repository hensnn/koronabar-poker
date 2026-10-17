import { and, asc, eq } from 'drizzle-orm';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';

export type NotesErrorCode = 'INVALID' | 'NOT_FOUND' | 'LIMIT';

export class NotesError extends Error {
  constructor(
    public code: NotesErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** Barvy štítků jsou klíče designových tokenů, ne pevné hodnoty. */
export const NOTE_COLORS = ['primary', 'secondary', 'accent', 'success', 'warning', 'danger', 'muted'] as const;
const MAX_LABELS = 12;
const MAX_NOTES = 500;
const MAX_NOTE_LENGTH = 1000;
const MAX_LABEL_NAME = 20;

type Meta = { ip?: string | null };

/** Soukromé poznámky a barevné štítky k ostatním hráčům. Vidí je jen jejich autor; synchronizují se mezi zařízeními. */
export class NotesService {
  constructor(private deps: { db: Db; audit: AuditService; now: () => number }) {}

  async list(ownerId: string) {
    const db = this.deps.db;
    const labels = await db.select().from(schema.noteLabels).where(eq(schema.noteLabels.ownerId, ownerId)).orderBy(asc(schema.noteLabels.createdAt));
    const notes = await db
      .select({ targetId: schema.playerNotes.targetId, note: schema.playerNotes.note, labelId: schema.playerNotes.labelId, updatedAt: schema.playerNotes.updatedAt, nickname: schema.users.nickname })
      .from(schema.playerNotes)
      .innerJoin(schema.users, eq(schema.users.id, schema.playerNotes.targetId))
      .where(eq(schema.playerNotes.ownerId, ownerId));
    return {
      colors: NOTE_COLORS,
      labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
      notes: notes.map((n) => ({ targetId: n.targetId, nickname: n.nickname, note: n.note, labelId: n.labelId, updatedAt: n.updatedAt.getTime() })),
    };
  }

  private checkLabel(name: unknown, color: unknown): { name: string; color: string } {
    const n = typeof name === 'string' ? name.trim() : '';
    if (n.length < 1 || n.length > MAX_LABEL_NAME || !(NOTE_COLORS as readonly string[]).includes(String(color))) throw new NotesError('INVALID', { field: 'label' });
    return { name: n, color: String(color) };
  }

  async createLabel(ownerId: string, name: unknown, color: unknown): Promise<{ id: string }> {
    const v = this.checkLabel(name, color);
    const mine = await this.deps.db.select({ id: schema.noteLabels.id }).from(schema.noteLabels).where(eq(schema.noteLabels.ownerId, ownerId));
    if (mine.length >= MAX_LABELS) throw new NotesError('LIMIT', { max: MAX_LABELS });
    const [row] = await this.deps.db.insert(schema.noteLabels).values({ ownerId, ...v }).returning({ id: schema.noteLabels.id });
    return { id: row!.id };
  }

  async updateLabel(ownerId: string, id: string, name: unknown, color: unknown): Promise<void> {
    const v = this.checkLabel(name, color);
    const rows = await this.deps.db.update(schema.noteLabels).set(v).where(and(eq(schema.noteLabels.id, id), eq(schema.noteLabels.ownerId, ownerId))).returning({ id: schema.noteLabels.id });
    if (rows.length === 0) throw new NotesError('NOT_FOUND');
  }

  /** Smazání štítku odebere jen štítek, poznámky zůstanou. */
  async deleteLabel(ownerId: string, id: string): Promise<void> {
    const rows = await this.deps.db.delete(schema.noteLabels).where(and(eq(schema.noteLabels.id, id), eq(schema.noteLabels.ownerId, ownerId))).returning({ id: schema.noteLabels.id });
    if (rows.length === 0) throw new NotesError('NOT_FOUND');
  }

  /** Uloží poznámku a štítek; prázdná poznámka bez štítku záznam smaže. */
  async put(ownerId: string, targetId: string, note: unknown, labelId: unknown, meta: Meta = {}): Promise<void> {
    if (targetId === ownerId) throw new NotesError('INVALID', { field: 'target' });
    const text = typeof note === 'string' ? note.trim() : '';
    if (text.length > MAX_NOTE_LENGTH) throw new NotesError('INVALID', { field: 'note', max: MAX_NOTE_LENGTH });
    let label: string | null = null;
    if (labelId !== null && labelId !== undefined && labelId !== '') {
      const [l] = await this.deps.db.select({ id: schema.noteLabels.id }).from(schema.noteLabels).where(and(eq(schema.noteLabels.id, String(labelId)), eq(schema.noteLabels.ownerId, ownerId)));
      if (!l) throw new NotesError('INVALID', { field: 'label' });
      label = l.id;
    }
    const [target] = await this.deps.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, targetId));
    if (!target) throw new NotesError('NOT_FOUND');
    if (!text && !label) {
      await this.deps.db.delete(schema.playerNotes).where(and(eq(schema.playerNotes.ownerId, ownerId), eq(schema.playerNotes.targetId, targetId)));
      return;
    }
    const mine = await this.deps.db.select({ t: schema.playerNotes.targetId }).from(schema.playerNotes).where(eq(schema.playerNotes.ownerId, ownerId));
    if (mine.length >= MAX_NOTES && !mine.some((x) => x.t === targetId)) throw new NotesError('LIMIT', { max: MAX_NOTES });
    const values = { ownerId, targetId, note: text, labelId: label, updatedAt: new Date(this.deps.now()) };
    await this.deps.db.insert(schema.playerNotes).values(values).onConflictDoUpdate({ target: [schema.playerNotes.ownerId, schema.playerNotes.targetId], set: { note: text, labelId: label, updatedAt: values.updatedAt } });
    void meta;
  }

  async remove(ownerId: string, targetId: string): Promise<void> {
    await this.deps.db.delete(schema.playerNotes).where(and(eq(schema.playerNotes.ownerId, ownerId), eq(schema.playerNotes.targetId, targetId)));
  }

  /** Export poznámek a štítků (JSON), jen vlastních. */
  async export(ownerId: string): Promise<string> {
    const d = await this.list(ownerId);
    const name = new Map(d.labels.map((l) => [l.id, l]));
    return JSON.stringify(
      {
        labels: d.labels.map((l) => ({ name: l.name, color: l.color })),
        notes: d.notes.map((n) => ({ player: n.nickname, note: n.note, label: n.labelId ? (name.get(n.labelId)?.name ?? null) : null, updatedAt: new Date(n.updatedAt).toISOString() })),
      },
      null,
      2,
    );
  }
}
