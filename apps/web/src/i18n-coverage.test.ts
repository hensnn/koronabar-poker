import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { API_SCOPE_LIST, ASSISTANT_TOOLS, COSMETIC_KINDS, INTEGRATION_EVENTS, PROMPT_KEYS, SECRETS, cs } from '@kb/shared';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('překlady: každý použitý klíč existuje', () => {
  const sources = files(__dirname).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'));
  const used = new Set<string>();
  for (const f of sources) {
    const text = readFileSync(f, 'utf8');
    // t('klíč') i errorText/label klíče předávané jako řetězce
    for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.:-]+)'/g)) used.add(m[1]!);
    for (const m of text.matchAll(/label:\s*'((?:admin|nav|auth)\.[a-zA-Z0-9_.]+)'/g)) used.add(m[1]!);
  }
  it('žádný chybějící klíč', () => {
    const missing = [...used].filter((k) => !(k in cs)).sort();
    expect(missing).toEqual([]);
  });
  it('katalogy (tajné údaje, události, nástroje, rozsahy, kosmetika) mají popisky', () => {
    const missing = [
      ...SECRETS.map((x) => `secret.${x.key}`),
      ...INTEGRATION_EVENTS.flatMap((e) => [`integration.event.${e}`, `integration.discord.${e}`]),
      ...ASSISTANT_TOOLS.map((x) => `assistant.tool.${x.name}`),
      ...PROMPT_KEYS.flatMap((k) => [`prompt.key.${k}`, `assistant.prompt.${k}`]),
      ...API_SCOPE_LIST.map((s) => `api.scope.${s}`),
      ...COSMETIC_KINDS.map((k) => `cosmetic.kind.${k}`),
    ].filter((k) => !(k in cs));
    expect(missing).toEqual([]);
  });
  it('dynamické klíče mají překlad pro všechny hodnoty', () => {
    const groups: Record<string, string[]> = {
      'lobby.straddle.': ['mandatory', 'optional'],
      'request.status.': ['pending', 'approved', 'rejected', 'cancelled'],
      'ledger.kind.': ['mint', 'cash_buyin', 'cash_topup', 'cash_cashout', 'cash_return', 'rake', 'manual_adjustment'],
      'scope.': ['global', 'table', 'channel', 'tournament', 'series'],
      'email.status.': ['pending', 'sent', 'failed'],
      'email.tpl.': ['overeni_emailu', 'obnova_hesla', 'zmena_hesla', 'zmena_emailu', 'email_zmenen', 'pozvanka'],
      'approvals.status.': ['pending', 'approved', 'rejected', 'executed', 'failed', 'expired'],
      'secret.': ['smtp.password', 'ai.gemini.apiKey', 'ai.anthropic.apiKey', 'ai.openai.apiKey', 'tts.google.apiKey', 'mqtt.password', 'webhook.signingSecret', 'discord.webhookUrl', 'push.vapidPrivateKey'],
      'smtp.preset.': ['gmail', 'seznam', 'brevo', 'custom'],
      'error.': ['INVALID_CREDENTIALS', 'LOCKED', 'RATE_LIMITED', 'INVALID_INVITE', 'NICKNAME_TAKEN', 'EMAIL_TAKEN', 'WEAK_PASSWORD', 'TERMS_NOT_ACCEPTED', 'INVALID_NICKNAME', 'INVALID_EMAIL', 'FORBIDDEN', 'HIERARCHY', 'LOCKED_ROLE', 'EXCEEDS_OWN_PERMISSIONS', 'LIMIT_EXCEEDED', 'NOT_FOUND', 'INVALID_TOKEN', 'ROLE_IN_USE', 'LAST_MAIN_ADMIN', 'DUPLICATE_KEY', 'INVALID_INPUT', 'INVALID', 'FORBIDDEN_ORIGIN', 'UNKNOWN', 'NETWORK', 'UNKNOWN_VARIABLES', 'SETTINGS_FORBIDDEN', 'SETTINGS_UNKNOWN_KEY', 'SETTINGS_SCOPE_NOT_ALLOWED', 'SETTINGS_INVALID', 'SETTINGS_DENIED', 'TABLE_INVALID', 'TABLE_NOT_FOUND', 'TABLE_FORBIDDEN', 'TABLE_LIMIT_EXCEEDED', 'TABLE_DENIED', 'SECRET_FORBIDDEN', 'SECRET_UNKNOWN_SECRET', 'SECRET_EMPTY', 'SECRET_DECRYPT_FAILED', 'INSUFFICIENT_FUNDS', 'NOT_BALANCED', 'CHAT_FORBIDDEN', 'CHAT_NOT_FOUND', 'CHAT_DISABLED', 'CHAT_EMPTY', 'CHAT_TOO_LONG', 'CHAT_RATE_LIMITED', 'CHAT_MUTED', 'CHAT_INVALID', 'CHAT_EDIT_EXPIRED', 'CHAT_BAD_EMOJI', 'PERMISSION_DENIED', 'INVALID_MESSAGE'],
    };
    const missing: string[] = [];
    for (const [prefix, values] of Object.entries(groups)) for (const v of values) if (!(`${prefix}${v}` in cs)) missing.push(`${prefix}${v}`);
    expect(missing).toEqual([]);
  });
});
