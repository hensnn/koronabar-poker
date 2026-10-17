import { describe, expect, it } from 'vitest';
import { coerceSettingValue, validatePollAction } from './actions.js';
import { DEFAULT_POLL_CONFIG, type PollConfig } from './engine.js';

const cfg = (over: Partial<PollConfig>): PollConfig => ({ ...DEFAULT_POLL_CONFIG, ...over });
const slots = (withAt = true) => [{ id: 'a', label: 'Pá', ...(withAt ? { at: 1_700_000_000_000 } : {}) }, { id: 'b', label: 'So', ...(withAt ? { at: 1_700_100_000_000 } : {}) }];

describe('akce navázané na anketu', () => {
  it('naplánování turnaje vyžaduje termíny u všech možností a platné parametry', () => {
    const ok = validatePollAction({ kind: 'scheduleTournament', params: { name: 'Páteční turnaj', templateId: 'tour-turbo' } }, cfg({ type: 'schedule', options: slots() }));
    expect(ok).toMatchObject({ ok: true, action: { kind: 'scheduleTournament', requireConfirm: true, state: 'waiting' } });
    expect(validatePollAction({ kind: 'scheduleTournament', params: { name: 'T', templateId: 'x' } }, cfg({ type: 'schedule', options: slots() }))).toEqual({ ok: false, issue: 'params' });
    expect(validatePollAction({ kind: 'scheduleTournament', params: { name: 'Turnaj', templateId: 'x' } }, cfg({ type: 'schedule', options: slots(false) }))).toEqual({ ok: false, issue: 'options' });
    expect(validatePollAction({ kind: 'scheduleTournament', params: { name: 'Turnaj', templateId: 'x' } }, cfg({ type: 'yesno' }))).toEqual({ ok: false, issue: 'type' });
  });

  it('šablona hry: u výběru z možností má každá možnost šablonu, u ano / ne jednu pevnou', () => {
    const opts = [{ id: 'a', label: 'Klasika', value: 'cash-klasika' }, { id: 'b', label: 'Divoká', value: 'cash-divoka' }];
    expect(validatePollAction({ kind: 'useTemplate', params: { name: 'Nový stůl' } }, cfg({ type: 'single', options: opts })).ok).toBe(true);
    expect(validatePollAction({ kind: 'useTemplate', params: { name: 'Nový stůl' } }, cfg({ type: 'single', options: [{ id: 'a', label: 'X' }, { id: 'b', label: 'Y' }] }))).toEqual({ ok: false, issue: 'options' });
    expect(validatePollAction({ kind: 'useTemplate', params: { name: 'Nový stůl', templateId: 'cash-klasika' } }, cfg({ type: 'yesno' })).ok).toBe(true);
    expect(validatePollAction({ kind: 'useTemplate', params: { name: 'Nový stůl' } }, cfg({ type: 'yesno' }))).toEqual({ ok: false, issue: 'type' });
  });

  it('nastavení, pauza, ukončení hry a přidělení role', () => {
    expect(validatePollAction({ kind: 'changeSettings', params: { gameKind: 'table', id: 't1', settings: { 'table.bigBlind': 20 } } }, cfg({ type: 'yesno' })).ok).toBe(true);
    expect(validatePollAction({ kind: 'changeSettings', params: { gameKind: 'table', id: 't1', settings: {} } }, cfg({ type: 'yesno' }))).toEqual({ ok: false, issue: 'params' });
    expect(validatePollAction({ kind: 'changeSettings', params: { gameKind: 'table', id: 't1', settingKey: 'table.bigBlind' } }, cfg({ type: 'single', options: [{ id: 'a', label: '20', value: '20' }, { id: 'b', label: '40', value: '40' }] })).ok).toBe(true);
    expect(validatePollAction({ kind: 'pauseGame', params: { tournamentId: 'x' } }, cfg({ type: 'yesno' })).ok).toBe(true);
    expect(validatePollAction({ kind: 'pauseGame', params: { tournamentId: 'x' } }, cfg({ type: 'single', options: slots() }))).toEqual({ ok: false, issue: 'type' });
    expect(validatePollAction({ kind: 'endGame', params: { gameKind: 'cash', id: 'x' } }, cfg({ type: 'yesno' }))).toEqual({ ok: false, issue: 'params' });
    expect(validatePollAction({ kind: 'assignRole', params: { roleKey: 'kurator', userId: 'u1' } }, cfg({ type: 'yesno' })).ok).toBe(true);
    expect(validatePollAction({ kind: 'assignRole', params: { roleKey: 'kurator' } }, cfg({ type: 'yesno' }))).toEqual({ ok: false, issue: 'type' });
    expect(validatePollAction({ kind: 'assignRole', params: { roleKey: 'kurator' } }, cfg({ type: 'single', options: [{ id: 'a', label: 'Petr', value: 'u1' }, { id: 'b', label: 'Pavel', value: 'u2' }] })).ok).toBe(true);
    expect(validatePollAction({ kind: 'nesmysl' }, cfg({ type: 'yesno' }))).toEqual({ ok: false, issue: 'kind' });
    expect(validatePollAction({ kind: 'pauseGame', requireConfirm: false, params: { tournamentId: 'x' } }, cfg({ type: 'yesno' }))).toMatchObject({ ok: true, action: { requireConfirm: false } });
  });

  it('hodnota nastavení z textu', () => {
    expect(coerceSettingValue('20')).toBe(20);
    expect(coerceSettingValue('ano')).toBe(true);
    expect(coerceSettingValue('false')).toBe(false);
    expect(coerceSettingValue('noLimit')).toBe('noLimit');
  });
});
