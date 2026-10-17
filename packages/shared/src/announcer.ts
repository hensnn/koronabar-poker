import { t } from './i18n/cs.js';

/**
 * Hlasatel: katalog událostí a práce se šablonami hlášek. Výchozí texty jsou v překladech (`announce.<událost>.<n>`),
 * správce je může v GUI přepsat vlastními variantami. Čistá logika bez závislosti na serveru, aby šla testovat samostatně.
 */
export interface AnnounceEventDef {
  key: string;
  /** Proměnné, které smí šablona použít. */
  vars: string[];
  /** Počet výchozích variant v překladech. */
  defaults: number;
  /** Událost patří stolu (karty a sázky), takže TV ji zobrazuje se stejným zpožděním jako přenos stolu. */
  table?: boolean;
}

export const ANNOUNCE_EVENTS: AnnounceEventDef[] = [
  { key: 'allIn', vars: ['nick'], defaults: 3, table: true },
  { key: 'tournamentStart', vars: ['name'], defaults: 2 },
  { key: 'levelUp', vars: ['level', 'sb', 'bb', 'ante'], defaults: 2 },
  { key: 'levelEnding', vars: ['seconds'], defaults: 2 },
  { key: 'break', vars: ['minutes'], defaults: 2 },
  { key: 'breakEnding', vars: ['seconds'], defaults: 1 },
  { key: 'breakEnd', vars: [], defaults: 2 },
  { key: 'eliminated', vars: ['nick', 'remaining'], defaults: 2 },
  { key: 'knockout', vars: ['killer', 'victim', 'amount'], defaults: 2 },
  { key: 'bubble', vars: [], defaults: 2 },
  { key: 'paused', vars: [], defaults: 1 },
  { key: 'resumed', vars: [], defaults: 1 },
  { key: 'winner', vars: ['winner', 'name'], defaults: 2 },
  { key: 'tableBroken', vars: ['no'], defaults: 2 },
  { key: 'finalTable', vars: ['no'], defaults: 2 },
  { key: 'handForHand', vars: [], defaults: 2 },
  { key: 'liveCashBuyIn', vars: ['nick', 'amount'], defaults: 2 },
  { key: 'liveCashCashOut', vars: ['nick', 'amount'], defaults: 2 },
];

export const announceEvent = (key: string): AnnounceEventDef | undefined => ANNOUNCE_EVENTS.find((e) => e.key === key);

/** Nastavení jedné události v GUI: zapnutí a vlastní varianty (prázdné = výchozí z překladů). */
export interface AnnounceTemplate {
  enabled: boolean;
  variants: string[];
}
export type AnnounceTemplates = Record<string, AnnounceTemplate>;

export const MAX_VARIANTS = 8;
export const MAX_TEMPLATE_LENGTH = 200;

export function defaultVariants(key: string): string[] {
  const def = announceEvent(key);
  return def ? Array.from({ length: def.defaults }, (_, i) => t(`announce.${key}.${i}`)) : [];
}

/** Dosadí proměnné; neznámá nebo chybějící proměnná zůstane prázdná, aby hlasatel nečetl složené závorky. */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template
    .replace(/\{(\w+)\}/g, (_, p: string) => (vars[p] === undefined ? '' : String(vars[p])))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Varianty události: vlastní, jinak výchozí. */
export function variantsOf(key: string, templates: AnnounceTemplates): string[] {
  const own = templates[key]?.variants.filter((v) => v.trim().length > 0) ?? [];
  return own.length > 0 ? own : defaultVariants(key);
}

export function isEventEnabled(key: string, templates: AnnounceTemplates): boolean {
  return templates[key]?.enabled ?? true;
}

/** Náhodná varianta, která není stejná jako minule (je-li z čeho vybírat). Vrací index. */
export function pickVariant(count: number, last: number | undefined, rnd: () => number): number {
  if (count <= 1) return 0;
  const pool = Array.from({ length: count }, (_, i) => i).filter((i) => i !== last);
  return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))]!;
}

/** Ověří šablony z GUI: jen známé události, počet a délka variant, jen povolené proměnné. Vrací chybu nebo čistá data. */
export function cleanTemplates(input: unknown): { ok: true; templates: AnnounceTemplates } | { ok: false; field: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, field: 'templates' };
  const out: AnnounceTemplates = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const def = announceEvent(key);
    if (!def) return { ok: false, field: key };
    const r = raw as Partial<AnnounceTemplate>;
    if (typeof r?.enabled !== 'boolean' || !Array.isArray(r.variants) || r.variants.length > MAX_VARIANTS) return { ok: false, field: key };
    const variants: string[] = [];
    for (const v of r.variants) {
      if (typeof v !== 'string') return { ok: false, field: key };
      const text = v.trim();
      if (!text) continue;
      if (text.length > MAX_TEMPLATE_LENGTH) return { ok: false, field: key };
      for (const m of text.matchAll(/\{(\w+)\}/g)) if (!def.vars.includes(m[1]!)) return { ok: false, field: `${key}.${m[1]}` };
      variants.push(text);
    }
    out[key] = { enabled: r.enabled, variants };
  }
  return { ok: true, templates: out };
}

/** „60, 10“ → [60, 10] (jen kladná celá čísla, sestupně, bez duplicit). */
export function parseCountdown(text: string): number[] {
  const nums = text
    .split(/[\s,;]+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 3600);
  return [...new Set(nums)].sort((a, b) => b - a);
}
