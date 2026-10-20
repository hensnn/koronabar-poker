import { describe, expect, it } from 'vitest';
import { t } from '@kb/shared';
import { SECTIONS, searchGuide } from './guide-data';

describe('návod pro hráče', () => {
  it('všechny kapitoly a odstavce mají text a odstavce nejsou prázdné', () => {
    for (const s of SECTIONS) {
      expect(t(`guide.s.${s.id}.title`)).not.toBe(`guide.s.${s.id}.title`);
      for (let n = 1; n <= s.points; n++) {
        const text = t(`guide.s.${s.id}.${n}`);
        expect(text, `${s.id}.${n}`).not.toBe(`guide.s.${s.id}.${n}`);
        expect(text.length).toBeGreaterThan(20);
      }
      // žádný další odstavec navíc, který by se nezobrazil
      expect(t(`guide.s.${s.id}.${s.points + 1}`)).toBe(`guide.s.${s.id}.${s.points + 1}`);
    }
  });
  it('vyhledávání: bez diakritiky, v nadpisech i odstavcích, jen odpovídající odstavce', () => {
    expect(searchGuide('').map((c) => c.id)).toEqual(SECTIONS.map((s) => s.id));
    const r = searchGuide('straddle');
    expect(r.map((c) => c.id)).toContain('special');
    expect(r.find((c) => c.id === 'special')!.shown).toHaveLength(1);
    expect(searchGuide('SPECIALNI').find((c) => c.id === 'special')!.shown).toHaveLength(SECTIONS.find((s) => s.id === 'special')!.points); // nadpis sedí: celá kapitola
    expect(searchGuide('rebuy').find((c) => c.id === 'special')!.shown.join(' ')).toMatch(/add-on/);
    expect(searchGuide('qzxqzx')).toEqual([]);
  });
});
