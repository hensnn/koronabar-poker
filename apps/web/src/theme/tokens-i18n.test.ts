import { describe, expect, it } from 'vitest';
import { TOKEN_DEFS } from '@kb/tokens';
import { t } from '@kb/shared';

describe('názvy tokenů v češtině', () => {
  it('každý token, jeho kategorie a každá možnost výčtu mají český název', () => {
    const missing: string[] = [];
    for (const d of TOKEN_DEFS) {
      if (t(`token.${d.key}`) === `token.${d.key}`) missing.push(d.key);
      if (t(`token.category.${d.category}`) === `token.category.${d.category}`) missing.push(`category.${d.category}`);
      for (const o of d.options ?? []) if (t(`token.${d.key}.option.${o}`) === `token.${d.key}.option.${o}`) missing.push(`${d.key}.${o}`);
    }
    expect(missing).toEqual([]);
  });
});
