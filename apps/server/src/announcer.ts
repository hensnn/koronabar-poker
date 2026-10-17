import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ANNOUNCE_EVENTS, announceEvent, cleanTemplates, defaultVariants, isEventEnabled, parseCountdown, pickVariant, renderTemplate, variantsOf, type AnnounceTemplates, type PermissionChecker, type SettingValues } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';
import type { TournamentManager } from './tournaments.js';
import { AudioCache, cacheKey } from './voice/cache.js';
import { piperSynthesize, piperVoices } from './voice/wyoming.js';

export type AnnouncerErrorCode = 'FORBIDDEN' | 'INVALID' | 'NO_AUDIO' | 'NOT_FOUND' | 'SOURCE_FAILED' | 'NO_KEY';

export class AnnouncerError extends Error {
  constructor(
    public code: AnnouncerErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export type VoiceSource = 'browser' | 'piper' | 'google';

/** Co dostane klient: text pro hlas prohlížeče a (je-li zdroj na serveru) id, podle kterého si stáhne namluvené audio. */
export interface AnnouncePayload {
  id: string;
  event: string;
  text: string;
  audio: boolean;
}

interface Recent {
  id: string;
  event: string;
  text: string;
  /** Kdy se hláška na televizi smí ozvat (u událostí stolu se zpožděním přenosu). */
  tvAt: number;
  at: number;
}

const TEMPLATES_KEY = 'announcer:templates';
const RECENT_MAX = 200;
const RECENT_TTL_MS = 10 * 60_000;
const TV_WINDOW_MS = 60_000;
const SYNTH_TIMEOUT_MS = 15_000;
const GOOGLE_BASE = 'https://texttospeech.googleapis.com/v1';

interface Deps {
  db: Db;
  perms: PermissionChecker;
  audit: AuditService;
  settings: () => SettingValues;
  now: () => number;
  secrets: { reveal(key: string): Promise<string | undefined> };
  /** Rozešle hlášku do místností Socket.IO. */
  emit: (rooms: string[], payload: AnnouncePayload) => void;
  tournaments: () => TournamentManager;
  dir: string;
  fetchImpl?: typeof fetch;
  rnd?: () => number;
}

type Meta = { ip?: string | null };

/**
 * Hlasatel: z událostí (stůl, turnaj, odpočet) vyrobí hlášku podle šablon, rozešle ji klientům a televizi a podle
 * nastaveného zdroje případně namluví na serveru (Piper přes Wyoming, Google TTS) s mezipamětí. Selhání zdroje se
 * zaznamená a klienti se vrátí k hlasu prohlížeče.
 */
export class AnnouncerService {
  private cache: AudioCache;
  private tpl: AnnounceTemplates = {};
  private last = new Map<string, number>();
  private recent = new Map<string, Recent>();
  private inflight = new Map<string, Promise<{ data: Buffer; mime: string }>>();
  private counted = new Set<string>();
  private failure: { source: string; error: string; since: number } | null = null;
  private rnd: () => number;
  private fetchImpl: typeof fetch;

  constructor(private deps: Deps) {
    this.cache = new AudioCache(deps.dir);
    this.rnd = deps.rnd ?? Math.random;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async init(): Promise<void> {
    await this.cache.init();
    const [r] = await this.deps.db.select().from(schema.systemMeta).where(eq(schema.systemMeta.key, TEMPLATES_KEY));
    const clean = cleanTemplates(r?.value ?? {});
    this.tpl = clean.ok ? clean.templates : {};
  }

  private s() {
    return this.deps.settings();
  }

  private manage(userId: string): void {
    if (!this.deps.perms.can(userId, 'hlasatel.spravovat').allowed) throw new AnnouncerError('FORBIDDEN');
  }

  // ---------- zdroje hlasu ----------

  sourceFor(audience: 'user' | 'tv'): VoiceSource {
    const s = this.s();
    const main = String(s['announcer.source']) as VoiceSource;
    if (audience === 'user') return main;
    const tv = String(s['announcer.tvSource']);
    return tv === 'same' ? main : (tv as VoiceSource);
  }

  private voiceName(source: VoiceSource): string {
    const s = this.s();
    return source === 'piper' ? String(s['announcer.piperVoice']) : source === 'google' ? String(s['announcer.googleVoice']) : '';
  }

  private fail(source: string, e: unknown): never {
    const error = e instanceof Error ? e.message : String(e);
    this.failure = { source, error, since: this.failure?.source === source ? this.failure.since : this.deps.now() };
    throw new AnnouncerError('SOURCE_FAILED', { error });
  }

  private async googleKey(): Promise<string> {
    const key = await this.deps.secrets.reveal('tts.google.apiKey');
    if (!key) throw new AnnouncerError('NO_KEY');
    return key;
  }

  private async rawSynth(source: Exclude<VoiceSource, 'browser'>, text: string): Promise<{ data: Buffer; mime: string }> {
    const s = this.s();
    if (source === 'piper') {
      const data = await piperSynthesize(text, { host: String(s['announcer.piperHost']), port: Number(s['announcer.piperPort']), voice: String(s['announcer.piperVoice']), timeoutMs: SYNTH_TIMEOUT_MS });
      return { data, mime: 'audio/wav' };
    }
    const key = await this.googleKey();
    const voice = String(s['announcer.googleVoice']);
    const lang = voice.split('-').slice(0, 2).join('-') || 'cs-CZ';
    const res = await this.fetchImpl(`${GOOGLE_BASE}/text:synthesize?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { text }, voice: { languageCode: lang, name: voice }, audioConfig: { audioEncoding: 'MP3' } }),
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Google TTS vrátilo ${res.status}`);
    const body = (await res.json()) as { audioContent?: string };
    if (!body.audioContent) throw new Error('Google TTS nevrátilo audio');
    return { data: Buffer.from(body.audioContent, 'base64'), mime: 'audio/mpeg' };
  }

  /** Namluví text zvoleným zdrojem; stejná hláška se generuje jen jednou (mezipaměť i sdílená rozpracovaná práce). */
  async synthesize(source: VoiceSource, text: string): Promise<{ data: Buffer; mime: string }> {
    if (source === 'browser') throw new AnnouncerError('NO_AUDIO');
    const key = cacheKey(source, this.voiceName(source), text);
    const hit = await this.cache.get(key);
    if (hit) return hit;
    const running = this.inflight.get(key);
    if (running) return running;
    const job = (async () => {
      try {
        const out = await this.rawSynth(source, text);
        await this.cache.put(key, out.data, out.mime, Number(this.s()['announcer.cacheMaxMb']) * 1024 * 1024);
        if (this.failure?.source === source) this.failure = null;
        return out;
      } catch (e) {
        if (e instanceof AnnouncerError && e.code === 'NO_KEY') {
          this.failure = { source, error: 'Chybí API klíč', since: this.deps.now() };
          throw e;
        }
        return this.fail(source, e);
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, job);
    return job;
  }

  // ---------- hlášky ----------

  templates(): AnnounceTemplates {
    return this.tpl;
  }

  /** Vyrobí hlášku z události a rozešle ji; vrací text (nebo null, když je vypnutá). */
  announce(event: string, vars: Record<string, string | number>, opts: { rooms: string[]; table?: boolean }): string | null {
    const s = this.s();
    if (!s['announcer.enabled'] || !announceEvent(event) || !isEventEnabled(event, this.tpl)) return null;
    const variants = variantsOf(event, this.tpl);
    const i = pickVariant(variants.length, this.last.get(event), this.rnd);
    this.last.set(event, i);
    const text = renderTemplate(variants[i]!, vars);
    if (!text) return null;
    const now = this.deps.now();
    const id = randomBytes(8).toString('hex');
    const delay = opts.table ? Number(s['tv.tableDelaySeconds']) * 1000 : 0;
    this.recent.set(id, { id, event, text, tvAt: now + delay, at: now });
    for (const [k, r] of this.recent) if (now - r.at > RECENT_TTL_MS || this.recent.size > RECENT_MAX) this.recent.delete(k);
    const audio = this.sourceFor('user') !== 'browser';
    this.deps.emit(opts.rooms, { id, event, text, audio });
    // Předehřátí mezipaměti, ať hráč nečeká na první přehrání.
    for (const src of new Set([this.sourceFor('user'), this.sourceFor('tv')])) if (src !== 'browser') void this.synthesize(src, text).catch(() => undefined);
    return text;
  }

  /** Audio k oznámení pro hráče nebo televizi. */
  async audioFor(id: string, audience: 'user' | 'tv'): Promise<{ data: Buffer; mime: string }> {
    const r = this.recent.get(id);
    if (!r) throw new AnnouncerError('NOT_FOUND');
    const source = this.sourceFor(audience);
    if (source === 'browser') throw new AnnouncerError('NO_AUDIO');
    return this.synthesize(source, r.text);
  }

  /** Hlášky pro televizi, které už mají zaznít (a nejsou starší než okno). */
  forTv(now: number): { id: string; event: string; text: string; at: number }[] {
    return [...this.recent.values()]
      .filter((r) => r.tvAt <= now && now - r.tvAt < TV_WINDOW_MS)
      .sort((a, b) => a.tvAt - b.tvAt)
      .map((r) => ({ id: r.id, event: r.event, text: r.text, at: r.tvAt }));
  }

  tvAudio(): boolean {
    return !!this.s()['announcer.enabled'] && this.sourceFor('tv') !== 'browser';
  }

  // ---------- odpočet ----------

  /** Volá se každou sekundu: odpočet do konce levelu a přestávky (každá hodnota jednou za level). */
  tick(): void {
    const s = this.s();
    if (!s['announcer.enabled']) return;
    const thresholds = parseCountdown(String(s['announcer.countdownSeconds']));
    if (thresholds.length === 0) return;
    const tours = this.deps.tournaments();
    for (const row of tours.list()) {
      const tour = tours.get(row.id);
      const st = tour?.state();
      if (!tour || !st || st.status !== 'running' || st.paused || st.clock.kind === null) continue;
      const ms = tour.clockRemainingMs();
      if (ms === null || ms <= 0) continue;
      const seconds = ms / 1000;
      for (const thr of thresholds) {
        if (seconds > thr || seconds <= thr - 5) continue;
        const k = `${row.id}|${st.levelIndex}|${st.clock.kind}|${thr}`;
        if (this.counted.has(k)) continue;
        this.counted.add(k);
        if (this.counted.size > 500) this.counted.clear();
        this.announce(st.clock.kind === 'break' ? 'breakEnding' : 'levelEnding', { seconds: thr }, { rooms: [`announce:${row.id}`, `table:${row.id}`] });
        break;
      }
    }
  }

  // ---------- správa ----------

  status() {
    return { failing: this.failure, source: this.s()['announcer.source'], tvSource: this.s()['announcer.tvSource'] };
  }

  async config(actorId: string) {
    this.manage(actorId);
    return {
      events: ANNOUNCE_EVENTS.map((e) => ({
        key: e.key,
        vars: e.vars,
        enabled: isEventEnabled(e.key, this.tpl),
        variants: this.tpl[e.key]?.variants ?? [],
        defaults: defaultVariants(e.key),
      })),
      status: this.status(),
      cache: await this.cache.stats(),
    };
  }

  async saveTemplates(actorId: string, input: unknown, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    const clean = cleanTemplates(input);
    if (!clean.ok) throw new AnnouncerError('INVALID', { field: clean.field });
    this.tpl = clean.templates;
    await this.deps.db.insert(schema.systemMeta).values({ key: TEMPLATES_KEY, value: clean.templates }).onConflictDoUpdate({ target: schema.systemMeta.key, set: { value: clean.templates } });
    await this.deps.audit.log({ actorId, action: 'hlasatel.sablony_ulozit', targetType: 'announcer', after: { events: Object.keys(clean.templates) }, ...meta });
  }

  /** Ukázka hlasu zvoleného zdroje (tlačítko „Přehrát ukázku“). */
  async sample(actorId: string, source: VoiceSource, text: string): Promise<{ data: Buffer; mime: string }> {
    this.manage(actorId);
    if (source === 'browser') throw new AnnouncerError('NO_AUDIO');
    const clean = text.trim().slice(0, 200);
    if (!clean) throw new AnnouncerError('INVALID', { field: 'text' });
    return this.synthesize(source, clean);
  }

  /** „Otestovat spojení“: Piper vrátí seznam hlasů, Google ověří klíč. */
  async testConnection(actorId: string, source: Exclude<VoiceSource, 'browser'>): Promise<{ voices: string[] }> {
    this.manage(actorId);
    const s = this.s();
    try {
      if (source === 'piper') return { voices: await piperVoices({ host: String(s['announcer.piperHost']), port: Number(s['announcer.piperPort']), timeoutMs: SYNTH_TIMEOUT_MS }) };
      const key = await this.googleKey();
      const res = await this.fetchImpl(`${GOOGLE_BASE}/voices?languageCode=cs-CZ&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Google TTS vrátilo ${res.status}`);
      const body = (await res.json()) as { voices?: { name: string }[] };
      return { voices: (body.voices ?? []).map((v) => v.name) };
    } catch (e) {
      if (e instanceof AnnouncerError) throw e;
      throw new AnnouncerError('SOURCE_FAILED', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Předgeneruje všechny pevné hlášky (bez proměnných) pro oba zdroje, které se na serveru používají. */
  async pregenerate(actorId: string): Promise<{ count: number }> {
    this.manage(actorId);
    const sources = [...new Set([this.sourceFor('user'), this.sourceFor('tv')])].filter((x): x is Exclude<VoiceSource, 'browser'> => x !== 'browser');
    let count = 0;
    for (const e of ANNOUNCE_EVENTS) {
      if (e.vars.length > 0 || !isEventEnabled(e.key, this.tpl)) continue;
      for (const v of variantsOf(e.key, this.tpl)) {
        const text = renderTemplate(v, {});
        for (const src of sources) {
          await this.synthesize(src, text);
          count++;
        }
      }
    }
    return { count };
  }

  async clearCache(actorId: string, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    await this.cache.clear();
    await this.deps.audit.log({ actorId, action: 'hlasatel.cache_vyprazdnit', targetType: 'announcer', ...meta });
  }
}
