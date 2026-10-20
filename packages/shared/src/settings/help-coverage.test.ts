import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './definitions/index.js';
import { helpKey, labelKey, optionKey, t } from '../index.js';

describe('popisky nastavení', () => {
  const reg = createDefaultRegistry();
  it('každé nastavení má název a srozumitelnou nápovědu (aspoň věta, ne jen opakování názvu)', () => {
    const bad: string[] = [];
    for (const d of reg.all()) {
      const label = t(labelKey(d.key));
      const help = t(helpKey(d.key));
      if (label === labelKey(d.key)) bad.push(`${d.key}: chybí název`);
      else if (help === helpKey(d.key)) bad.push(`${d.key}: chybí nápověda`);
      else if (help.length < 30) bad.push(`${d.key}: nápověda je příliš krátká (${help.length} znaků)`);
      else if (help.trim().toLowerCase() === label.trim().toLowerCase()) bad.push(`${d.key}: nápověda jen opakuje název`);
    }
    expect(bad).toEqual([]);
  });
  it('každá možnost výběru má popisek', () => {
    const bad: string[] = [];
    for (const d of reg.all()) if (d.type === 'enum') for (const o of d.options) if (t(optionKey(d.key, o)) === optionKey(d.key, o)) bad.push(`${d.key}.${o}`);
    expect(bad).toEqual([]);
  });
});
