import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './definitions/index.js';
import { keysOfSet, SETTING_SETS } from './sets.js';

const reg = createDefaultRegistry();

describe('sady osobního nastavení', () => {
  it('každý osobní parametr patří do aspoň jedné sady (nic nezůstane bez správy)', () => {
    const personal = reg.all().filter((d) => d.scopes?.includes('user') && !d.secret).map((d) => d.key);
    const covered = new Set(SETTING_SETS.flatMap((s) => keysOfSet(reg, s.id)));
    expect(personal.filter((k) => !covered.has(k))).toEqual([]);
  });
  it('sady pro počítač a telefon se liší jen mobilními volbami; ostatní sady se nepřekrývají', () => {
    const desk = keysOfSet(reg, 'tableDesktop');
    const phone = keysOfSet(reg, 'tablePhone');
    expect(phone.filter((k) => !desk.includes(k)).every((k) => k.startsWith('ui.mobile'))).toBe(true);
    expect(desk.every((k) => phone.includes(k))).toBe(true);
    const others = ['sounds', 'look', 'notify'].flatMap((id) => keysOfSet(reg, id));
    expect(new Set(others).size).toBe(others.length);
    expect(others.some((k) => phone.includes(k))).toBe(false);
  });
});
