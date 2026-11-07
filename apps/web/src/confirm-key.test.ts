import { describe, expect, it } from 'vitest';
import { isConfirmKey, pickDefaultIndex } from './ui';

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

const b = (over: Partial<{ primary: boolean; danger: boolean; disabled: boolean }> = {}) => ({ primary: false, danger: false, disabled: false, ...over });

describe('výchozí akce okna (co potvrdí Enter nebo mezerník)', () => {
  it('první povolené hlavní tlačítko', () => {
    expect(pickDefaultIndex([b(), b({ primary: true }), b({ primary: true })])).toBe(1);
    expect(pickDefaultIndex([b({ primary: true, disabled: true }), b(), b({ primary: true })])).toBe(2);
  });
  it('bez hlavního tlačítka jediné povolené tlačítko okna (např. Zavřít)', () => {
    expect(pickDefaultIndex([b()])).toBe(0);
    expect(pickDefaultIndex([b({ disabled: true }), b()])).toBe(1);
  });
  it('víc možností bez hlavní nic nevybere; nebezpečné tlačítko se nikdy nepotvrzuje samo', () => {
    expect(pickDefaultIndex([b(), b()])).toBe(-1);
    expect(pickDefaultIndex([b({ danger: true })])).toBe(-1);
    expect(pickDefaultIndex([b({ danger: true }), b({ disabled: true })])).toBe(-1);
    expect(pickDefaultIndex([])).toBe(-1);
  });
});
