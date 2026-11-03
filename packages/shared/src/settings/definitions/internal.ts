/**
 * Provozní (interní) parametry: adresy serverů, účty a infrastruktura herny. Nejsou tajné
 * (hesla jsou v tajných údajích), ale běžný hráč je k ničemu nepotřebuje, a tak se mu
 * neposílají: `GET /api/settings/global` je vrací jen správci s právem `nastaveni.globalni`,
 * AI asistent je nevidí v kontextu ani v nástroji `get_settings`.
 */
const INTERNAL_PREFIXES = ['email.smtp', 'integrations.mqtt', 'announcer.piper'] as const;
const INTERNAL_KEYS = new Set<string>([
  'system.publicUrl',
  'assistant.baseUrl',
  'assistant.autoKeys',
  'assistant.disabledTools',
  'mcp.disabledTools',
  'email.fromAddress',
  'email.replyTo',
  'email.recipientRoles',
  'email.recipientList',
  'email.blockList',
]);

/** Je parametr provozní (jen pro správce)? */
export const isInternalSetting = (key: string): boolean => INTERNAL_KEYS.has(key) || INTERNAL_PREFIXES.some((p) => key.startsWith(p));

/** Vrstva hodnot bez provozních parametrů (pro hráče bez práva na globální nastavení). */
export function omitInternalSettings<T extends Record<string, unknown>>(values: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(values) as (keyof T)[]) if (!isInternalSetting(String(k))) out[k] = values[k];
  return out;
}
