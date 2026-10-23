// Průchod nastavením: každý parametr stolu se přepne na jinou hodnotu (krajní hodnoty, jiná volba, opačný přepínač)
// a krátká hra s nahodilými boty musí proběhnout bez chyby a se zachovanými žetony.
import { describe, it, expect } from 'vitest';
import { createDefaultRegistry, scopeAllowed, validateValues, type SettingDef, type SettingValue } from '@kb/shared';
import { run } from './fuzz-harness.js';

const reg = createDefaultRegistry();
const TABLE_CATEGORIES = new Set(['table', 'timing', 'cash', 'special', 'rake', 'jackpot', 'odds', 'economy']);

/** Hodnoty, na které se parametr přepne: opačný přepínač, každá jiná volba, krajní hodnoty čísla. */
function alternatives(d: SettingDef): SettingValue[] {
  switch (d.type) {
    case 'bool':
      return [!d.default];
    case 'enum':
      return d.options.filter((o) => o !== d.default);
    case 'int':
      return [...new Set([d.min, d.max].filter((v): v is number => typeof v === 'number' && v !== d.default))];
    default:
      return [];
  }
}

/** Nadřazené přepínače, které musí být zapnuté, aby parametr měl vůbec nějaký účinek. */
function enablers(d: SettingDef): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  let cur: SettingDef | undefined = d;
  while (cur?.dependsOn) {
    const parent = reg.get(cur.dependsOn.key);
    if (!parent) break;
    if ('truthy' in cur.dependsOn && cur.dependsOn.truthy) out[parent.key] = true;
    else if ('equals' in cur.dependsOn) out[parent.key] = cur.dependsOn.equals as SettingValue;
    cur = parent;
  }
  return out;
}

const keys = reg
  .all()
  .filter((d) => !d.secret && scopeAllowed(d.scopes, 'table') && TABLE_CATEGORIES.has(d.category) && d.appliesTo !== 'tournament' && !d.key.startsWith('tournament.'));

describe('průchod nastavením stolu', { timeout: 600_000 }, () => {
  it(`každý z ${keys.length} parametrů v jiné hodnotě: hra běží, žetony sedí`, () => {
    const failures: string[] = [];
    let tried = 0;
    for (const d of keys) {
      for (const value of alternatives(d)) {
        const over = { ...enablers(d), [d.key]: value } as Record<string, number | boolean | string>;
        // Nesmyslné kombinace (porušují pravidla mezi parametry) se přeskočí; ověřuje je validace nastavení.
        if (validateValues(reg, over).length > 0) continue;
        tried++;
        try {
          run(11, over, 120);
        } catch (e) {
          failures.push(`${d.key} = ${String(value)}: ${(e as Error).message.split('\n')[0]}`);
        }
      }
    }
    expect(tried).toBeGreaterThan(100);
    console.log(`SWEEP tried ${tried} changes of ${keys.length} settings`);
    expect(failures).toEqual([]);
  });
});
