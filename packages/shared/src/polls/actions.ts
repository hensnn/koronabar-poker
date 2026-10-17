import type { PollConfig } from './engine.js';

/**
 * Akce navázaná na výsledek ankety. Provede se jen při schválení (anketa skončila s výsledkem „přijato“),
 * jen v rozsahu oprávnění zakladatele a volitelně až po potvrzení oprávněnou osobou.
 */
export const ACTION_KINDS = ['scheduleTournament', 'useTemplate', 'changeSettings', 'pauseGame', 'endGame', 'assignRole'] as const;
export type PollActionKind = (typeof ACTION_KINDS)[number];

export type ActionState = 'waiting' | 'pendingConfirm' | 'done' | 'failed' | 'skipped' | 'rejected';

export interface PollAction {
  kind: PollActionKind;
  /** Potvrdí výsledek ještě oprávněná osoba, než se akce provede. */
  requireConfirm: boolean;
  params: Record<string, unknown>;
  state?: ActionState;
  /** Chybový kód, nebo odkaz na to, co akce vytvořila. */
  message?: string;
  createdId?: string;
  confirmedBy?: string | null;
}

export type ActionIssue = 'kind' | 'type' | 'params' | 'options';

const str = (v: unknown, min: number, max: number) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const obj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Zkontroluje akci vzhledem k druhu ankety a jejím možnostem. */
export function validatePollAction(raw: unknown, c: PollConfig): { ok: true; action: PollAction } | { ok: false; issue: ActionIssue } {
  const a = raw as Partial<PollAction> | null;
  if (!a || !ACTION_KINDS.includes(a.kind as PollActionKind)) return { ok: false, issue: 'kind' };
  const p = (a.params ?? {}) as Record<string, unknown>;
  if (!obj(p)) return { ok: false, issue: 'params' };
  const hasAt = c.options.length > 0 && c.options.every((o) => typeof o.at === 'number' && Number.isFinite(o.at));
  const hasValue = c.options.length > 0 && c.options.every((o) => typeof o.value === 'string' && o.value.length > 0 && o.value.length <= 200);
  const fail = (issue: ActionIssue) => ({ ok: false as const, issue });
  switch (a.kind as PollActionKind) {
    case 'scheduleTournament':
      if (!['schedule', 'single'].includes(c.type)) return fail('type');
      if (!hasAt) return fail('options');
      if (!str(p.name, 2, 60) || !str(p.templateId, 1, 80) || (p.settings !== undefined && !obj(p.settings))) return fail('params');
      break;
    case 'useTemplate':
      if (c.type === 'single') {
        if (!hasValue) return fail('options');
      } else if (c.type !== 'yesno' || !str(p.templateId, 1, 80)) return fail('type');
      if (!str(p.name, 2, 60)) return fail('params');
      break;
    case 'changeSettings':
      if (!['table', 'tournament'].includes(p.gameKind as string) || !str(p.id, 1, 80)) return fail('params');
      if (c.type === 'single') {
        if (!hasValue) return fail('options');
        if (!str(p.settingKey, 1, 80)) return fail('params');
      } else if (c.type !== 'yesno' || !obj(p.settings) || Object.keys(p.settings as object).length === 0 || Object.keys(p.settings as object).length > 20) return fail('params');
      break;
    case 'pauseGame':
      if (c.type !== 'yesno') return fail('type');
      if (!str(p.tournamentId, 1, 80)) return fail('params');
      break;
    case 'endGame':
      if (c.type !== 'yesno') return fail('type');
      if (!['table', 'tournament'].includes(p.gameKind as string) || !str(p.id, 1, 80)) return fail('params');
      break;
    case 'assignRole':
      if (!str(p.roleKey, 1, 60)) return fail('params');
      if (c.type === 'single') {
        if (!hasValue) return fail('options');
      } else if (c.type !== 'yesno' || !str(p.userId, 1, 80)) return fail('type');
      break;
  }
  return { ok: true, action: { kind: a.kind as PollActionKind, requireConfirm: a.requireConfirm !== false, params: p, state: 'waiting' } };
}

/** Hodnota nastavení z textu vítězné možnosti: číslo, ano/ne, jinak text. */
export function coerceSettingValue(text: string): string | number | boolean {
  const s = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^(true|ano)$/i.test(s)) return true;
  if (/^(false|ne)$/i.test(s)) return false;
  return s;
}
