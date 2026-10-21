import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './definitions/index.js';
import { validateValues } from './validate.js';

/** Kontrola celého schématu nastavení: výchozí hodnoty spolu fungují, závislosti míří na existující klíče a pravidla konzistence jdou splnit. */
describe('audit nastavení', () => {
  const reg = createDefaultRegistry();
  it('výchozí hodnoty všech parametrů projdou kontrolou včetně pravidel konzistence', () => {
    expect(validateValues(reg, reg.defaults())).toEqual([]);
  });
  it('každá závislost míří na existující parametr stejného nebo širšího rozsahu', () => {
    for (const d of reg.all()) {
      const dep = (d as { dependsOn?: { key: string } }).dependsOn;
      if (!dep) continue;
      const target = reg.get(dep.key);
      expect(target, `${d.key} závisí na neexistujícím ${dep.key}`).toBeDefined();
    }
  });
  it('asistent: celkový strop otázky a denní limity se hlídají', () => {
    const bad = { ...reg.defaults(), 'assistant.timeoutSeconds': 120, 'assistant.totalTimeoutSeconds': 60 };
    expect(validateValues(reg, bad).some((i) => i.messageKey === 'rule.assistantTimeouts')).toBe(true);
    const bad2 = { ...reg.defaults(), 'assistant.perUserDaily': 600, 'assistant.globalDaily': 500 };
    expect(validateValues(reg, bad2).some((i) => i.messageKey === 'rule.assistantLimits')).toBe(true);
    expect(validateValues(reg, { ...reg.defaults(), 'assistant.globalDaily': 0 })).toEqual([]);
  });
  it('mezní hodnoty: výchozí číslo leží v rozsahu a výčet má platnou výchozí volbu', () => {
    for (const d of reg.all()) {
      const def = d as { type: string; min?: number; max?: number; options?: readonly string[]; default: unknown };
      if (def.type === 'int' && typeof def.default === 'number') {
        expect(def.default, d.key).toBeGreaterThanOrEqual(def.min ?? -Infinity);
        expect(def.default, d.key).toBeLessThanOrEqual(def.max ?? Infinity);
      }
      if (def.type === 'enum' && def.options) expect(def.options, d.key).toContain(def.default as string);
    }
  });
});
