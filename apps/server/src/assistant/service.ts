import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ASSISTANT_CONTEXTS,
  ASSISTANT_TOOLS,
  PROMPT_KEYS,
  TOOL_NAMES,
  allowedVariables,
  dayKey,
  isAssistantContext,
  isPromptKey,
  labelKey,
  helpKey,
  categoryKey,
  optionKey,
  renderPrompt,
  scopeAllowed,
  t,
  unknownVariables,
  validateValues,
  type AiProviderId,
  answerFromGuide,
  searchGuide,
  type AssistantContext,
  type PermissionChecker,
  type ProposalAction,
  type ProposalDiffRow,
  type ProposalStatus,
  type SettingDef,
  type SettingValue,
  type SettingValues,
  type SettingsRegistry,
  type TargetKind,
  type ToolDef,
} from '@kb/shared';
import type { AuditService, AuditSource } from '../auth/audit.js';
import type { PermissionService } from '../auth/permissions.js';
import { schema, type Db } from '../db/index.js';
import type { PollService } from '../polls.js';
import type { SettingsStore } from '../settings-store.js';
import type { TableManager } from '../tables.js';
import type { TemplateService } from '../templates.js';
import type { TournamentManager } from '../tournaments.js';
import { createProvider, ProviderError, type AiProvider, type ChatMsg, type ToolCall, type ToolSpec } from './providers.js';

export type AssistantErrorCode = 'DISABLED' | 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'LIMIT_USER' | 'LIMIT_GLOBAL' | 'PROVIDER' | 'BUSY' | 'TIMEOUT' | 'PROVIDER_LIMIT' | 'EXPIRED' | 'NOT_PENDING' | 'UNKNOWN_VARIABLE';

export class AssistantError extends Error {
  constructor(
    public code: AssistantErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

interface Deps {
  db: Db;
  perms: PermissionService;
  audit: AuditService;
  registry: SettingsRegistry;
  store: SettingsStore;
  settings: () => SettingValues;
  secrets: { reveal(key: string): Promise<string | undefined> };
  now: () => number;
  tables: () => TableManager;
  tournaments: () => TournamentManager;
  templates: () => TemplateService;
  polls: () => PollService;
  nickOf: (userId: string) => Promise<string>;
  fetcher?: typeof fetch;
  /** Náhrada poskytovatele (testy). */
  provider?: AiProvider;
}

export interface ProposalDto {
  id: string;
  status: ProposalStatus;
  summary: string;
  diff: ProposalDiffRow[];
  requestText: string;
  expiresAt: number;
  createdAt: number;
  result: Record<string, unknown> | null;
  /** Hodnoty parametrů, které jde před potvrzením upravit. */
  values: Record<string, string | number | boolean>;
}

/** Výsledek nástroje zkrácený na nejvýš `max` znaků (delší kontext zpomaluje a zdražuje odpověď). */
export function clipTool(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(zkráceno, celkem ${text.length} znaků)`;
}

export interface ChatResult {
  reply: string;
  proposals: ProposalDto[];
  tokens: number;
}

interface ToolEnv {
  userId: string;
  source: AuditSource;
  requestText: string;
  dryRun: boolean;
  proposals: ProposalDto[];
}

type Plan = { actions: ProposalAction[]; diff: ProposalDiffRow[]; denied: string[] };

const SECRET_PREFIX = /^(assistant\.)/;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * AI asistent nastavení. Pracuje přes volání nástrojů, které se berou ze schématu nastavení a ze šablon. Změny
 * nikdy neprovádí sám: vytvoří návrh „před → po“, který uživatel potvrdí; provede ho stejná logika jako ruční změna
 * (oprávnění, pravidla „kdy lze měnit“, validace, audit se značkou asistenta).
 */
/** Kontexty, kde asistent hlavně vysvětluje (bez návrhů změn): stačí rychlejší model a menší sada nástrojů. */
const EXPLAIN_CONTEXTS: readonly string[] = ['rules', 'lobby', 'table'];
/** Výchozí rychlý model poskytovatele pro vysvětlování, když správce nezadal vlastní. */
const FAST_MODEL: Record<AiProviderId, string> = { gemini: 'gemini-3.5-flash-lite', anthropic: 'claude-haiku-5-5', openai: 'gpt-4.1-mini', compatible: '' };

export class AssistantService {
  /** Časy posledních volání modelu (posuvné okno jedné minuty) pro omezení za minutu. */
  private calls: number[] = [];
  constructor(private deps: Deps) {}

  private s() {
    return this.deps.settings();
  }

  private can(userId: string, key: string): boolean {
    return this.deps.perms.can(userId, key).allowed;
  }

  // ---------- dostupnost a limity ----------

  private providerId(): AiProviderId {
    return String(this.s()['assistant.provider']) as AiProviderId;
  }

  private async apiKey(): Promise<string | undefined> {
    return this.deps.secrets.reveal(`ai.${this.providerId()}.apiKey`);
  }

  private modelFor(ctx: AssistantContext): string {
    const s = this.s();
    const byProvider = { gemini: 'assistant.modelGemini', anthropic: 'assistant.modelAnthropic', openai: 'assistant.modelOpenai', compatible: 'assistant.modelCompatible' }[this.providerId()];
    // Otázky na vysvětlení běží na rychlém a levném modelu, návrhy změn na hlavním (u bezplatného Gemini šetří limit).
    const explain = EXPLAIN_CONTEXTS.includes(ctx);
    const override = explain ? String(s['assistant.modelExplain']) || FAST_MODEL[this.providerId()] : ctx === 'planning' ? String(s['assistant.modelPlanning']) : '';
    return override || String(s[byProvider]);
  }

  /** Je asistent zapnutý a má poskytovatele (klíč, u vlastního rozhraní adresu)? */
  async configured(): Promise<boolean> {
    if (this.deps.provider) return true;
    if (!this.s()['assistant.enabled']) return false;
    if (this.providerId() === 'compatible') return !!String(this.s()['assistant.baseUrl']);
    return !!(await this.apiKey());
  }

  private async provider(): Promise<AiProvider> {
    if (this.deps.provider) return this.deps.provider;
    return createProvider(this.providerId(), { apiKey: (await this.apiKey()) ?? '', baseUrl: String(this.s()['assistant.baseUrl']), fetcher: this.deps.fetcher });
  }

  async status(userId: string): Promise<{ available: boolean; used: number; max: number; warnPercent: number; contexts: readonly string[]; voiceInput: boolean; voiceOutput: boolean; canManage: boolean }> {
    const available = this.can(userId, 'asistent.pouzivat') && (await this.configured());
    const used = await this.usedToday(userId);
    return { available, used, max: Number(this.s()['assistant.perUserDaily']), warnPercent: Number(this.s()['assistant.usageWarnPercent']), contexts: ASSISTANT_CONTEXTS, voiceInput: !!this.s()['assistant.voiceInput'], voiceOutput: !!this.s()['assistant.voiceOutput'], canManage: this.can(userId, 'asistent.spravovat') };
  }

  private day(): string {
    return dayKey(this.deps.now());
  }

  private async usedToday(userId: string): Promise<number> {
    const [r] = await this.deps.db.select({ n: assistantUsageRequests }).from(schema.assistantUsage).where(and(eq(schema.assistantUsage.day, this.day()), eq(schema.assistantUsage.userId, userId)));
    return r?.n ?? 0;
  }

  /** Započítá požadavek do denních limitů; při překročení vyhodí chybu. */
  private async spend(userId: string): Promise<void> {
    const s = this.s();
    const perUser = Number(s['assistant.perUserDaily']);
    const global = Number(s['assistant.globalDaily']);
    const rows = await this.deps.db.select().from(schema.assistantUsage).where(eq(schema.assistantUsage.day, this.day()));
    if (perUser > 0 && (rows.find((r) => r.userId === userId)?.requests ?? 0) >= perUser) throw new AssistantError('LIMIT_USER', { max: perUser });
    if (global > 0 && rows.reduce((n, r) => n + r.requests, 0) >= global) throw new AssistantError('LIMIT_GLOBAL');
    await this.deps.db
      .insert(schema.assistantUsage)
      .values({ day: this.day(), userId, requests: 1, tokens: 0 })
      .onConflictDoUpdate({ target: [schema.assistantUsage.day, schema.assistantUsage.userId], set: { requests: sql`${schema.assistantUsage.requests} + 1` } });
  }

  /** Započítá odpověď z návodu (bez AI) do statistiky; do denních limitů se nepočítá. */
  private async countLocal(userId: string): Promise<void> {
    await this.deps.db
      .insert(schema.assistantUsage)
      .values({ day: this.day(), userId, requests: 0, tokens: 0, localAnswers: 1 })
      .onConflictDoUpdate({ target: [schema.assistantUsage.day, schema.assistantUsage.userId], set: { localAnswers: sql`${schema.assistantUsage.localAnswers} + 1` } });
  }

  private async addTokens(userId: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    await this.deps.db
      .update(schema.assistantUsage)
      .set({ tokens: sql`${schema.assistantUsage.tokens} + ${tokens}` })
      .where(and(eq(schema.assistantUsage.day, this.day()), eq(schema.assistantUsage.userId, userId)));
  }

  /** Spotřeba za dnešek po hráčích (správce). */
  async usage(actorId: string) {
    this.manage(actorId);
    const rows = await this.deps.db
      .select({ userId: schema.assistantUsage.userId, requests: schema.assistantUsage.requests, tokens: schema.assistantUsage.tokens, localAnswers: schema.assistantUsage.localAnswers, nickname: schema.users.nickname })
      .from(schema.assistantUsage)
      .innerJoin(schema.users, eq(schema.users.id, schema.assistantUsage.userId))
      .where(eq(schema.assistantUsage.day, this.day()))
      .orderBy(desc(schema.assistantUsage.requests));
    return { day: this.day(), rows, totalRequests: rows.reduce((n, r) => n + r.requests, 0), totalTokens: rows.reduce((n, r) => n + r.tokens, 0), totalLocal: rows.reduce((n, r) => n + r.localAnswers, 0), warnPercent: Number(this.s()['assistant.usageWarnPercent']), maxPerUser: Number(this.s()['assistant.perUserDaily']), maxGlobal: Number(this.s()['assistant.globalDaily']) };
  }

  private manage(actorId: string): void {
    if (!this.can(actorId, 'asistent.spravovat')) throw new AssistantError('FORBIDDEN');
  }

  // ---------- prompty ----------

  private validPromptKey(key: string): boolean {
    return isPromptKey(key) || (key.startsWith('tool.') && TOOL_NAMES.includes(key.slice(5)));
  }

  private defaultPrompt(key: string): string {
    return key.startsWith('tool.') ? t(`assistant.${key}`) : t(`assistant.prompt.${key}`);
  }

  private variablesFor(key: string): string[] {
    return key.startsWith('tool.') ? [] : allowedVariables(key as (typeof PROMPT_KEYS)[number]);
  }

  private async currentVersion(key: string) {
    const [row] = await this.deps.db.select().from(schema.assistantPromptVersions).where(eq(schema.assistantPromptVersions.key, key)).orderBy(desc(schema.assistantPromptVersions.version)).limit(1);
    return row;
  }

  /** Text promptu: upravený, jinak výchozí. */
  async promptText(key: string): Promise<string> {
    const row = await this.currentVersion(key);
    return row && !row.isDefault ? row.text : this.defaultPrompt(key);
  }

  async prompts(actorId: string) {
    this.manage(actorId);
    const keys = [...PROMPT_KEYS, ...TOOL_NAMES.map((n) => `tool.${n}`)];
    const out = [];
    for (const key of keys) {
      const row = await this.currentVersion(key);
      const custom = !!row && !row.isDefault;
      out.push({ key, text: custom ? row.text : this.defaultPrompt(key), defaultText: this.defaultPrompt(key), custom, version: row?.version ?? 0, variables: this.variablesFor(key) });
    }
    return out;
  }

  async savePrompt(actorId: string, key: string, text: string, meta: { ip?: string | null } = {}): Promise<{ version: number }> {
    this.manage(actorId);
    if (!this.validPromptKey(key)) throw new AssistantError('NOT_FOUND');
    const body = (text ?? '').trim();
    if (body.length < 1 || body.length > 8000) throw new AssistantError('INVALID', { field: 'text' });
    const unknown = unknownVariables(body, this.variablesFor(key));
    if (unknown.length) throw new AssistantError('UNKNOWN_VARIABLE', { name: unknown.map((u) => `{${u}}`).join(', ') });
    return this.addVersion(actorId, key, body, false, 'asistent.prompt_upravit', meta);
  }

  private async addVersion(actorId: string, key: string, text: string, isDefault: boolean, action: string, meta: { ip?: string | null }): Promise<{ version: number }> {
    const cur = await this.currentVersion(key);
    const version = (cur?.version ?? 0) + 1;
    await this.deps.db.insert(schema.assistantPromptVersions).values({ key, version, text, isDefault, authorId: actorId });
    await this.deps.audit.log({ actorId, action, targetType: 'assistant_prompt', targetId: key, after: { version, isDefault }, ...meta });
    return { version };
  }

  async promptVersions(actorId: string, key: string) {
    this.manage(actorId);
    if (!this.validPromptKey(key)) throw new AssistantError('NOT_FOUND');
    const rows = await this.deps.db
      .select({ version: schema.assistantPromptVersions.version, text: schema.assistantPromptVersions.text, isDefault: schema.assistantPromptVersions.isDefault, at: schema.assistantPromptVersions.createdAt, author: schema.users.nickname })
      .from(schema.assistantPromptVersions)
      .leftJoin(schema.users, eq(schema.users.id, schema.assistantPromptVersions.authorId))
      .where(eq(schema.assistantPromptVersions.key, key))
      .orderBy(desc(schema.assistantPromptVersions.version));
    return rows.map((r) => ({ version: r.version, text: r.isDefault ? this.defaultPrompt(key) : r.text, isDefault: r.isDefault, at: r.at.getTime(), author: r.author }));
  }

  /** Vrátí starší verzi jako novou verzi. */
  async revertPrompt(actorId: string, key: string, version: number, meta: { ip?: string | null } = {}): Promise<{ version: number }> {
    this.manage(actorId);
    if (!this.validPromptKey(key)) throw new AssistantError('NOT_FOUND');
    const [old] = await this.deps.db.select().from(schema.assistantPromptVersions).where(and(eq(schema.assistantPromptVersions.key, key), eq(schema.assistantPromptVersions.version, version)));
    if (!old) throw new AssistantError('NOT_FOUND');
    return this.addVersion(actorId, key, old.text, old.isDefault, 'asistent.prompt_vratit', meta);
  }

  /** Reset jednoho promptu (nebo všech) na výchozí text; historie zůstane. */
  async resetPrompt(actorId: string, key: string | null, meta: { ip?: string | null } = {}): Promise<void> {
    this.manage(actorId);
    const keys = key ? [key] : [...PROMPT_KEYS, ...TOOL_NAMES.map((n) => `tool.${n}`)];
    if (key && !this.validPromptKey(key)) throw new AssistantError('NOT_FOUND');
    for (const k of keys) {
      const cur = await this.currentVersion(k);
      if (cur && !cur.isDefault) await this.addVersion(actorId, k, '', true, 'asistent.prompt_reset', meta);
    }
  }

  // ---------- proměnné do promptů ----------

  private async roleName(userId: string): Promise<string> {
    const best = this.deps.perms
      .assignmentsOf(userId)
      .map((a) => a.role)
      .filter((r): r is NonNullable<typeof r> => !!r)
      .sort((a, b) => b.power - a.power)[0];
    return best ? (t(`role.${best.key}.name`) === `role.${best.key}.name` ? best.name : t(`role.${best.key}.name`)) : '';
  }

  private capabilities(userId: string): string {
    const list: string[] = [t('assistant.diff.target.user')];
    for (const key of ['nastaveni.globalni', 'cash.upravit_vse', 'cash.upravit_vlastni', 'turnaj.vytvorit', 'turnaj.upravit_vse', 'turnaj.upravit_vlastni', 'anketa.vytvorit']) if (this.can(userId, key)) list.push(t(`perm.${key}.name`));
    return list.join(', ');
  }

  private async publicState(): Promise<string> {
    const tables = await this.deps.tables().lobby();
    const tours = await this.deps.tournaments().lobby();
    const parts = [
      ...tables.slice(0, 10).map((x) => `${x.name} (${x.seated}/${x.seats}, ${x.smallBlind}/${x.bigBlind})`),
      ...tours.filter((x) => ['registering', 'running'].includes(x.status)).slice(0, 10).map((x) => `${x.name} [${x.id}] (${x.status}, ${x.players})`),
    ];
    return clip(parts.join('; ') || '-', 600);
  }

  private nonDefault(values: SettingValues): string {
    const defaults = this.deps.registry.defaults();
    const out: string[] = [];
    for (const [k, v] of Object.entries(values)) {
      const def = this.deps.registry.get(k);
      if (!def || def.secret || SECRET_PREFIX.test(k) || defaults[k] === v) continue;
      out.push(`${k}=${v}`);
    }
    return clip(out.join(', ') || '-', 800);
  }

  private async promptVars(userId: string, ctx: AssistantContext, targetId?: string): Promise<Record<string, string>> {
    const s = this.s();
    const now = new Date(this.deps.now());
    const tz = 'Europe/Prague';
    const table = targetId ? this.deps.tables().settingsOf(targetId) : undefined;
    const tour = targetId ? this.deps.tournaments().settingsOf(targetId) : undefined;
    const row = targetId ? (this.deps.tables().list().find((x) => x.id === targetId) ?? this.deps.tournaments().list().find((x) => x.id === targetId)) : undefined;
    const templates = this.deps.templates().list().slice(0, 40).map((x) => `${x.id} (${x.name})`).join(', ');
    return {
      prezdivka: await this.deps.nickOf(userId),
      role: await this.roleName(userId),
      opravneni: this.capabilities(userId),
      kontext: t(`assistant.ctxName.${ctx}`),
      datum: now.toLocaleDateString('cs-CZ', { timeZone: tz, dateStyle: 'full' }),
      cas: now.toLocaleTimeString('cs-CZ', { timeZone: tz, timeStyle: 'short' }),
      jazyk: t('assistant.language'),
      nazev_aplikace: t('app.name'),
      mena: String(s['economy.currencyName']),
      stul: row?.name ?? '-',
      stav_hry: await this.publicState(),
      aktualni_nastaveni: ctx === 'admin' ? this.nonDefault(this.deps.store.layer('global') as SettingValues) : this.nonDefault((table ?? tour ?? {}) as SettingValues),
      sablona: templates,
    };
  }

  /** Celý systémový prompt po dosazení proměnných (zobrazuje ho i pískoviště). */
  async buildSystem(userId: string, ctx: AssistantContext, targetId?: string): Promise<string> {
    const vars = await this.promptVars(userId, ctx, targetId);
    const system = renderPrompt(await this.promptText('system'), vars);
    const context = renderPrompt(await this.promptText(`ctx.${ctx}`), vars);
    return `${system}\n\n${context}`;
  }

  private async template(key: string, vars: Record<string, string | number>): Promise<string> {
    return renderPrompt(await this.promptText(`tpl.${key}`), { nazev_aplikace: t('app.name'), ...vars });
  }

  // ---------- nástroje ----------

  private disabledTools(): string[] {
    return String(this.s()['assistant.disabledTools']).split(/[\s,;]+/).filter(Boolean);
  }

  /** Nástroje, které smí uživatel v tuto chvíli používat (s popisy, případně upravenými v GUI). */
  async toolSpecs(userId: string, ctx?: AssistantContext): Promise<ToolSpec[]> {
    const out: ToolSpec[] = [];
    for (const tool of ASSISTANT_TOOLS) {
      if (this.disabledTools().includes(tool.name)) continue;
      // Při vysvětlování se návrhy změn neposílají: menší sada nástrojů je kratší prompt a rychlejší odpověď.
      if (ctx && EXPLAIN_CONTEXTS.includes(ctx) && tool.kind === 'propose') continue;
      if (tool.permission && !this.can(userId, tool.permission)) continue;
      out.push({ name: tool.name, description: await this.promptText(`tool.${tool.name}`), parameters: translateSchema(tool.parameters) });
    }
    return out;
  }

  private toolDef(name: string): ToolDef | undefined {
    return ASSISTANT_TOOLS.find((x) => x.name === name);
  }

  private visibleDef(def: SettingDef | undefined): def is SettingDef {
    return !!def && !def.secret && !SECRET_PREFIX.test(def.key);
  }

  private describeDef(def: SettingDef) {
    const range = def.type === 'int' ? { min: def.min, max: def.max } : def.type === 'enum' ? { options: def.options } : {};
    return { key: def.key, label: t(labelKey(def.key)), type: def.type, default: def.default, unit: 'unit' in def ? def.unit : undefined, mutability: def.mutability, category: t(categoryKey(def.category)), scopes: def.scopes, ...range };
  }

  /** Spustí nástroj; čtecí vrací data, navrhující vytvoří (nebo v pískovišti jen spočítá) návrh. */
  async runTool(env: ToolEnv, name: string, args: Record<string, unknown>): Promise<string> {
    const def = this.toolDef(name);
    if (!def || this.disabledTools().includes(name)) return JSON.stringify({ ok: false, error: t('assistant.denied.tool', { tool: name }) });
    if (def.permission && !this.can(env.userId, def.permission)) return JSON.stringify({ ok: false, error: t('assistant.denied.permission') });
    try {
      switch (name) {
        case 'search_guide':
          return JSON.stringify({ ok: true, results: searchGuide(String(args.query ?? '')).map((r) => ({ chapter: r.chapter, text: r.paragraphs[0] })) });
        case 'search_settings':
          return JSON.stringify(this.searchSettings(String(args.query ?? '')));
        case 'explain_setting':
          return JSON.stringify(this.explain(String(args.key ?? '')));
        case 'get_settings':
          return JSON.stringify(await this.getSettings(env.userId, args));
        case 'list_games':
          return JSON.stringify(await this.listGames());
        case 'list_templates':
          return JSON.stringify(this.deps.templates().list().filter((x) => !args.kind || x.kind === args.kind).map((x) => ({ id: x.id, kind: x.kind, name: x.name, description: x.description })));
        case 'propose_settings_change':
          return JSON.stringify(await this.proposeSettings(env, args));
        case 'propose_create_tournament':
          return JSON.stringify(await this.proposeTournament(env, args));
        case 'propose_poll':
          return JSON.stringify(await this.proposePoll(env, args));
      }
    } catch (e) {
      return JSON.stringify({ ok: false, error: e instanceof AssistantError ? t(`error.ASSISTANT_${e.code}`, e.params as Record<string, string>) : e instanceof Error ? e.message : 'ERROR' });
    }
    return JSON.stringify({ ok: false });
  }

  private searchSettings(query: string) {
    // české skloňování: u delších slov se hledá kmen bez posledních dvou písmen
    const words = fold(query)
      .split(/[^\p{L}\p{N}.]+/u)
      .filter((w) => w.length > 1)
      .map((w) => (w.length >= 6 ? w.slice(0, w.length - 2) : w));
    if (words.length === 0) return [];
    const docs = this.deps.registry
      .all()
      .filter((d) => this.visibleDef(d))
      .map((d) => ({ d, label: fold(t(labelKey(d.key))), hay: fold(`${t(labelKey(d.key))} ${t(helpKey(d.key))} ${d.key}`) }));
    // vzácnější slovo váží víc než časté (maximální, počet…)
    const weight = new Map(words.map((w) => [w, Math.log(1 + docs.length / (1 + docs.filter((x) => x.hay.includes(w)).length))]));
    return docs
      .map((x) => ({ d: x.d, score: words.reduce((n, w) => n + (x.hay.includes(w) ? weight.get(w)! * (x.label.includes(w) ? 3 : 1) : 0), 0) }))
      .filter((x) => x.score > 0)
      .sort((p, q) => q.score - p.score)
      .slice(0, 10)
      .map((x) => this.describeDef(x.d));
  }

  private explain(key: string) {
    const def = this.deps.registry.get(key);
    if (!this.visibleDef(def)) return { ok: false, error: t('assistant.denied.unknownKey', { key }) };
    return { ...this.describeDef(def), help: t(helpKey(key)), ...(def.type === 'enum' ? { optionLabels: Object.fromEntries(def.options.map((o) => [o, t(optionKey(key, o))])) } : {}) };
  }

  private async getSettings(userId: string, args: Record<string, unknown>) {
    const target = (args.target ?? { kind: 'global' }) as { kind?: TargetKind; id?: string };
    const keys = Array.isArray(args.keys) ? (args.keys as unknown[]).map(String).slice(0, 30) : null;
    let values: SettingValues;
    switch (target.kind) {
      case 'global':
        values = this.s();
        break;
      case 'user':
        values = this.deps.store.resolve([{ scope: 'user', scopeId: userId, values: this.deps.store.layer('user', userId) }]);
        break;
      case 'table':
        values = this.deps.tables().settingsOf(String(target.id)) ?? {};
        break;
      case 'tournament':
        values = this.deps.tournaments().settingsOf(String(target.id)) ?? {};
        break;
      default:
        return { ok: false, error: t('assistant.denied.target') };
    }
    if (target.kind !== 'user' && target.kind !== 'global' && !this.can(userId, 'stul.zobrazit')) return { ok: false, error: t('assistant.denied.permission') };
    const out: Record<string, SettingValue> = {};
    const pick = keys ?? Object.keys(values).filter((k) => values[k] !== this.deps.registry.get(k)?.default);
    for (const k of pick) {
      const def = this.deps.registry.get(k);
      if (this.visibleDef(def) && values[k] !== undefined) out[k] = values[k]!;
    }
    return { ok: true, values: out };
  }

  private async listGames() {
    const tables = await this.deps.tables().lobby();
    const tours = await this.deps.tournaments().lobby();
    return {
      tables: tables.map((x) => ({ id: x.id, name: x.name, seated: x.seated, seats: x.seats, smallBlind: x.smallBlind, bigBlind: x.bigBlind, playing: x.playing })),
      tournaments: tours.map((x) => ({ id: x.id, name: x.name, status: x.status, players: x.players, buyIn: x.buyIn })),
    };
  }

  // ---------- plánování změn ----------

  private parseValue(def: SettingDef, raw: unknown): { ok: true; value: SettingValue } | { ok: false; detail: string } {
    switch (def.type) {
      case 'int': {
        const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
        if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, detail: 'číslo' };
        if (n < def.min || n > def.max) return { ok: false, detail: `${def.min} až ${def.max}` };
        return { ok: true, value: n };
      }
      case 'bool': {
        const v = String(raw).trim().toLowerCase();
        if (['true', '1', 'ano', 'yes', 'zapnout'].includes(v)) return { ok: true, value: true };
        if (['false', '0', 'ne', 'no', 'vypnout'].includes(v)) return { ok: true, value: false };
        return { ok: false, detail: 'ano/ne' };
      }
      case 'enum': {
        const v = String(raw).trim();
        return def.options.includes(v) ? { ok: true, value: v } : { ok: false, detail: def.options.join(', ') };
      }
      case 'string':
      case 'color': {
        const v = String(raw);
        return def.type === 'string' && def.maxLength && v.length > def.maxLength ? { ok: false, detail: `max ${def.maxLength}` } : { ok: true, value: v };
      }
    }
  }

  private fmt(def: SettingDef, v: SettingValue | undefined): string {
    if (v === undefined) return '-';
    if (def.type === 'bool') return v ? t('common.yes') : t('common.no');
    if (def.type === 'enum') return t(optionKey(def.key, String(v)));
    const unit = 'unit' in def && def.unit ? ` ${t(`unit.${def.unit}`)}` : '';
    return `${v}${unit}`;
  }

  private issueText(i: { messageKey: string; params?: Record<string, unknown> }): string {
    return t(i.messageKey, (i.params ?? {}) as Record<string, string | number>);
  }

  /** Spočítá náhled změn pro cíl a ověří oprávnění a pravidla; nic nemění. */
  async planSettings(userId: string, target: { kind?: string; id?: string }, rawChanges: unknown): Promise<{ action: ProposalAction | null; diff: ProposalDiffRow[]; denied: string[] }> {
    const denied: string[] = [];
    const list = Array.isArray(rawChanges) ? (rawChanges as { key?: unknown; value?: unknown }[]) : [];
    if (list.length === 0 || list.length > 30) return { action: null, diff: [], denied: [t('assistant.denied.invalid', { key: '-', detail: 'changes' })] };
    const kind = String(target?.kind ?? '') as TargetKind;
    if (!['global', 'user', 'table', 'tournament'].includes(kind)) return { action: null, diff: [], denied: [t('assistant.denied.target')] };
    const clean: Record<string, SettingValue> = {};
    const defs = new Map<string, SettingDef>();
    for (const c of list) {
      const key = String(c?.key ?? '');
      const def = this.deps.registry.get(key);
      if (!def) {
        denied.push(t('assistant.denied.unknownKey', { key }));
        continue;
      }
      if (!this.visibleDef(def)) {
        denied.push(t('assistant.denied.forbiddenKey', { key }));
        continue;
      }
      const parsed = this.parseValue(def, c.value);
      if (!parsed.ok) {
        denied.push(t('assistant.denied.invalid', { key, detail: parsed.detail }));
        continue;
      }
      clean[key] = parsed.value;
      defs.set(key, def);
    }
    if (denied.length || Object.keys(clean).length === 0) return { action: null, diff: [], denied };

    let before: SettingValues = {};
    let timing = new Map<string, { timing: 'now' | 'nextHand' | 'denied'; reasonKey?: string }>();
    try {
      if (kind === 'global') {
        if (!this.can(userId, 'nastaveni.globalni')) return { action: null, diff: [], denied: [t('assistant.denied.permission')] };
        for (const [key, def] of defs) if (!scopeAllowed(def.scopes, 'global')) denied.push(t('assistant.denied.scope', { key }));
        const issues = validateValues(this.deps.registry, { ...this.deps.store.layer('global'), ...clean }).filter((i) => Object.keys(clean).some((k) => i.keys.includes(k)) || i.messageKey.startsWith('validation.'));
        for (const i of issues) denied.push(this.issueText(i));
        before = this.s();
        for (const k of Object.keys(clean)) timing.set(k, { timing: 'now' });
      } else if (kind === 'user') {
        for (const [key, def] of defs) if (!scopeAllowed(def.scopes, 'user')) denied.push(t('assistant.denied.scope', { key }));
        const layer = this.deps.store.layer('user', userId);
        const issues = validateValues(this.deps.registry, { ...layer, ...clean }).filter((i) => Object.keys(clean).some((k) => i.keys.includes(k)));
        for (const i of issues) denied.push(this.issueText(i));
        before = this.deps.store.resolve([{ scope: 'user', scopeId: userId, values: layer }]);
        for (const k of Object.keys(clean)) timing.set(k, { timing: 'now' });
      } else {
        const id = String(target.id ?? '');
        if (!id) return { action: null, diff: [], denied: [t('assistant.denied.target')] };
        const prev = kind === 'table' ? this.deps.tables().previewSettings(userId, id, clean) : this.deps.tournaments().previewSettings(userId, id, clean);
        before = prev.before;
        timing = new Map(prev.rows.map((r) => [r.key, { timing: r.timing, reasonKey: r.reasonKey }]));
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      const issues = (e as { issues?: { messageKey?: string }[] }).issues;
      denied.push(code === 'FORBIDDEN' ? t('assistant.denied.permission') : code === 'NOT_FOUND' ? t('assistant.denied.target') : issues?.length ? issues.map((i) => (i.messageKey ? t(i.messageKey) : '')).join('; ') : t('assistant.denied.invalid', { key: '-', detail: code ?? 'ERROR' }));
    }
    const diff: ProposalDiffRow[] = [...defs].map(([key, def]) => {
      const tm = timing.get(key) ?? { timing: 'now' as const };
      return { key, label: t(labelKey(key)), before: this.fmt(def, before[key]), after: this.fmt(def, clean[key]), timing: tm.timing, ...(tm.reasonKey ? { reason: t(tm.reasonKey) } : {}) };
    });
    for (const r of diff) if (r.timing === 'denied') denied.push(r.reason ?? t('assistant.denied.permission'));
    if (denied.length) return { action: null, diff, denied: [...new Set(denied)] };
    return { action: { type: 'settings', target: { kind, ...(target.id ? { id: String(target.id) } : {}) }, changes: clean }, diff, denied: [] };
  }

  private async proposeSettings(env: ToolEnv, args: Record<string, unknown>) {
    const target = (args.target ?? {}) as { kind?: string; id?: string };
    const plan = await this.planSettings(env.userId, target, args.changes);
    if (!plan.action) return { ok: false, denied: plan.denied };
    const auto = !env.dryRun && env.source === 'assistant' && this.autoAllowed(plan.action);
    return this.finishProposal(env, [plan.action], plan.diff, auto);
  }

  private autoAllowed(a: ProposalAction): boolean {
    if (a.type !== 'settings' || a.target.kind === 'global') return false;
    const allowed = String(this.s()['assistant.autoKeys']).split(/[\s,;]+/).filter(Boolean);
    return allowed.length > 0 && Object.keys(a.changes).every((k) => allowed.includes(k));
  }

  private async proposeTournament(env: ToolEnv, args: Record<string, unknown>) {
    const name = String(args.name ?? '').trim();
    const templateId = String(args.templateId ?? '');
    const found = this.deps.templates().get(templateId);
    const template = found && found.kind === 'tournament' ? found : undefined;
    if (!template) return { ok: false, denied: [t('assistant.denied.template')] };
    if (name.length < 2 || name.length > 60) return { ok: false, denied: [t('assistant.denied.invalid', { key: 'name', detail: '2 až 60' })] };
    const settings: Record<string, SettingValue> = {};
    const denied: string[] = [];
    for (const c of Array.isArray(args.settings) ? (args.settings as { key?: unknown; value?: unknown }[]) : []) {
      const key = String(c?.key ?? '');
      const def = this.deps.registry.get(key);
      if (!this.visibleDef(def)) {
        denied.push(t('assistant.denied.unknownKey', { key }));
        continue;
      }
      const parsed = this.parseValue(def, c.value);
      if (!parsed.ok) denied.push(t('assistant.denied.invalid', { key, detail: parsed.detail }));
      else settings[key] = parsed.value;
    }
    let startAt: number | null = null;
    if (args.startAt) {
      startAt = Date.parse(String(args.startAt));
      if (!Number.isFinite(startAt)) denied.push(t('assistant.denied.invalid', { key: 'startAt', detail: 'ISO 8601' }));
      else if (!this.can(env.userId, 'turnaj.naplanovat')) denied.push(t('assistant.denied.permission'));
    }
    if (denied.length) return { ok: false, denied };
    const diff: ProposalDiffRow[] = [
      { key: '', label: startAt ? t('assistant.diff.createAt', { name, template: template.name, time: new Date(startAt).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }) }) : t('assistant.diff.create', { name, template: template.name }), before: '-', after: name, timing: 'now' },
      ...Object.entries(settings).map(([key, v]) => ({ key, label: t(labelKey(key)), before: '-', after: this.fmt(this.deps.registry.get(key)!, v), timing: 'now' as const })),
    ];
    return this.finishProposal(env, [{ type: 'createTournament', name, templateId, settings, startAt }], diff, false);
  }

  private async proposePoll(env: ToolEnv, args: Record<string, unknown>) {
    const title = String(args.title ?? '').trim();
    const options = (Array.isArray(args.options) ? (args.options as unknown[]) : []).map((o) => String(o).trim()).filter(Boolean);
    const minutes = Number.isFinite(Number(args.durationMinutes)) && Number(args.durationMinutes) > 0 ? Math.round(Number(args.durationMinutes)) : 60;
    if (!title || title.length > 120 || options.length < 2 || options.length > 10) return { ok: false, denied: [t('assistant.denied.invalid', { key: 'title', detail: '2 až 10 možností' })] };
    const diff: ProposalDiffRow[] = [{ key: '', label: t('assistant.diff.poll', { title, options: options.join(', ') }), before: '-', after: title, timing: 'now' }];
    return this.finishProposal(env, [{ type: 'poll', title, options, durationMinutes: minutes }], diff, false);
  }

  private async finishProposal(env: ToolEnv, actions: ProposalAction[], diff: ProposalDiffRow[], auto: boolean) {
    const zmeny = diff.map((r) => (r.key ? `${r.label}: ${r.before} → ${r.after} (${t(`assistant.diff.timing.${r.timing}`)})` : r.label)).join('; ');
    const hasPoll = actions.some((a) => a.type === 'poll');
    const summary = await this.template(hasPoll ? 'votePoll' : 'summary', { pocet: diff.length, zmeny });
    if (env.dryRun) {
      const dto: ProposalDto = { id: `dry-${env.proposals.length + 1}`, status: 'pending', summary, diff, requestText: env.requestText, expiresAt: 0, createdAt: this.deps.now(), result: null, values: Object.assign({}, ...actions.map((a) => (a.type === 'settings' ? a.changes : {}))) };
      env.proposals.push(dto);
      return { ok: true, proposalId: dto.id, summary, note: 'sandbox' };
    }
    const expiresAt = new Date(this.deps.now() + Number(this.s()['assistant.proposalMinutes']) * 60_000);
    const [row] = await this.deps.db
      .insert(schema.assistantProposals)
      .values({ userId: env.userId, source: env.source === 'mcp' ? 'mcp' : 'assistant', requestText: clip(env.requestText, 2000), actions, diff, summary, expiresAt })
      .returning();
    let dto = this.proposalDto(row!);
    if (auto) dto = await this.apply(env.userId, row!.id, undefined, env.source);
    env.proposals.push(dto);
    return { ok: true, proposalId: dto.id, summary, status: dto.status, ...(dto.status === 'applied' ? { applied: true } : { awaitingConfirmation: true }) };
  }

  private proposalDto(r: typeof schema.assistantProposals.$inferSelect): ProposalDto {
    return { id: r.id, status: r.status as ProposalStatus, summary: r.summary, diff: r.diff as ProposalDiffRow[], requestText: r.requestText, expiresAt: r.expiresAt.getTime(), createdAt: r.createdAt.getTime(), result: r.result, values: Object.assign({}, ...(r.actions as ProposalAction[]).map((a) => (a.type === 'settings' ? a.changes : {}))) };
  }

  // ---------- potvrzení, zamítnutí ----------

  async proposals(userId: string, status?: string): Promise<ProposalDto[]> {
    const rows = await this.deps.db
      .select()
      .from(schema.assistantProposals)
      .where(status ? and(eq(schema.assistantProposals.userId, userId), eq(schema.assistantProposals.status, status)) : eq(schema.assistantProposals.userId, userId))
      .orderBy(desc(schema.assistantProposals.createdAt))
      .limit(30);
    return rows.map((r) => this.proposalDto(r.status === 'pending' && r.expiresAt.getTime() <= this.deps.now() ? { ...r, status: 'expired' } : r));
  }

  private async mine(userId: string, id: string) {
    const [r] = await this.deps.db.select().from(schema.assistantProposals).where(eq(schema.assistantProposals.id, id));
    if (!r || r.userId !== userId) throw new AssistantError('NOT_FOUND');
    return r;
  }

  /** Provede návrh po potvrzení. `edits` přepíše hodnoty parametrů (uživatel je upravil v náhledu). */
  async apply(userId: string, id: string, edits?: Record<string, string | number | boolean>, source: AuditSource = 'assistant'): Promise<ProposalDto> {
    if (!this.can(userId, source === 'mcp' ? 'asistent.mcp' : 'asistent.pouzivat')) throw new AssistantError('FORBIDDEN');
    const row = await this.mine(userId, id);
    if (row.status !== 'pending') throw new AssistantError('NOT_PENDING');
    if (row.expiresAt.getTime() <= this.deps.now()) {
      await this.deps.db.update(schema.assistantProposals).set({ status: 'expired', decidedAt: new Date(this.deps.now()) }).where(eq(schema.assistantProposals.id, id));
      throw new AssistantError('EXPIRED');
    }
    const meta = { source, reason: clip(row.requestText, 500) } as const;
    const applied: string[] = [];
    const pending: string[] = [];
    let diff = row.diff as ProposalDiffRow[];
    try {
      const actions = row.actions as ProposalAction[];
      // znovu ověřit (oprávnění a stav hry se mohly změnit) a případně použít upravené hodnoty
      const final: ProposalAction[] = [];
      for (const a of actions) {
        if (a.type !== 'settings') {
          final.push(a);
          continue;
        }
        const merged = { ...a.changes, ...Object.fromEntries(Object.entries(edits ?? {}).filter(([k]) => k in a.changes)) };
        const plan = await this.planSettings(userId, a.target, Object.entries(merged).map(([key, value]) => ({ key, value })));
        if (!plan.action) throw new AssistantError('INVALID', { field: plan.denied.join('; ') });
        diff = plan.diff;
        final.push(plan.action);
      }
      for (const a of final) {
        if (a.type === 'settings') {
          if (a.target.kind === 'global') for (const [k, v] of Object.entries(a.changes)) await this.deps.store.set(userId, 'global', '', k, v, { meta });
          else if (a.target.kind === 'user') for (const [k, v] of Object.entries(a.changes)) await this.deps.store.set(userId, 'user', userId, k, v, { meta });
          else {
            const r = a.target.kind === 'table' ? await this.deps.tables().updateSettings(userId, a.target.id!, a.changes, meta) : await this.deps.tournaments().updateSettings(userId, a.target.id!, a.changes, meta);
            applied.push(...r.applied);
            pending.push(...r.pending);
            continue;
          }
          applied.push(...Object.keys(a.changes));
        } else if (a.type === 'createTournament') {
          const r = a.startAt
            ? await this.deps.tournaments().scheduleTournament(userId, { name: a.name, templateId: a.templateId, settings: a.settings, startAt: a.startAt }, meta)
            : await this.deps.tournaments().create(userId, { name: a.name, templateId: a.templateId, settings: a.settings }, meta);
          applied.push(`tournament:${r.id}`);
        } else {
          const pollId = await this.deps.polls().create(userId, { title: a.title, config: { type: 'single', options: a.options.map((label) => ({ label })) }, durationMinutes: a.durationMinutes } as never);
          applied.push(`poll:${pollId}`);
        }
      }
      const result = { applied, pending };
      const [upd] = await this.deps.db.update(schema.assistantProposals).set({ status: 'applied', result, diff, decidedAt: new Date(this.deps.now()) }).where(eq(schema.assistantProposals.id, id)).returning();
      await this.deps.audit.log({ actorId: userId, action: 'asistent.potvrdit', targetType: 'assistant_proposal', targetId: id, after: result, source, reason: clip(row.requestText, 500) });
      return this.proposalDto(upd!);
    } catch (e) {
      const detail = e instanceof AssistantError ? `${e.code}${e.params.field ? `: ${e.params.field}` : ''}` : e instanceof Error ? e.message : 'ERROR';
      const [upd] = await this.deps.db.update(schema.assistantProposals).set({ status: 'failed', result: { error: detail, applied }, decidedAt: new Date(this.deps.now()) }).where(eq(schema.assistantProposals.id, id)).returning();
      await this.deps.audit.log({ actorId: userId, action: 'asistent.selhalo', targetType: 'assistant_proposal', targetId: id, after: { error: detail }, source });
      return this.proposalDto(upd!);
    }
  }

  async reject(userId: string, id: string): Promise<ProposalDto> {
    const row = await this.mine(userId, id);
    if (row.status !== 'pending') throw new AssistantError('NOT_PENDING');
    const [upd] = await this.deps.db.update(schema.assistantProposals).set({ status: 'rejected', decidedAt: new Date(this.deps.now()) }).where(eq(schema.assistantProposals.id, id)).returning();
    await this.deps.audit.log({ actorId: userId, action: 'asistent.zamitnout', targetType: 'assistant_proposal', targetId: id, source: 'assistant' });
    return this.proposalDto(upd!);
  }

  // ---------- konverzace ----------

  async history(userId: string, limit = 40) {
    const rows = await this.deps.db.select().from(schema.assistantMessages).where(eq(schema.assistantMessages.userId, userId)).orderBy(desc(schema.assistantMessages.createdAt)).limit(limit);
    const out = [];
    for (const r of rows.reverse()) {
      const proposals: ProposalDto[] = [];
      for (const pid of r.proposalIds) {
        const [p] = await this.deps.db.select().from(schema.assistantProposals).where(eq(schema.assistantProposals.id, pid));
        if (p) proposals.push(this.proposalDto(p.status === 'pending' && p.expiresAt.getTime() <= this.deps.now() ? { ...p, status: 'expired' } : p));
      }
      out.push({ id: r.id, role: r.role as 'user' | 'assistant', content: r.content, context: r.context, at: r.createdAt.getTime(), proposals });
    }
    return out;
  }

  async clearHistory(userId: string): Promise<void> {
    await this.deps.db.delete(schema.assistantMessages).where(eq(schema.assistantMessages.userId, userId));
  }

  /** Jedna výměna s modelem včetně smyčky nástrojů. */
  private async converse(userId: string, text: string, ctx: AssistantContext, targetId: string | undefined, env: ToolEnv, history: ChatMsg[]): Promise<{ reply: string; tokens: number; system: string }> {
    const s = this.s();
    const provider = await this.provider();
    const system = await this.buildSystem(userId, ctx, targetId);
    const tools = await this.toolSpecs(userId, ctx);
    const messages: ChatMsg[] = [...history, { role: 'user', content: text }];
    const maxSteps = Number(s['assistant.maxToolSteps']);
    const retries = Number(s['assistant.retries']);
    const perCallMs = Number(s['assistant.timeoutSeconds']) * 1000;
    const deadline = this.deps.now() + Number(s['assistant.totalTimeoutSeconds']) * 1000;
    const maxChars = Number(s['assistant.toolResultChars']);
    let tokens = 0;
    let reply = '';
    for (let step = 0; step <= maxSteps; step++) {
      let result;
      for (let attempt = 0; ; attempt++) {
        // Celkový strop otázky a limit volání za minutu (bezplatný plán poskytovatele): bez zbytečného čekání a bez zasypání poskytovatele.
        const remaining = deadline - this.deps.now();
        if (remaining <= 0) throw new AssistantError('TIMEOUT');
        this.takeCallSlot();
        try {
          result = await provider.complete({
            model: this.modelFor(ctx),
            system,
            messages,
            tools: step < maxSteps ? tools : [],
            temperature: Number(s['assistant.temperaturePercent']) / 100,
            maxTokens: Number(s['assistant.maxTokens']),
            timeoutMs: Math.min(perCallMs, remaining),
          });
          break;
        } catch (e) {
          const pe = e instanceof ProviderError ? e : null;
          // Vypršený čas a vyčerpaný limit poskytovatele se neopakují (druhý pokus by dopadl stejně a jen by spotřeboval limit).
          if (pe?.status === 429) throw new AssistantError('PROVIDER_LIMIT');
          if (pe?.detail === 'TIMEOUT') throw new AssistantError('TIMEOUT');
          if (attempt >= retries) throw new AssistantError('PROVIDER', { detail: pe ? pe.detail : e instanceof Error ? e.message : 'ERROR' });
        }
      }
      tokens += result.tokens;
      if (result.toolCalls.length === 0) {
        reply = result.text;
        break;
      }
      messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
      for (const call of result.toolCalls as ToolCall[]) messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: clipTool(await this.runTool(env, call.name, call.args), maxChars) });
      reply = result.text;
    }
    return { reply, tokens, system };
  }

  /** Rezervuje volání modelu v posuvném okně minuty; nad limit vyhodí BUSY s dobou čekání. */
  private takeCallSlot(): void {
    const limit = Number(this.s()['assistant.perMinute']);
    const now = this.deps.now();
    this.calls = this.calls.filter((at) => now - at < 60_000);
    if (limit > 0 && this.calls.length >= limit) throw new AssistantError('BUSY', { seconds: Math.max(1, Math.ceil((this.calls[0]! + 60_000 - now) / 1000)) });
    this.calls.push(now);
  }

  private checkReady = async (userId: string): Promise<void> => {
    if (!this.can(userId, 'asistent.pouzivat')) throw new AssistantError('FORBIDDEN');
    if (!(await this.configured())) throw new AssistantError('DISABLED');
  };

  async chat(userId: string, input: { text: string; context?: string; targetId?: string }): Promise<ChatResult> {
    await this.checkReady(userId);
    const text = (input.text ?? '').trim();
    if (!text || text.length > 4000) throw new AssistantError('INVALID', { field: 'text' });
    const ctx: AssistantContext = input.context && isAssistantContext(input.context) ? input.context : 'lobby';
    // Jednoduchá otázka na vysvětlení: odpověď z návodu bez AI (nestojí limit poskytovatele ani denní limity). Opakovaná stejná otázka jde na model.
    if (this.s()['assistant.localFirst'] && EXPLAIN_CONTEXTS.includes(ctx)) {
      const last = (await this.history(userId, 2)).filter((m) => m.role === 'user').pop();
      const local = last?.content.trim().toLowerCase() === text.toLowerCase() ? null : answerFromGuide(text);
      if (local) {
        const reply = [t('assistant.local.prefix', { chapter: local.chapter }), ...local.paragraphs.map((p) => `• ${p}`), '', t('assistant.local.suffix')].join('\n');
        await this.deps.db.insert(schema.assistantMessages).values({ userId, context: ctx, role: 'user', content: text });
        await this.deps.db.insert(schema.assistantMessages).values({ userId, context: ctx, role: 'assistant', content: reply, proposalIds: [] });
        await this.countLocal(userId);
        return { reply, proposals: [], tokens: 0 };
      }
    }
    await this.spend(userId);
    const env: ToolEnv = { userId, source: 'assistant', requestText: text, dryRun: false, proposals: [] };
    const size = Number(this.s()['assistant.historySize']);
    const past = size > 0 ? (await this.history(userId, size)).map((m): ChatMsg => (m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content })) : [];
    await this.deps.db.insert(schema.assistantMessages).values({ userId, context: ctx, role: 'user', content: text });
    const out = await this.converse(userId, text, ctx, input.targetId, env, past);
    await this.addTokens(userId, out.tokens);
    const reply = out.reply || (env.proposals[0]?.summary ?? '');
    await this.deps.db.insert(schema.assistantMessages).values({ userId, context: ctx, role: 'assistant', content: reply, proposalIds: env.proposals.map((p) => p.id) });
    return { reply, proposals: env.proposals, tokens: out.tokens };
  }

  /** Pískoviště: celý průchod bez zápisu a bez provedení; vrací odeslaný prompt. */
  async sandbox(actorId: string, input: { text: string; context?: string; targetId?: string; asUserId?: string }) {
    this.manage(actorId);
    if (!(await this.configured())) throw new AssistantError('DISABLED');
    const text = (input.text ?? '').trim();
    if (!text || text.length > 4000) throw new AssistantError('INVALID', { field: 'text' });
    const ctx: AssistantContext = input.context && isAssistantContext(input.context) ? input.context : 'lobby';
    const userId = input.asUserId ?? actorId;
    const env: ToolEnv = { userId, source: 'assistant', requestText: text, dryRun: true, proposals: [] };
    const out = await this.converse(userId, text, ctx, input.targetId, env, []);
    await this.addTokens(actorId, 0);
    return { system: out.system, reply: out.reply, tokens: out.tokens, proposals: env.proposals };
  }

  /** Zkouška spojení s poskytovatelem. */
  async test(actorId: string): Promise<{ ok: boolean; error?: string }> {
    this.manage(actorId);
    if (!(await this.configured())) throw new AssistantError('DISABLED');
    try {
      const r = await (await this.provider()).complete({ model: this.modelFor('rules'), system: 'ping', messages: [{ role: 'user', content: 'ping' }], tools: [], temperature: 0, maxTokens: 16, timeoutMs: Number(this.s()['assistant.timeoutSeconds']) * 1000 });
      return { ok: r.text.length >= 0 };
    } catch (e) {
      return { ok: false, error: e instanceof ProviderError ? e.detail : e instanceof Error ? e.message : 'ERROR' };
    }
  }

  /** Použití z MCP: volání nástroje jménem uživatele (návrhy se tvoří stejně, potvrzují druhým voláním). */
  async callToolExternal(userId: string, name: string, args: Record<string, unknown>, requestText: string): Promise<{ text: string; proposals: ProposalDto[] }> {
    if (!this.can(userId, 'asistent.mcp')) throw new AssistantError('FORBIDDEN');
    const env: ToolEnv = { userId, source: 'mcp', requestText: requestText || name, dryRun: false, proposals: [] };
    const text = await this.runTool(env, name, args);
    return { text, proposals: env.proposals };
  }
}

/** Popisy ve schématu nástrojů jsou klíče překladů; model dostane české věty. */
function translateSchema(s: ToolDef['parameters']): ToolDef['parameters'] {
  const tr = (x: ToolDef['parameters']): ToolDef['parameters'] => ({
    ...x,
    ...(x.description ? { description: t(x.description) } : {}),
    ...(x.properties ? { properties: Object.fromEntries(Object.entries(x.properties).map(([k, v]) => [k, tr(v)])) } : {}),
    ...(x.items ? { items: tr(x.items) } : {}),
  });
  return tr(s);
}

const assistantUsageRequests = schema.assistantUsage.requests;
