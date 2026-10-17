import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { PermissionChecker, SettingValues } from '@kb/shared';
import { builtinSounds, detectFormat, type AudioFormat, type AudioProcessor } from './audio.js';
import { schema, type Db } from './db/index.js';

export type SoundErrorCode =
  | 'DISABLED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_NAME'
  | 'INVALID_SHORTCUT'
  | 'SHORTCUT_TAKEN'
  | 'FORMAT_NOT_ALLOWED'
  | 'FILE_TOO_LARGE'
  | 'INVALID_AUDIO'
  | 'TOO_LONG'
  | 'LIMIT_REACHED'
  | 'QUOTA_EXCEEDED'
  | 'BUILTIN'
  | 'TOOL_MISSING'
  | 'BAD_STATE';

export class SoundError extends Error {
  constructor(
    public code: SoundErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export interface SoundDto {
  id: string;
  name: string;
  shortcut: string;
  emoji: string;
  category: string;
  status: string;
  builtin: boolean;
  durationMs: number;
  sizeBytes: number;
  mine: boolean;
  ownerNickname: string | null;
  favorite: boolean;
  lastUsedAt: number | null;
  uses: number;
}

export interface PlayTarget {
  kind: 'table' | 'channel';
  id: string;
}

export interface SoundEvent {
  soundId: string;
  shortcut: string;
  name: string;
  emoji: string;
  durationMs: number;
  from: { userId: string; nickname: string };
  target: PlayTarget;
  /** Překročený limit: příjemci uvidí jen emotikon bez zvuku. */
  silent: boolean;
  /** Nástupová nebo vítězná znělka (příjemce je může vypnout). */
  jingle?: boolean;
}

export interface UploadInput {
  name: string;
  shortcut: string;
  emoji?: string;
  category?: string;
  data: Buffer;
  /** Přípona původního souboru, jak ji poslal klient. */
  ext: string;
  startMs?: number;
  endMs?: number;
  share?: boolean;
}

const SHORTCUT = /^[a-z0-9_]{2,20}$/;
const MB = 1024 * 1024;

/**
 * Knihovna zvukových emotikonů: nahrávání s kontrolou, ořezem a normalizací, osobní a sdílené položky
 * se schvalováním, oblíbené, ztlumení a odesílání s limity proti otravování.
 */
export class SoundService {
  private lastByUser = new Map<string, number>();
  private lastBySound = new Map<string, number>();
  private windows = new Map<string, number[]>();

  constructor(
    private deps: {
      db: Db;
      perms: PermissionChecker;
      settings: () => SettingValues;
      dir: string;
      processor: AudioProcessor;
      now: () => number;
      /** Smí uživatel psát do stolu nebo kanálu (sedí u stolu, člen kanálu…). */
      canSend: (userId: string, target: PlayTarget) => Promise<boolean>;
      emit: (target: PlayTarget, e: SoundEvent) => void;
      /** Zapíše zprávu s emotikonem do chatu (u kanálů). */
      post?: (userId: string, channelId: string, body: string) => Promise<unknown>;
      nickOf: (userId: string) => Promise<string>;
      /** Zvuk, který si hráč zvolil jako nástupovou nebo vítěznou znělku (prázdné = žádný). */
      /** Sloty pro zvuky navíc z kosmetických předmětů. */
      extraSlots?: (userId: string) => Promise<number>;
      jinglePref?: (userId: string, kind: 'join' | 'win') => string;
      /** Znělka zazněla (televize). */
      onJingle?: (e: SoundEvent, kind: 'join' | 'win') => void;
    },
  ) {}

  private lastJingle = new Map<string, number>();

  private get s(): SettingValues {
    return this.deps.settings();
  }

  /** Vytvoří složku a vestavěné zvuky (jen pokud ještě nejsou). */
  async init(): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true });
    const have = new Set((await this.deps.db.select({ s: schema.soundEmotes.shortcut }).from(schema.soundEmotes).where(eq(schema.soundEmotes.builtin, true))).map((r) => r.s));
    for (const b of builtinSounds()) {
      if (have.has(b.shortcut)) continue;
      const id = randomUUID();
      await writeFile(this.file(id), b.data);
      await this.deps.db.insert(schema.soundEmotes).values({ id, ownerId: null, name: b.name, shortcut: b.shortcut, emoji: b.emoji, category: b.category, status: 'shared', mime: 'audio/wav', durationMs: b.durationMs, sizeBytes: b.data.length, builtin: true }).onConflictDoNothing();
    }
  }

  private file(id: string): string {
    return join(this.deps.dir, `${id}.bin`);
  }

  private enabled(): void {
    if (!this.s['sounds.enabled']) throw new SoundError('DISABLED');
  }

  private can(userId: string, key: string): boolean {
    return this.deps.perms.can(userId, key).allowed;
  }

  // ---------- čtení ----------

  private async dtos(rows: (typeof schema.soundEmotes.$inferSelect)[], userId: string): Promise<SoundDto[]> {
    if (rows.length === 0) return [];
    const fav = await this.deps.db.select().from(schema.soundFavorites).where(and(eq(schema.soundFavorites.userId, userId), inArray(schema.soundFavorites.soundId, rows.map((r) => r.id))));
    const owners = rows.map((r) => r.ownerId).filter((x): x is string => !!x);
    const nicks = new Map(owners.length ? (await this.deps.db.select({ id: schema.users.id, n: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, owners))).map((u) => [u.id, u.n]) : []);
    return rows.map((r) => {
      const f = fav.find((x) => x.soundId === r.id);
      return {
        id: r.id,
        name: r.name,
        shortcut: r.shortcut,
        emoji: r.emoji,
        category: r.category,
        status: r.status,
        builtin: r.builtin,
        durationMs: r.durationMs,
        sizeBytes: r.sizeBytes,
        mine: r.ownerId === userId,
        ownerNickname: r.ownerId ? (nicks.get(r.ownerId) ?? null) : null,
        favorite: f?.favorite ?? false,
        lastUsedAt: f?.lastUsedAt?.getTime() ?? null,
        uses: f?.uses ?? 0,
      };
    });
  }

  /** Vestavěné, sdílené a vlastní zvuky (včetně vlastních čekajících na schválení). */
  async list(userId: string): Promise<SoundDto[]> {
    const rows = await this.deps.db
      .select()
      .from(schema.soundEmotes)
      .where(or(eq(schema.soundEmotes.status, 'shared'), eq(schema.soundEmotes.ownerId, userId)));
    return (await this.dtos(rows, userId)).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  }

  /** Fronta ke schválení pro kurátora. */
  async pending(actorId: string): Promise<SoundDto[]> {
    if (!this.can(actorId, 'emotikon.schvalit')) throw new SoundError('FORBIDDEN');
    return this.dtos(await this.deps.db.select().from(schema.soundEmotes).where(eq(schema.soundEmotes.status, 'pending')), actorId);
  }

  /** Všechny zvuky včetně skrytých (správce). */
  async all(actorId: string): Promise<SoundDto[]> {
    if (!this.can(actorId, 'emotikon.spravovat')) throw new SoundError('FORBIDDEN');
    return this.dtos(await this.deps.db.select().from(schema.soundEmotes), actorId);
  }

  private async load(id: string) {
    const [r] = await this.deps.db.select().from(schema.soundEmotes).where(eq(schema.soundEmotes.id, id));
    if (!r) throw new SoundError('NOT_FOUND');
    return r;
  }

  private visibleTo(r: typeof schema.soundEmotes.$inferSelect, userId: string): boolean {
    return r.status === 'shared' || r.ownerId === userId || this.can(userId, 'emotikon.schvalit') || this.can(userId, 'emotikon.spravovat');
  }

  async audio(userId: string, id: string): Promise<{ data: Buffer; mime: string }> {
    const r = await this.load(id);
    if (!this.visibleTo(r, userId)) throw new SoundError('NOT_FOUND');
    try {
      return { data: await readFile(this.file(id)), mime: r.mime };
    } catch {
      throw new SoundError('NOT_FOUND');
    }
  }

  /** Soubor zvuku bez kontroly viditelnosti (televize smí jen to, co právě zaznělo jako znělka). */
  async rawAudio(id: string): Promise<{ data: Buffer; mime: string }> {
    const r = await this.load(id);
    try {
      return { data: await readFile(this.file(id)), mime: r.mime };
    } catch {
      throw new SoundError('NOT_FOUND');
    }
  }

  /** Znělka hráče: zvuk, který si zvolil, zazní u stolu nebo v turnaji. Chybějící, skrytý nebo cizí zvuk, vypnutí a odstup znělku tiše vynechají. */
  async jingle(userId: string, kind: 'join' | 'win', target: PlayTarget): Promise<boolean> {
    const s = this.s;
    if (!s['sounds.enabled'] || !s['sounds.jingleEnabled']) return false;
    const soundId = this.deps.jinglePref?.(userId, kind);
    if (!soundId) return false;
    const now = this.deps.now();
    if (now - (this.lastJingle.get(`${userId}:${kind}`) ?? -Infinity) < Number(s['sounds.jingleCooldownSeconds']) * 1000) return false;
    let r;
    try {
      r = await this.load(soundId);
    } catch {
      return false;
    }
    if (!this.visibleTo(r, userId) || r.status === 'hidden') return false;
    this.lastJingle.set(`${userId}:${kind}`, now);
    const event: SoundEvent = { soundId, shortcut: r.shortcut, name: r.name, emoji: r.emoji, durationMs: r.durationMs, from: { userId, nickname: await this.deps.nickOf(userId) }, target, silent: false, jingle: true };
    this.deps.emit(target, event);
    this.deps.onJingle?.(event, kind);
    return true;
  }

  async usage(): Promise<{ bytes: number; quotaBytes: number; count: number }> {
    const [u] = await this.deps.db.select({ bytes: sql<string>`coalesce(sum(${schema.soundEmotes.sizeBytes}), 0)`, count: sql<number>`count(*)` }).from(schema.soundEmotes).where(eq(schema.soundEmotes.builtin, false));
    return { bytes: Number(u?.bytes ?? 0), quotaBytes: Number(this.s['sounds.storageQuotaMb']) * MB, count: Number(u?.count ?? 0) };
  }

  // ---------- nahrávání ----------

  /** Zkontroluje a zpracuje soubor, ale nic neukládá (náhled před uložením). */
  async check(userId: string, input: Pick<UploadInput, 'data' | 'ext' | 'startMs' | 'endMs'>): Promise<{ format: AudioFormat; sourceMs: number; startMs: number; endMs: number }> {
    this.enabled();
    if (!this.can(userId, 'emotikon.nahrat')) throw new SoundError('FORBIDDEN');
    const allowed = String(this.s['sounds.formats']).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const maxBytes = Number(this.s['sounds.maxFileKb']) * 1024;
    if (input.data.length > maxBytes) throw new SoundError('FILE_TOO_LARGE', { max: Number(this.s['sounds.maxFileKb']) });
    const format = detectFormat(input.data);
    const ext = input.ext.toLowerCase().replace(/^\./, '');
    const extFormat = ext === 'mp4' || ext === 'aac' ? 'm4a' : ext;
    if (!format || !allowed.includes(format) || (extFormat !== format && !(format === 'm4a' && ext === 'm4a'))) throw new SoundError(format && !allowed.includes(format) ? 'FORMAT_NOT_ALLOWED' : 'INVALID_AUDIO');
    let sourceMs: number;
    try {
      sourceMs = (await this.deps.processor.probe(input.data, format)).durationMs;
    } catch (e) {
      throw new SoundError(e instanceof Error && e.message === 'TOOL_MISSING' ? 'TOOL_MISSING' : 'INVALID_AUDIO');
    }
    const startMs = Math.max(0, Math.min(input.startMs ?? 0, sourceMs));
    const endMs = Math.max(startMs, Math.min(input.endMs ?? sourceMs, sourceMs));
    if (endMs - startMs < 100) throw new SoundError('INVALID_AUDIO');
    const maxMs = Number(this.s['sounds.maxSeconds']) * 1000;
    if (endMs - startMs > maxMs) throw new SoundError('TOO_LONG', { max: Number(this.s['sounds.maxSeconds']) });
    return { format, sourceMs, startMs, endMs };
  }

  async upload(userId: string, input: UploadInput): Promise<SoundDto> {
    const name = input.name?.trim() ?? '';
    const shortcut = (input.shortcut ?? '').trim().toLowerCase().replace(/^:|:$/g, '');
    if (!name || name.length > 40) throw new SoundError('INVALID_NAME');
    if (!SHORTCUT.test(shortcut)) throw new SoundError('INVALID_SHORTCUT');
    const mineCount = (await this.deps.db.select({ id: schema.soundEmotes.id }).from(schema.soundEmotes).where(eq(schema.soundEmotes.ownerId, userId))).length;
    const maxSounds = Number(this.s['sounds.maxPerUser']) + ((await this.deps.extraSlots?.(userId)) ?? 0);
    if (mineCount >= maxSounds) throw new SoundError('LIMIT_REACHED', { max: maxSounds });
    const c = await this.check(userId, input);
    const [taken] = await this.deps.db.select({ id: schema.soundEmotes.id }).from(schema.soundEmotes).where(eq(schema.soundEmotes.shortcut, shortcut));
    if (taken) throw new SoundError('SHORTCUT_TAKEN');
    let out;
    try {
      out = await this.deps.processor.process(input.data, c.format, { startMs: c.startMs, endMs: c.endMs, loudness: Number(this.s['sounds.loudnessTarget']) });
    } catch (e) {
      throw new SoundError(e instanceof Error && e.message === 'TOOL_MISSING' ? 'TOOL_MISSING' : 'INVALID_AUDIO');
    }
    const u = await this.usage();
    if (u.bytes + out.data.length > u.quotaBytes) throw new SoundError('QUOTA_EXCEEDED');
    const id = randomUUID();
    await writeFile(this.file(id), out.data);
    const status = input.share ? (this.s['sounds.requireApproval'] ? 'pending' : 'shared') : 'private';
    try {
      await this.deps.db.insert(schema.soundEmotes).values({ id, ownerId: userId, name, shortcut, emoji: (input.emoji ?? '🔊').slice(0, 8) || '🔊', category: (input.category ?? 'ostatni').slice(0, 30) || 'ostatni', status, mime: out.mime, durationMs: out.durationMs, sizeBytes: out.data.length });
    } catch (e) {
      await rm(this.file(id), { force: true });
      throw e;
    }
    return (await this.dtos([await this.load(id)], userId))[0]!;
  }

  // ---------- správa ----------

  private async own(userId: string, id: string, manage = false) {
    const r = await this.load(id);
    if (r.ownerId !== userId && !(manage && this.can(userId, 'emotikon.spravovat'))) throw new SoundError('FORBIDDEN');
    return r;
  }

  async update(userId: string, id: string, patch: { name?: string; emoji?: string; category?: string }): Promise<void> {
    const r = await this.own(userId, id, true);
    if (r.builtin && !this.can(userId, 'emotikon.spravovat')) throw new SoundError('BUILTIN');
    const set: Partial<typeof schema.soundEmotes.$inferInsert> = {};
    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (!n || n.length > 40) throw new SoundError('INVALID_NAME');
      set.name = n;
    }
    if (patch.emoji !== undefined) set.emoji = patch.emoji.slice(0, 8) || '🔊';
    if (patch.category !== undefined) set.category = patch.category.slice(0, 30) || 'ostatni';
    if (Object.keys(set).length) await this.deps.db.update(schema.soundEmotes).set(set).where(eq(schema.soundEmotes.id, id));
  }

  /** Autor nabídne zvuk do společné knihovny (nebo ho stáhne zpět). */
  async share(userId: string, id: string, on: boolean): Promise<string> {
    this.enabled();
    const r = await this.own(userId, id);
    if (r.builtin || r.status === 'hidden') throw new SoundError('BAD_STATE');
    const status = on ? (this.s['sounds.requireApproval'] ? 'pending' : 'shared') : 'private';
    await this.deps.db.update(schema.soundEmotes).set({ status }).where(eq(schema.soundEmotes.id, id));
    return status;
  }

  async review(actorId: string, id: string, approve: boolean): Promise<void> {
    if (!this.can(actorId, 'emotikon.schvalit')) throw new SoundError('FORBIDDEN');
    const r = await this.load(id);
    if (r.status !== 'pending') throw new SoundError('BAD_STATE');
    await this.deps.db.update(schema.soundEmotes).set({ status: approve ? 'shared' : 'private' }).where(eq(schema.soundEmotes.id, id));
  }

  async hide(actorId: string, id: string, hidden: boolean): Promise<void> {
    if (!this.can(actorId, 'emotikon.spravovat')) throw new SoundError('FORBIDDEN');
    const r = await this.load(id);
    await this.deps.db.update(schema.soundEmotes).set({ status: hidden ? 'hidden' : r.ownerId && !r.builtin ? 'shared' : 'shared' }).where(eq(schema.soundEmotes.id, id));
  }

  async remove(userId: string, id: string): Promise<void> {
    const r = await this.own(userId, id, true);
    if (r.builtin) throw new SoundError('BUILTIN');
    await this.deps.db.delete(schema.soundEmotes).where(eq(schema.soundEmotes.id, id));
    await rm(this.file(id), { force: true });
  }

  // ---------- oblíbené a ztlumení ----------

  async favorite(userId: string, id: string, on: boolean): Promise<void> {
    const r = await this.load(id);
    if (!this.visibleTo(r, userId)) throw new SoundError('NOT_FOUND');
    await this.deps.db
      .insert(schema.soundFavorites)
      .values({ userId, soundId: id, favorite: on })
      .onConflictDoUpdate({ target: [schema.soundFavorites.userId, schema.soundFavorites.soundId], set: { favorite: on } });
  }

  async mutes(userId: string): Promise<{ kind: string; target: string }[]> {
    return this.deps.db.select({ kind: schema.soundMutes.kind, target: schema.soundMutes.target }).from(schema.soundMutes).where(eq(schema.soundMutes.userId, userId));
  }

  /** Ztlumení konkrétního zvuku (`sound`), hráče (`player`) nebo místa (`channel` / `table`). */
  async setMute(userId: string, kind: string, target: string, on: boolean): Promise<void> {
    if (!['sound', 'player', 'channel', 'table'].includes(kind) || !target || target.length > 80) throw new SoundError('BAD_STATE');
    if (on) await this.deps.db.insert(schema.soundMutes).values({ userId, kind, target }).onConflictDoNothing();
    else await this.deps.db.delete(schema.soundMutes).where(and(eq(schema.soundMutes.userId, userId), eq(schema.soundMutes.kind, kind), eq(schema.soundMutes.target, target)));
  }

  // ---------- odeslání ----------

  /** Pošle zvukový emotikon do stolu nebo kanálu. Při překročení limitů se pošle bez zvuku. */
  async play(userId: string, soundId: string, target: PlayTarget): Promise<{ silent: boolean }> {
    this.enabled();
    const r = await this.load(soundId);
    if (!this.visibleTo(r, userId) || r.status === 'hidden') throw new SoundError('NOT_FOUND');
    if (!(await this.deps.canSend(userId, target))) throw new SoundError('FORBIDDEN');
    const now = this.deps.now();
    const place = `${target.kind}:${target.id}`;
    let silent = false;
    const userCd = Number(this.s['sounds.userCooldownSeconds']) * 1000;
    const soundCd = Number(this.s['sounds.soundCooldownSeconds']) * 1000;
    if (now - (this.lastByUser.get(userId) ?? -Infinity) < userCd) silent = true;
    if (now - (this.lastBySound.get(`${place}:${soundId}`) ?? -Infinity) < soundCd) silent = true;
    const win = (this.windows.get(place) ?? []).filter((t) => now - t < 60_000);
    if (win.length >= Number(this.s['sounds.perMinuteLimit'])) silent = true;
    if (!silent) {
      win.push(now);
      this.lastByUser.set(userId, now);
      this.lastBySound.set(`${place}:${soundId}`, now);
    }
    this.windows.set(place, win);
    await this.deps.db
      .insert(schema.soundFavorites)
      .values({ userId, soundId, lastUsedAt: new Date(now), uses: 1 })
      .onConflictDoUpdate({ target: [schema.soundFavorites.userId, schema.soundFavorites.soundId], set: { lastUsedAt: new Date(now), uses: sql`${schema.soundFavorites.uses} + 1` } });
    this.deps.emit(target, { soundId, shortcut: r.shortcut, name: r.name, emoji: r.emoji, durationMs: r.durationMs, from: { userId, nickname: await this.deps.nickOf(userId) }, target, silent });
    if (target.kind === 'channel') await this.deps.post?.(userId, target.id, `:${r.shortcut}:`).catch(() => undefined);
    return { silent };
  }
}
