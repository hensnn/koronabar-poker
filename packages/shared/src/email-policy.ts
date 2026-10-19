/**
 * Pravidla odesílání e-mailů, která určuje správce: zda se vůbec posílá, které druhy zpráv a komu.
 * Čistá funkce bez závislostí, takže ji lze snadno testovat; server ji volá před zařazením e-mailu do fronty.
 */

export type EmailRecipientMode = 'all' | 'verified' | 'roles' | 'list';

export type EmailSkipReason = 'disabled' | 'blocked' | 'kind' | 'notVerified' | 'role' | 'notListed' | 'userOptOut';

export interface EmailPolicyInput {
  settings: Record<string, unknown>;
  /** Bezpečnostní e-mail (ověření, obnova hesla…): jde vypnout jen celé odesílání nebo blokací adresy. */
  security: boolean;
  /** Klíč šablony. */
  key: string;
  address: string;
  /** Má příjemce ověřený e-mail (null = adresa nepatří žádnému účtu). */
  verified: boolean | null;
  /** Klíče rolí příjemce (prázdné, když adresa nepatří žádnému účtu). */
  roleKeys: string[];
  /** Hráč si tento druh osobně vypnul (jen u nepovinných zpráv). */
  userOptedOut?: boolean;
}

export type EmailDecision = { send: true } | { send: false; reason: EmailSkipReason };

/** Seznam z textu: oddělovač čárka, středník nebo nový řádek; bez rozlišení velikosti písmen. */
export function parseList(text: unknown): string[] {
  return String(text ?? '')
    .split(/[\n,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/** Adresa vyhovuje položce seznamu: přesná adresa, `@domena.cz` nebo `domena.cz` (včetně poddomén). */
export function addressMatches(address: string, entry: string): boolean {
  const a = address.trim().toLowerCase();
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e.includes('@') && !e.startsWith('@')) return a === e;
  const domain = e.startsWith('@') ? e.slice(1) : e;
  const host = a.split('@')[1] ?? '';
  return host === domain || host.endsWith('.' + domain);
}

export function emailDecision(i: EmailPolicyInput): EmailDecision {
  const s = i.settings;
  if (s['email.enabled'] === false) return { send: false, reason: 'disabled' };
  if (parseList(s['email.blockList']).some((e) => addressMatches(i.address, e))) return { send: false, reason: 'blocked' };
  if (i.security) return { send: true };
  if (parseList(s['email.disabledKinds']).includes(i.key.toLowerCase())) return { send: false, reason: 'kind' };
  const mode = String(s['email.recipientMode'] ?? 'all') as EmailRecipientMode;
  if (mode === 'verified' && i.verified !== true) return { send: false, reason: 'notVerified' };
  if (mode === 'roles') {
    const allowed = parseList(s['email.recipientRoles']);
    if (!i.roleKeys.some((r) => allowed.includes(r.toLowerCase()))) return { send: false, reason: 'role' };
  }
  if (mode === 'list' && !parseList(s['email.recipientList']).some((e) => addressMatches(i.address, e))) return { send: false, reason: 'notListed' };
  if (i.userOptedOut && s['email.allowUserOptOut'] !== false) return { send: false, reason: 'userOptOut' };
  return { send: true };
}
