import { describe, expect, it } from 'vitest';
import { isConfirmKey } from './ui';

const key = (k: string, target: Partial<HTMLElement> & { type?: string } | null, over: Partial<KeyboardEvent> = {}) => ({ key: k, target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...over }) as unknown as KeyboardEvent;
const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, closest: () => null, ...extra }) as unknown as HTMLElement;

describe('isConfirmKey', () => {
  it('Enter a mezerník mimo pole potvrzují', () => {
    expect(isConfirmKey(key('Enter', el('BODY')))).toBe(true);
    expect(isConfirmKey(key(' ', el('DIV')))).toBe(true);
  });
  it('tlačítko, odkaz, výběr a víceřádkové pole mají vlastní chování', () => {
    for (const tag of ['BUTTON', 'A', 'SELECT', 'TEXTAREA']) expect(isConfirmKey(key('Enter', el(tag)))).toBe(false);
  });
  it('v číselném poli potvrdí Enter, ale ne mezerník; posuvník a zaškrtávátko ne', () => {
    expect(isConfirmKey(key('Enter', el('INPUT', { type: 'number' })))).toBe(true);
    expect(isConfirmKey(key(' ', el('INPUT', { type: 'number' })))).toBe(false);
    expect(isConfirmKey(key('Enter', el('INPUT', { type: 'range' })))).toBe(false);
    expect(isConfirmKey(key('Enter', el('INPUT', { type: 'checkbox' })))).toBe(false);
  });
  it('pole ve formuláři se odešle samo; modifikátory a opakování se ignorují', () => {
    expect(isConfirmKey(key('Enter', el('INPUT', { type: 'text', closest: () => ({}) })))).toBe(false);
    expect(isConfirmKey(key('Enter', el('BODY'), { ctrlKey: true }))).toBe(false);
    expect(isConfirmKey(key('Enter', el('BODY'), { repeat: true }))).toBe(false);
    expect(isConfirmKey(key('x', el('BODY')))).toBe(false);
  });
});
