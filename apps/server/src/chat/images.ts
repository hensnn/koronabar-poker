import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, gte, lt } from 'drizzle-orm';
import type { SettingValues } from '@kb/shared';
import { schema, type Db } from '../db/index.js';
import { ChatError, type ChatService } from './service.js';

export type ImageFormat = 'png' | 'jpg' | 'gif' | 'webp';

const MIME: Record<ImageFormat, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** Pozná obrázek podle obsahu (přípona ani typ od klienta se nepoužívají). SVG se záměrně nepodporuje. */
export function detectImage(b: Buffer): ImageFormat | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Obrázky a GIFy ve zprávách chatu. Soubory jsou na disku pod náhodným id; stáhnout je smí jen ten,
 * kdo smí číst kanál, ve kterém je obrázek zveřejněn (autor i před odesláním).
 */
export class ChatImages {
  constructor(
    private deps: {
      db: Db;
      chat: ChatService;
      settings: () => SettingValues;
      dir: string;
      now: () => number;
    },
  ) {}

  async init(): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true });
  }

  private file(id: string) {
    return join(this.deps.dir, `${id}.bin`);
  }

  async upload(userId: string, data: Buffer): Promise<{ id: string }> {
    const s = this.deps.settings();
    if (!s['chat.imagesEnabled'] || !s['chat.enabled']) throw new ChatError('IMAGE_DISABLED');
    const max = Number(s['chat.imageMaxKb']);
    if (data.length > max * 1024) throw new ChatError('IMAGE_TOO_LARGE', { max });
    const format = detectImage(data);
    if (!format) throw new ChatError('IMAGE_INVALID');
    const allowed = String(s['chat.imageFormats']).split(',').map((x) => x.trim().toLowerCase().replace('jpeg', 'jpg')).filter(Boolean);
    if (!allowed.includes(format)) throw new ChatError('IMAGE_FORMAT');
    const id = randomUUID();
    await writeFile(this.file(id), data);
    await this.deps.db.insert(schema.chatImages).values({ id, ownerId: userId, mime: MIME[format], sizeBytes: data.length });
    return { id };
  }

  /** Obsah obrázku pro uživatele, který ho smí vidět. */
  async read(userId: string, id: string): Promise<{ data: Buffer; mime: string }> {
    const [img] = await this.deps.db.select().from(schema.chatImages).where(eq(schema.chatImages.id, id));
    if (!img) throw new ChatError('NOT_FOUND');
    if (!img.attached) {
      if (img.ownerId !== userId) throw new ChatError('NOT_FOUND');
    } else if (img.ownerId !== userId) {
      const [msg] = await this.deps.db.select({ channelId: schema.chatMessages.channelId }).from(schema.chatMessages).where(and(eq(schema.chatMessages.image, id)));
      if (!msg || !(await this.deps.chat.canRead(userId, msg.channelId))) throw new ChatError('NOT_FOUND');
    }
    try {
      return { data: await readFile(this.file(id)), mime: img.mime };
    } catch {
      throw new ChatError('NOT_FOUND');
    }
  }

  /** Smaže všechny obrázky v chatu (řádky i soubory); vrací jejich počet. */
  async purgeAll(): Promise<number> {
    const all = await this.deps.db.delete(schema.chatImages).returning({ id: schema.chatImages.id });
    for (const o of all) await rm(this.file(o.id), { force: true });
    return all.length;
  }

  /** Smaže obrázky vytvořené od zadaného času (řádky i soubory); vrací jejich počet. */
  async purgeSince(since: Date): Promise<number> {
    const rows = await this.deps.db.delete(schema.chatImages).where(gte(schema.chatImages.createdAt, since)).returning({ id: schema.chatImages.id });
    for (const o of rows) await rm(this.file(o.id), { force: true });
    return rows.length;
  }

  /** Smaže nepřipojené obrázky starší než den a soubory obrázků smazaných zpráv. */
  async purgeOld(): Promise<number> {
    const cutoff = new Date(this.deps.now() - 86_400_000);
    const old = await this.deps.db.delete(schema.chatImages).where(and(eq(schema.chatImages.attached, false), lt(schema.chatImages.createdAt, cutoff))).returning({ id: schema.chatImages.id });
    for (const o of old) await rm(this.file(o.id), { force: true });
    return old.length;
  }
}
