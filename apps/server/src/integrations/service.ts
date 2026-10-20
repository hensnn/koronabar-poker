import { createHmac, randomBytes } from 'node:crypto';
import { and, desc, eq, lt, lte } from 'drizzle-orm';
import {
  DEFAULT_EVENT_LIST,
  INTEGRATION_EVENTS,
  isIntegrationEvent,
  NOISY_EVENTS,
  parseEventList,
  DISCORD_SLOTS,
  discordSlotKeys,
  discordSlotOfTarget,
  type DiscordSlot,
  t,
  type EventData,
  type IntegrationEvent,
  type IntegrationPayload,
  type PermissionChecker,
  type SettingValues,
} from '@kb/shared';
import type { AuditService } from '../auth/audit.js';
import { schema, type Db } from '../db/index.js';
import { connectMqtt, MqttError, type MqttConnection, type MqttConnector } from './mqtt.js';

export type IntegrationErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'NOT_CONFIGURED';

export class IntegrationError extends Error {
  constructor(
    public code: IntegrationErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** Stav běžícího turnaje pro entity v Home Assistantu. */
export interface TournamentSummary {
  name: string;
  status: string;
  level: number;
  players: number;
  prizePool: number;
}

interface Deps {
  db: Db;
  perms: PermissionChecker;
  audit: AuditService;
  settings: () => SettingValues;
  secrets: { reveal(key: string): Promise<string | undefined>; setSystem(key: string, value: string): Promise<void> };
  now: () => number;
  /** Stav „hlavního“ turnaje (běžícího, jinak nejbližšího). */
  summary: () => TournamentSummary | null;
  fetcher?: typeof fetch;
  connector?: MqttConnector;
  onError?: (e: unknown) => void;
}

type Meta = { ip?: string | null };

/** Podpis těla webhooku: HMAC-SHA256 z `<čas>.<tělo>`, aby šlo ověřit i stáří zprávy. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Napojení ven: události aplikace se posílají do Home Assistantu přes MQTT (s Discovery), na podepsané webhooky
 * (s opakováním při chybě a logem) a do Discordu. Tělo události nikdy neobsahuje skrytá herní data.
 */
export class IntegrationService {
  private conn: MqttConnection | null = null;
  private connecting: Promise<MqttConnection> | null = null;
  private announced = false;
  private lastEvent: { event: string; at: number; data: EventData } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastState = 0;

  constructor(private deps: Deps) {}

  /** Počká na rozběhnuté odesílání (testy, vypnutí serveru). */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** Ukončí spojení s brokerem. */
  stop(): void {
    this.conn?.end();
    this.conn = null;
  }

  private s() {
    return this.deps.settings();
  }

  private manage(actorId: string): void {
    if (!this.deps.perms.can(actorId, 'integrace.spravovat').allowed) throw new IntegrationError('FORBIDDEN');
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch((e) => this.deps.onError?.(e));
    return next;
  }

  // ---------- vstup: událost ----------

  /** Událost z aplikace. Nic nehází a nezdržuje hru: odeslání běží ve frontě. */
  emit(event: IntegrationEvent, data: EventData = {}): void {
    const s = this.s();
    if (!s['integrations.enabled']) return;
    const payload: IntegrationPayload = { version: 1, event, at: this.deps.now(), data };
    void this.enqueue(() => this.dispatch(payload));
  }

  private async dispatch(p: IntegrationPayload): Promise<void> {
    const s = this.s();
    const db = this.deps.db;
    if (s['integrations.webhooksEnabled']) {
      const eps = await db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.enabled, true));
      for (const ep of eps) {
        const wanted = ep.events.length > 0 ? ep.events : INTEGRATION_EVENTS.filter((e) => !NOISY_EVENTS.includes(e));
        if (!(wanted as string[]).includes(p.event)) continue;
        await db.insert(schema.webhookDeliveries).values({ target: `endpoint:${ep.id}`, endpointId: ep.id, event: p.event, payload: p as unknown as Record<string, unknown>, nextAttemptAt: new Date(this.deps.now()) });
      }
    }
    for (const slot of DISCORD_SLOTS) {
      const k = discordSlotKeys(slot);
      if (s[k.enabled] && parseEventList(String(s[k.events])).includes(p.event) && (await this.deps.secrets.reveal(k.secret))) {
        await db.insert(schema.webhookDeliveries).values({ target: k.target, event: p.event, payload: p as unknown as Record<string, unknown>, nextAttemptAt: new Date(this.deps.now()) });
      }
    }
    await this.processNow();
    if (s['integrations.mqttEnabled'] && String(s['integrations.mqttHost']) && parseEventList(String(s['integrations.mqttEvents'])).includes(p.event)) {
      await this.mqttEvent(p).catch((e) => this.deps.onError?.(e));
    }
  }

  // ---------- odesílání webhooků a Discordu ----------

  /** Odešle všechna doručení, na která je řada. Volá se po události a z časovače. */
  async processDue(): Promise<void> {
    await this.enqueue(() => this.processNow());
  }

  private async secretFor(): Promise<string> {
    let secret = await this.deps.secrets.reveal('webhook.signingSecret');
    if (!secret) {
      secret = randomBytes(32).toString('hex');
      await this.deps.secrets.setSystem('webhook.signingSecret', secret);
    }
    return secret;
  }

  private async processNow(): Promise<void> {
    const db = this.deps.db;
    const due = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(and(eq(schema.webhookDeliveries.status, 'pending'), lte(schema.webhookDeliveries.nextAttemptAt, new Date(this.deps.now()))))
      .limit(50);
    for (const d of due) {
      const result = await this.send(d).catch((e: unknown) => ({ ok: false as const, code: null, error: e instanceof Error ? e.message : String(e) }));
      const attempts = d.attempts + 1;
      const max = Number(this.s()['integrations.webhookMaxAttempts']);
      if (result.ok) {
        await db.update(schema.webhookDeliveries).set({ status: 'ok', attempts, responseCode: result.code, lastError: null, deliveredAt: new Date(this.deps.now()) }).where(eq(schema.webhookDeliveries.id, d.id));
      } else if (attempts >= max) {
        await db.update(schema.webhookDeliveries).set({ status: 'failed', attempts, responseCode: result.code, lastError: clip(result.error, 300) }).where(eq(schema.webhookDeliveries.id, d.id));
      } else {
        const delay = Number(this.s()['integrations.webhookRetrySeconds']) * 1000 * 2 ** (attempts - 1);
        await db.update(schema.webhookDeliveries).set({ attempts, responseCode: result.code, lastError: clip(result.error, 300), nextAttemptAt: new Date(this.deps.now() + delay) }).where(eq(schema.webhookDeliveries.id, d.id));
      }
    }
  }

  private async send(d: typeof schema.webhookDeliveries.$inferSelect): Promise<{ ok: true; code: number } | { ok: false; code: number | null; error: string }> {
    const f = this.deps.fetcher ?? fetch;
    const payload = d.payload as unknown as IntegrationPayload;
    let url: string;
    let body: string;
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'KoronaBar-Poker' };
    const slot = discordSlotOfTarget(d.target);
    if (slot) {
      const u = await this.deps.secrets.reveal(discordSlotKeys(slot).secret);
      if (!u) return { ok: false, code: null, error: 'NOT_CONFIGURED' };
      url = u;
      body = JSON.stringify({ content: clip(this.discordText(payload), 1900), allowed_mentions: { parse: [] } });
    } else {
      const [ep] = d.endpointId ? await this.deps.db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, d.endpointId)) : [];
      if (!ep) return { ok: false, code: null, error: 'ENDPOINT_GONE' };
      url = ep.url;
      body = JSON.stringify(payload);
      const ts = Math.floor(this.deps.now() / 1000);
      headers['x-kb-timestamp'] = String(ts);
      headers['x-kb-signature'] = signWebhook(await this.secretFor(), ts, body);
      headers['x-kb-event'] = payload.event;
      headers['x-kb-delivery'] = d.id;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const res = await f(url, { method: 'POST', headers, body, signal: ctl.signal, redirect: 'manual' });
      return res.status >= 200 && res.status < 300 ? { ok: true, code: res.status } : { ok: false, code: res.status, error: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, code: null, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Text zprávy pro Discord: překlad události s dosazenými proměnnými. */
  discordText(p: IntegrationPayload): string {
    const vars: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(p.data)) vars[k] = v === null ? '' : typeof v === 'boolean' ? (v ? t('common.yes') : t('common.no')) : v;
    return t(`integration.discord.${p.event}`, vars);
  }

  // ---------- MQTT ----------

  private async connection(): Promise<MqttConnection> {
    if (this.conn?.connected) return this.conn;
    if (this.connecting) return this.connecting;
    const s = this.s();
    const connector = this.deps.connector ?? connectMqtt;
    const password = await this.deps.secrets.reveal('mqtt.password');
    this.connecting = connector({
      host: String(s['integrations.mqttHost']),
      port: Number(s['integrations.mqttPort']),
      tls: !!s['integrations.mqttTls'],
      username: String(s['integrations.mqttUser']) || undefined,
      password,
      clientId: `koronabar-${randomBytes(4).toString('hex')}`,
    }).then(
      (c) => {
        this.conn = c;
        this.connecting = null;
        this.announced = false;
        return c;
      },
      (e) => {
        this.connecting = null;
        throw e;
      },
    );
    return this.connecting;
  }

  private prefix(): string {
    return String(this.s()['integrations.mqttPrefix']).replace(/^\/+|\/+$/g, '') || 'koronabar';
  }

  /** Popis entit pro Home Assistant (MQTT Discovery), posílá se po každém novém připojení. */
  discoveryMessages(): { topic: string; payload: string }[] {
    const s = this.s();
    const prefix = this.prefix();
    const dp = String(s['integrations.mqttDiscoveryPrefix']).replace(/^\/+|\/+$/g, '') || 'homeassistant';
    const device = { identifiers: [prefix], name: t('app.name'), manufacturer: 'KoronaBar' };
    const sensor = (id: string, name: string, tpl: string, extra: Record<string, unknown> = {}) => ({
      topic: `${dp}/sensor/${prefix}/${id}/config`,
      payload: JSON.stringify({ name, unique_id: `${prefix}_${id}`, state_topic: `${prefix}/state`, value_template: tpl, availability_topic: `${prefix}/status`, device, ...extra }),
    });
    return [
      sensor('tournament_status', t('integration.ha.status'), '{{ value_json.tournament.status if value_json.tournament else "none" }}', { icon: 'mdi:cards-playing' }),
      sensor('tournament_name', t('integration.ha.name'), '{{ value_json.tournament.name if value_json.tournament else "" }}'),
      sensor('tournament_level', t('integration.ha.level'), '{{ value_json.tournament.level if value_json.tournament else 0 }}', { icon: 'mdi:stairs-up' }),
      sensor('tournament_players', t('integration.ha.players'), '{{ value_json.tournament.players if value_json.tournament else 0 }}', { icon: 'mdi:account-group' }),
      sensor('tournament_prize_pool', t('integration.ha.prizePool'), '{{ value_json.tournament.prizePool if value_json.tournament else 0 }}', { icon: 'mdi:trophy' }),
      sensor('last_event', t('integration.ha.lastEvent'), '{{ value_json.lastEvent.event if value_json.lastEvent else "none" }}', { icon: 'mdi:bell', json_attributes_topic: `${prefix}/state`, json_attributes_template: '{{ value_json.lastEvent | tojson if value_json.lastEvent else "{}" }}' }),
    ];
  }

  private async mqttPublish(topic: string, payload: string, retain: boolean): Promise<void> {
    try {
      const c = await this.connection();
      await this.announce(c);
      await c.publish(topic, payload, { retain });
    } catch (e) {
      this.conn = null;
      throw e;
    }
  }

  private async announce(c: MqttConnection): Promise<void> {
    if (this.announced) return;
    this.announced = true;
    await c.publish(`${this.prefix()}/status`, 'online', { retain: true });
    if (this.s()['integrations.mqttDiscovery']) for (const m of this.discoveryMessages()) await c.publish(m.topic, m.payload, { retain: true });
  }

  private async mqttEvent(p: IntegrationPayload): Promise<void> {
    this.lastEvent = { event: p.event, at: p.at, data: p.data };
    await this.mqttPublish(`${this.prefix()}/event/${p.event}`, JSON.stringify(p), false);
    await this.publishState();
  }

  /** Stav pro entity v Home Assistantu (retained, aby ho HA dostal i po restartu). */
  async publishState(): Promise<void> {
    this.lastState = this.deps.now();
    await this.mqttPublish(`${this.prefix()}/state`, JSON.stringify({ tournament: this.deps.summary(), lastEvent: this.lastEvent }), true);
  }

  /** Časovač: doručí opakování, uklidí log, občas obnoví stav v MQTT. */
  async tick(): Promise<void> {
    const s = this.s();
    if (!s['integrations.enabled']) return;
    await this.processDue();
    const cutoff = new Date(this.deps.now() - Number(s['integrations.logDays']) * 86_400_000);
    await this.deps.db.delete(schema.webhookDeliveries).where(and(lt(schema.webhookDeliveries.createdAt, cutoff), eq(schema.webhookDeliveries.status, 'ok')));
    await this.deps.db.delete(schema.webhookDeliveries).where(and(lt(schema.webhookDeliveries.createdAt, cutoff), eq(schema.webhookDeliveries.status, 'failed')));
    if (s['integrations.mqttEnabled'] && String(s['integrations.mqttHost']) && this.deps.now() - this.lastState >= 60_000) {
      await this.enqueue(() => this.publishState()).catch(() => undefined);
    }
  }

  // ---------- správa ----------

  async overview(actorId: string) {
    this.manage(actorId);
    const s = this.s();
    return {
      events: INTEGRATION_EVENTS,
      defaultEvents: DEFAULT_EVENT_LIST,
      discordEvents: parseEventList(String(s['integrations.discordEvents'])),
      discord: await Promise.all(
        DISCORD_SLOTS.map(async (slot) => {
          const k = discordSlotKeys(slot);
          return { slot, name: String(s[k.name] ?? ''), enabled: !!s[k.enabled], events: parseEventList(String(s[k.events])), configured: !!(await this.deps.secrets.reveal(k.secret)) };
        }),
      ),
      mqttEvents: parseEventList(String(s['integrations.mqttEvents'])),
      discordConfigured: !!(await this.deps.secrets.reveal('discord.webhookUrl')),
      mqttConfigured: !!String(s['integrations.mqttHost']),
    };
  }

  async endpoints(actorId: string) {
    this.manage(actorId);
    const rows = await this.deps.db.select().from(schema.webhookEndpoints).orderBy(schema.webhookEndpoints.createdAt);
    return rows.map((r) => {
      let host = '';
      try {
        host = new URL(r.url).host;
      } catch {
        host = '?';
      }
      return { id: r.id, name: r.name, host, events: r.events, enabled: r.enabled };
    });
  }

  private validUrl(url: unknown): string {
    if (typeof url !== 'string') throw new IntegrationError('INVALID', { field: 'url' });
    try {
      const u = new URL(url.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('proto');
      return u.toString();
    } catch {
      throw new IntegrationError('INVALID', { field: 'url' });
    }
  }

  private validEvents(events: unknown): string[] {
    if (events === undefined) return [];
    if (!Array.isArray(events) || events.some((e) => typeof e !== 'string' || !isIntegrationEvent(e))) throw new IntegrationError('INVALID', { field: 'events' });
    return [...new Set(events as string[])];
  }

  async createEndpoint(actorId: string, input: { name: string; url: string; events?: string[]; enabled?: boolean }, meta: Meta = {}): Promise<string> {
    this.manage(actorId);
    const name = input.name?.trim() ?? '';
    if (name.length < 2 || name.length > 60) throw new IntegrationError('INVALID', { field: 'name' });
    const [row] = await this.deps.db
      .insert(schema.webhookEndpoints)
      .values({ name, url: this.validUrl(input.url), events: this.validEvents(input.events), enabled: input.enabled ?? true })
      .returning({ id: schema.webhookEndpoints.id });
    await this.deps.audit.log({ actorId, action: 'integrace.webhook_pridat', targetType: 'webhook', targetId: row!.id, after: { name }, ...meta });
    return row!.id;
  }

  async updateEndpoint(actorId: string, id: string, input: { name?: string; url?: string; events?: string[]; enabled?: boolean }, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    const [cur] = await this.deps.db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, id));
    if (!cur) throw new IntegrationError('NOT_FOUND');
    const name = input.name !== undefined ? input.name.trim() : cur.name;
    if (name.length < 2 || name.length > 60) throw new IntegrationError('INVALID', { field: 'name' });
    await this.deps.db
      .update(schema.webhookEndpoints)
      .set({ name, url: input.url !== undefined ? this.validUrl(input.url) : cur.url, events: input.events !== undefined ? this.validEvents(input.events) : cur.events, enabled: input.enabled ?? cur.enabled })
      .where(eq(schema.webhookEndpoints.id, id));
    await this.deps.audit.log({ actorId, action: 'integrace.webhook_upravit', targetType: 'webhook', targetId: id, ...meta });
  }

  async removeEndpoint(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    const gone = await this.deps.db.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, id)).returning({ id: schema.webhookEndpoints.id });
    if (gone.length === 0) throw new IntegrationError('NOT_FOUND');
    await this.deps.audit.log({ actorId, action: 'integrace.webhook_smazat', targetType: 'webhook', targetId: id, ...meta });
  }

  /** Nastaví události, které jdou do Discordu nebo MQTT (uloží se do nastavení). */
  parseSelection(events: unknown): string {
    return this.validEvents(events).join(',');
  }

  /** Zkušební zpráva na webhook: vznikne obyčejné doručení, takže projde stejnou cestou včetně podpisu. */
  async testEndpoint(actorId: string, id: string): Promise<{ id: string }> {
    this.manage(actorId);
    const [ep] = await this.deps.db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, id));
    if (!ep) throw new IntegrationError('NOT_FOUND');
    const payload: IntegrationPayload = { version: 1, event: 'poll.created', at: this.deps.now(), data: { title: t('integration.testTitle'), test: true } };
    const [row] = await this.deps.db
      .insert(schema.webhookDeliveries)
      .values({ target: `endpoint:${id}`, endpointId: id, event: payload.event, payload: payload as unknown as Record<string, unknown>, nextAttemptAt: new Date(this.deps.now()) })
      .returning({ id: schema.webhookDeliveries.id });
    await this.processDue();
    return { id: row!.id };
  }

  async testDiscord(actorId: string, slot: DiscordSlot = 1): Promise<{ ok: boolean; error?: string }> {
    this.manage(actorId);
    const k = discordSlotKeys(slot);
    if (!(await this.deps.secrets.reveal(k.secret))) throw new IntegrationError('NOT_CONFIGURED');
    const payload: IntegrationPayload = { version: 1, event: 'poll.created', at: this.deps.now(), data: { title: t('integration.testTitle'), test: true } };
    const [row] = await this.deps.db
      .insert(schema.webhookDeliveries)
      .values({ target: k.target, event: payload.event, payload: payload as unknown as Record<string, unknown>, nextAttemptAt: new Date(this.deps.now()) })
      .returning({ id: schema.webhookDeliveries.id });
    await this.processDue();
    const [d] = await this.deps.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, row!.id));
    return d?.status === 'ok' ? { ok: true } : { ok: false, error: d?.lastError ?? 'ERROR' };
  }

  /** Zkouška spojení s MQTT brokerem: připojí se, pošle stav a Discovery. */
  async testMqtt(actorId: string): Promise<{ ok: boolean; error?: string }> {
    this.manage(actorId);
    if (!String(this.s()['integrations.mqttHost'])) throw new IntegrationError('NOT_CONFIGURED');
    this.conn?.end();
    this.conn = null;
    try {
      await this.enqueue(async () => {
        await this.mqttPublish(`${this.prefix()}/status`, 'online', true);
        await this.publishState();
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof MqttError ? e.code : e instanceof Error ? e.message : 'ERROR' };
    }
  }

  async deliveries(actorId: string, opts: { status?: string; limit?: number } = {}) {
    this.manage(actorId);
    const rows = await this.deps.db
      .select()
      .from(schema.webhookDeliveries)
      .where(opts.status ? eq(schema.webhookDeliveries.status, opts.status) : undefined)
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(Math.min(opts.limit ?? 50, 200));
    return rows.map((r) => ({ id: r.id, target: r.target, event: r.event, status: r.status, attempts: r.attempts, responseCode: r.responseCode, error: r.lastError, at: r.createdAt.getTime(), deliveredAt: r.deliveredAt?.getTime() ?? null }));
  }

  /** Chybné doručení se zkusí znovu od začátku. */
  async retry(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    const done = await this.deps.db
      .update(schema.webhookDeliveries)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(this.deps.now()), lastError: null })
      .where(and(eq(schema.webhookDeliveries.id, id), eq(schema.webhookDeliveries.status, 'failed')))
      .returning({ id: schema.webhookDeliveries.id });
    if (done.length === 0) throw new IntegrationError('NOT_FOUND');
    await this.deps.audit.log({ actorId, action: 'integrace.webhook_znovu', targetType: 'webhook_delivery', targetId: id, ...meta });
    await this.processDue();
  }
}
