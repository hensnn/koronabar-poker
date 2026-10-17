import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const EXT: Record<string, string> = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };
const MIME: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg' };

export const cacheKey = (source: string, voice: string, text: string): string => createHash('sha256').update(`${source}\n${voice}\n${text}`).digest('hex');

/** Mezipaměť namluvených hlášek na disku: každá stejná hláška se generuje jen jednou, nejstarší se mažou nad limit. */
export class AudioCache {
  constructor(private dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async get(key: string): Promise<{ data: Buffer; mime: string } | null> {
    for (const ext of Object.keys(MIME)) {
      try {
        const file = join(this.dir, `${key}.${ext}`);
        const data = await readFile(file);
        const now = new Date();
        void utimes(file, now, now).catch(() => undefined);
        return { data, mime: MIME[ext]! };
      } catch {
        // není v této příponě
      }
    }
    return null;
  }

  async put(key: string, data: Buffer, mime: string, maxBytes: number): Promise<void> {
    await writeFile(join(this.dir, `${key}.${EXT[mime] ?? 'wav'}`), data);
    await this.prune(maxBytes);
  }

  private async list(): Promise<{ name: string; size: number; at: number }[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const out: { name: string; size: number; at: number }[] = [];
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.(wav|mp3)$/.test(name)) continue;
      const s = await stat(join(this.dir, name)).catch(() => null);
      if (s) out.push({ name, size: s.size, at: s.mtimeMs });
    }
    return out;
  }

  async prune(maxBytes: number): Promise<void> {
    const files = (await this.list()).sort((a, b) => a.at - b.at);
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files) {
      if (total <= maxBytes) break;
      await rm(join(this.dir, f.name), { force: true });
      total -= f.size;
    }
  }

  async stats(): Promise<{ files: number; bytes: number }> {
    const files = await this.list();
    return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
  }

  async clear(): Promise<void> {
    for (const f of await this.list()) await rm(join(this.dir, f.name), { force: true });
  }
}
