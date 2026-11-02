import { describe, expect, it } from 'vitest';
import { t } from '../i18n/cs.js';
import { createDefaultRegistry } from './definitions/index.js';
import { panelGroupIds, panelGroupOf, SECTIONS, SUBGROUP_RULES, sectionOf } from './sections.js';

const reg = createDefaultRegistry();

describe('oddíly a podskupiny formuláře nastavení', () => {
  it('každá kategorie patří do právě jednoho oddílu a oddíly mají české názvy', () => {
    const all = SECTIONS.flatMap((s) => s.categories as readonly string[]);
    expect(new Set(all).size).toBe(all.length);
    for (const c of reg.categories()) expect(sectionOf(c), `kategorie ${c} chybí v oddílech (packages/shared/src/settings/sections.ts)`).not.toBe('other');
    for (const c of all) expect(reg.categories(), `oddíl obsahuje neexistující kategorii ${c}`).toContain(c);
    for (const s of SECTIONS) expect(t(`settings.section.${s.id}`)).not.toBe(`settings.section.${s.id}`);
  });

  it('podskupiny mají české názvy, žádné pravidlo není mrtvé a každá položka velké kategorie má své místo', () => {
    for (const [cat, rules] of Object.entries(SUBGROUP_RULES)) {
      const keys = reg.all().filter((d) => d.category === cat).map((d) => d.key);
      expect(keys.length, `kategorie ${cat} v pravidlech neexistuje`).toBeGreaterThan(0);
      for (const [id, re] of rules) {
        expect(keys.some((k) => re.test(k)), `pravidlo ${id} nic nezachytí`).toBe(true);
        expect(t(`settings.group.${id}`)).not.toBe(`settings.group.${id}`);
      }
    }
    expect(t('settings.group.other')).not.toBe('settings.group.other');
    for (const d of reg.all()) {
      const g = panelGroupOf(d.key, d.category);
      if (g === null) expect(panelGroupIds(d.category), d.key).toEqual([]);
      else {
        expect(panelGroupIds(d.category), d.key).toContain(g);
        expect(g, `${d.key} nemá podskupinu (doplň pravidlo v sections.ts)`).not.toBe('other');
      }
    }
  });
});
