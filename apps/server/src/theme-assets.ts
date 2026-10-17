import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { PermissionChecker, SettingValues } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { detectImage } from './chat/images.js';
import { schema, type Db } from './db/index.js';

export type AssetErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'FORMAT' | 'TOO_LARGE' | 'LIMIT';

export class AssetError extends Error {
  constructor(
    public code: AssetErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export const ASSET_KINDS = ['felt', 'roomBg', 'cardBack', 'logo'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/**
 * Obrázky pro motivy (textura plsti, pozadí místnosti, rub karet, logo). Soubory jsou na disku pod náhodným
 * id; typ se pozná podle obsahu (SVG se nepřijímá). Motiv na obrázek odkazuje jen jako `asset:<id>`.
 */
export class ThemeAssets {
  constructor(
    private deps: {
      db: Db;
      perms: PermissionChecker;
      audit: AuditService;
      settings: () => SettingValues;
      dir: string;
    },
  ) {}

  async init(): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true });
  }

  private file(id: string) {
    return join(this.deps.dir, `${id}.bin`);
  }

  async upload(userId: string, kind: string, data: Buffer): Promise<{ id: string; kind: AssetKind }> {
    if (!this.deps.perms.can(userId, 'motiv.vytvorit').allowed) throw new AssetError('FORBIDDEN');
    if (!ASSET_KINDS.includes(kind as AssetKind)) throw new AssetError('INVALID', { field: 'kind' });
    const s = this.deps.settings();
    const max = Number(s['theme.imageMaxKb']);
    if (data.length > max * 1024) throw new AssetError('TOO_LARGE', { max });
    const format = detectImage(data);
    if (!format) throw new AssetError('INVALID', { field: 'data' });
    const allowed = String(s['theme.imageFormats']).split(',').map((x) => x.trim().toLowerCase().replace('jpeg', 'jpg'));
    if (!allowed.includes(format)) throw new AssetError('FORMAT');
    const mine = await this.deps.db.select({ id: schema.themeAssets.id }).from(schema.themeAssets).where(eq(schema.themeAssets.ownerId, userId));
    if (mine.length >= Number(s['theme.maxImagesPerUser'])) throw new AssetError('LIMIT', { max: Number(s['theme.maxImagesPerUser']) });
    const id = randomUUID();
    await writeFile(this.file(id), data);
    await this.deps.db.insert(schema.themeAssets).values({ id, ownerId: userId, kind, mime: MIME[format]!, sizeBytes: data.length });
    await this.deps.audit.log({ actorId: userId, action: 'motiv.obrazek_nahran', targetType: 'theme_asset', targetId: id, after: { kind } });
    return { id, kind: kind as AssetKind };
  }

  async list(userId: string) {
    const rows = await this.deps.db.select().from(schema.themeAssets).where(eq(schema.themeAssets.ownerId, userId)).orderBy(desc(schema.themeAssets.createdAt));
    return rows.map((r) => ({ id: r.id, kind: r.kind, sizeBytes: r.sizeBytes, createdAt: r.createdAt.getTime() }));
  }

  /** Obsah obrázku: smí ho číst každý přihlášený (sdílené motivy ho potřebují). */
  async read(id: string): Promise<{ data: Buffer; mime: string }> {
    const [r] = await this.deps.db.select().from(schema.themeAssets).where(eq(schema.themeAssets.id, id));
    if (!r) throw new AssetError('NOT_FOUND');
    try {
      return { data: await readFile(this.file(id)), mime: r.mime };
    } catch {
      throw new AssetError('NOT_FOUND');
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    const [r] = await this.deps.db.select().from(schema.themeAssets).where(eq(schema.themeAssets.id, id));
    if (!r) throw new AssetError('NOT_FOUND');
    if (r.ownerId !== userId && !this.deps.perms.can(userId, 'motiv.schvalit').allowed) throw new AssetError('FORBIDDEN');
    await this.deps.db.delete(schema.themeAssets).where(and(eq(schema.themeAssets.id, id)));
    await rm(this.file(id), { force: true });
    await this.deps.audit.log({ actorId: userId, action: 'motiv.obrazek_smazan', targetType: 'theme_asset', targetId: id });
  }
}
