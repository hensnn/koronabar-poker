/**
 * AI asistent nastavení a MCP server. Nástroje a prompty jsou popsané jednou tady; vlastní texty výchozích promptů
 * jsou v překladech (`assistant.prompt.*`) a v GUI jdou upravit (verze, reset). Asistent změny jen navrhuje.
 */

export const ASSISTANT_CONTEXTS = ['lobby', 'table', 'admin', 'theme', 'planning', 'rules', 'mcp'] as const;
export type AssistantContext = (typeof ASSISTANT_CONTEXTS)[number];
export const isAssistantContext = (c: string): c is AssistantContext => (ASSISTANT_CONTEXTS as readonly string[]).includes(c);

export const AI_PROVIDERS = ['gemini', 'anthropic', 'openai', 'compatible'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

/** Klíče upravitelných promptů a šablon textů. */
export const PROMPT_KEYS = [
  'system',
  ...ASSISTANT_CONTEXTS.map((c) => `ctx.${c}` as const),
  'tpl.summary',
  'tpl.confirmed',
  'tpl.rejected',
  'tpl.denied',
  'tpl.afterStart',
  'tpl.error',
  'tpl.votePoll',
] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];
export const isPromptKey = (k: string): k is PromptKey => (PROMPT_KEYS as readonly string[]).includes(k);

/** Proměnné v promptech: jméno, kterých kontextů se týkají (`null` = všech) a které šablony je znají. */
export const PROMPT_VARIABLES: { name: string; contexts: AssistantContext[] | null; description: string }[] = [
  { name: 'prezdivka', contexts: null, description: 'assistant.var.prezdivka' },
  { name: 'role', contexts: null, description: 'assistant.var.role' },
  { name: 'opravneni', contexts: null, description: 'assistant.var.opravneni' },
  { name: 'kontext', contexts: null, description: 'assistant.var.kontext' },
  { name: 'datum', contexts: null, description: 'assistant.var.datum' },
  { name: 'cas', contexts: null, description: 'assistant.var.cas' },
  { name: 'jazyk', contexts: null, description: 'assistant.var.jazyk' },
  { name: 'nazev_aplikace', contexts: null, description: 'assistant.var.nazev_aplikace' },
  { name: 'mena', contexts: null, description: 'assistant.var.mena' },
  { name: 'stul', contexts: ['table', 'planning'], description: 'assistant.var.stul' },
  { name: 'stav_hry', contexts: ['table', 'planning', 'lobby'], description: 'assistant.var.stav_hry' },
  { name: 'aktualni_nastaveni', contexts: ['table', 'admin', 'planning'], description: 'assistant.var.aktualni_nastaveni' },
  { name: 'sablona', contexts: ['planning'], description: 'assistant.var.sablona' },
];

/** Proměnné šablon textů (návrh, potvrzení, odmítnutí…). */
export const TEMPLATE_VARIABLES = ['pocet', 'zmeny', 'duvod', 'klic', 'nazev_aplikace'] as const;

/** Proměnné, které smí prompt daného klíče použít. */
export function allowedVariables(key: PromptKey): string[] {
  if (key.startsWith('tpl.')) return [...TEMPLATE_VARIABLES];
  if (key === 'system') return PROMPT_VARIABLES.map((v) => v.name);
  const ctx = key.slice(4) as AssistantContext;
  return PROMPT_VARIABLES.filter((v) => v.contexts === null || v.contexts.includes(ctx)).map((v) => v.name);
}

export function unknownVariables(text: string, allowed: string[]): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\{([a-zA-Z_]+)\}/g)) if (!allowed.includes(m[1]!)) found.add(m[1]!);
  return [...found];
}

/** Dosadí proměnné; neznámé nechá beze změny, aby šly v editoru vidět. */
export function renderPrompt(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{([a-zA-Z_]+)\}/g, (whole, name: string) => (vars[name] === undefined ? whole : String(vars[name])));
}

// ---------- nástroje ----------

export type ToolKind = 'read' | 'propose';

export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly string[];
}

export interface ToolDef {
  name: string;
  kind: ToolKind;
  parameters: JsonSchema;
  /** Oprávnění potřebné ke zveřejnění nástroje (kontroluje se i při volání). */
  permission: string | null;
}

export const TARGET_KINDS = ['global', 'user', 'table', 'tournament'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

const target: JsonSchema = {
  type: 'object',
  description: 'assistant.schema.target',
  properties: {
    kind: { type: 'string', enum: TARGET_KINDS, description: 'assistant.schema.targetKind' },
    id: { type: 'string', description: 'assistant.schema.targetId' },
  },
  required: ['kind'],
};
const changes: JsonSchema = {
  type: 'array',
  description: 'assistant.schema.changes',
  items: { type: 'object', properties: { key: { type: 'string', description: 'assistant.schema.key' }, value: { type: 'string', description: 'assistant.schema.value' } }, required: ['key', 'value'] },
};

export const ASSISTANT_TOOLS: ToolDef[] = [
  { name: 'search_guide', kind: 'read', permission: null, parameters: { type: 'object', properties: { query: { type: 'string', description: 'assistant.schema.query' } }, required: ['query'] } },
  { name: 'search_settings', kind: 'read', permission: null, parameters: { type: 'object', properties: { query: { type: 'string', description: 'assistant.schema.query' } }, required: ['query'] } },
  { name: 'get_settings', kind: 'read', permission: null, parameters: { type: 'object', properties: { target, keys: { type: 'array', items: { type: 'string' }, description: 'assistant.schema.keys' } }, required: ['target'] } },
  { name: 'explain_setting', kind: 'read', permission: null, parameters: { type: 'object', properties: { key: { type: 'string', description: 'assistant.schema.key' } }, required: ['key'] } },
  { name: 'list_games', kind: 'read', permission: null, parameters: { type: 'object', properties: {} } },
  { name: 'list_templates', kind: 'read', permission: null, parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['cash', 'tournament'], description: 'assistant.schema.templateKind' } } } },
  { name: 'propose_settings_change', kind: 'propose', permission: null, parameters: { type: 'object', properties: { target, changes, note: { type: 'string', description: 'assistant.schema.note' } }, required: ['target', 'changes'] } },
  {
    name: 'propose_create_tournament',
    kind: 'propose',
    permission: 'turnaj.vytvorit',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'assistant.schema.name' },
        templateId: { type: 'string', description: 'assistant.schema.templateId' },
        settings: changes,
        startAt: { type: 'string', description: 'assistant.schema.startAt' },
      },
      required: ['name', 'templateId'],
    },
  },
  {
    name: 'propose_poll',
    kind: 'propose',
    permission: 'anketa.vytvorit',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'assistant.schema.pollTitle' },
        options: { type: 'array', items: { type: 'string' }, description: 'assistant.schema.pollOptions' },
        durationMinutes: { type: 'integer', description: 'assistant.schema.pollMinutes' },
      },
      required: ['title', 'options'],
    },
  },
];

export const TOOL_NAMES = ASSISTANT_TOOLS.map((t) => t.name);

/** Akce uložená v návrhu (provádí se až po potvrzení, znovu s kontrolou oprávnění). */
export type ProposalAction =
  | { type: 'settings'; target: { kind: TargetKind; id?: string }; changes: Record<string, string | number | boolean> }
  | { type: 'createTournament'; name: string; templateId: string; settings: Record<string, string | number | boolean>; startAt: number | null }
  | { type: 'poll'; title: string; options: string[]; durationMinutes: number };

/** Řádek náhledu „před → po“. */
export interface ProposalDiffRow {
  key: string;
  label: string;
  before: string;
  after: string;
  /** now = hned, nextHand = od další handy, denied = nelze (důvod v `reason`). */
  timing: 'now' | 'nextHand' | 'denied';
  reason?: string;
}

export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'failed' | 'expired';
