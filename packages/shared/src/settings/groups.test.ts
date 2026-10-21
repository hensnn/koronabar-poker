import { describe, expect, it } from 'vitest';
import { t } from '../i18n/cs.js';
import { groupOf, SPECIAL_GROUPS } from './groups.js';
import { createDefaultRegistry } from './definitions/index.js';

describe('podskupiny speciálních prvků', () => {
  it('každé nastavení ze Speciálních prvků má podskupinu s českým názvem a jinde podskupiny nejsou', () => {
    const reg = createDefaultRegistry();
    for (const d of reg.all()) {
      const g = groupOf(d.key, d.category);
      if (d.category === 'special') {
        expect(g, d.key).not.toBeNull();
        expect(t(`settings.group.${g}`)).not.toBe(`settings.group.${g}`);
      } else expect(g).toBeNull();
    }
    expect(new Set(SPECIAL_GROUPS).size).toBe(SPECIAL_GROUPS.length);
  });
});
