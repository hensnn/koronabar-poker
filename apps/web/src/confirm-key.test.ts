import { describe, expect, it } from 'vitest';
import { isConfirmKey, isOfferKey, pickDefaultIndex } from './ui';

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
  it('a fold header, a custom control and anything activated from the keyboard keep their own Enter and Space', () => {
    expect(isConfirmKey(key('Enter', el('SUMMARY')))).toBe(false);
    expect(isConfirmKey(key(' ', el('SUMMARY')))).toBe(false);
    // a card or a table row one can activate (role or tabindex), also when the key lands on something inside it
    const inside = (selector: string) => el('SPAN', { closest: (q: string) => (q.includes(selector) ? {} : null) });
    for (const selector of ['[role="button"]', '[role="tab"]', '[role="switch"]', '[tabindex="0"]']) {
      expect(isConfirmKey(key('Enter', inside(selector))), selector).toBe(false);
      expect(isConfirmKey(key(' ', inside(selector))), selector).toBe(false);
    }
    // plain text in the window is not a control
    expect(isConfirmKey(key('Enter', el('P')))).toBe(true);
  });
  it('an input that is a button, or a colour picker, is not a text field', () => {
    for (const type of ['button', 'submit', 'reset', 'color', 'file']) expect(isConfirmKey(key('Enter', el('INPUT', { type })))).toBe(false);
    expect(isConfirmKey(key('Enter', el('INPUT', { type: 'text' })))).toBe(true);
    expect(isConfirmKey(key('Enter', el('INPUT', { type: 'date' })))).toBe(true);
  });
  it('pole ve formuláři se odešle samo; modifikátory a opakování se ignorují', () => {
    expect(isConfirmKey(key('Enter', el('INPUT', { type: 'text', closest: () => ({}) })))).toBe(false);
    expect(isConfirmKey(key('Enter', el('BODY'), { ctrlKey: true }))).toBe(false);
    expect(isConfirmKey(key('Enter', el('BODY'), { repeat: true }))).toBe(false);
    expect(isConfirmKey(key('x', el('BODY')))).toBe(false);
  });
});

describe('isOfferKey: answering an offer that lies over the table', () => {
  it('Enter and Space answer it from anywhere but a field', () => {
    expect(isOfferKey(key('Enter', el('BODY')))).toBe(true);
    expect(isOfferKey(key(' ', el('DIV')))).toBe(true);
    // Enter in the bet amount (or any other field) must not agree to a vote that is open at the same time
    expect(isOfferKey(key('Enter', el('INPUT', { type: 'number' })))).toBe(false);
    expect(isOfferKey(key('Enter', el('INPUT', { type: 'text' })))).toBe(false);
    expect(isOfferKey(key('Enter', el('TEXTAREA')))).toBe(false);
    // a focused button or seat answers by itself
    expect(isOfferKey(key('Enter', el('BUTTON')))).toBe(false);
    expect(isOfferKey(key(' ', el('DIV', { closest: (q: string) => (q.includes('[role="button"]') ? {} : null) })))).toBe(false);
    expect(isOfferKey(key('Enter', el('BODY'), { repeat: true }))).toBe(false);
  });
});

const b = (over: Partial<{ primary: boolean; danger: boolean; disabled: boolean }> = {}) => ({ primary: false, danger: false, disabled: false, ...over });

describe('výchozí akce okna (co potvrdí Enter nebo mezerník)', () => {
  it('první povolené hlavní tlačítko', () => {
    expect(pickDefaultIndex([b(), b({ primary: true }), b({ primary: true })])).toBe(1);
    expect(pickDefaultIndex([b({ primary: true, disabled: true }), b(), b({ primary: true })])).toBe(2);
    // the main button exists but is disabled (an empty required field): nothing is the default, least of all "Cancel"
    expect(pickDefaultIndex([b({ primary: true, disabled: true }), b()])).toBe(-1);
    expect(pickDefaultIndex([b(), b({ primary: true, disabled: true }), b({ danger: true })])).toBe(-1);
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
