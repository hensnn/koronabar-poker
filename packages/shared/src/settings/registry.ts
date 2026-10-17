import { z } from 'zod';
import type { SettingDef, SettingValues } from './types.js';

export interface CrossRule {
  id: string;
  /** Klíče polí, u kterých se chyba zobrazí. */
  keys: string[];
  /** Vrací true, pokud je kombinace v pořádku. */
  check: (v: SettingValues) => boolean;
  /** Překladový klíč chybové hlášky. */
  messageKey: string;
}

export class SettingsRegistry {
  private defs = new Map<string, SettingDef>();
  private rules: CrossRule[] = [];

  register(...defs: SettingDef[]): this {
    for (const d of defs) {
      if (this.defs.has(d.key)) throw new Error(`Duplicitní klíč nastavení: ${d.key}`);
      this.defs.set(d.key, d);
    }
    return this;
  }
  addRule(...rules: CrossRule[]): this {
    this.rules.push(...rules);
    return this;
  }
  get(key: string): SettingDef | undefined {
    return this.defs.get(key);
  }
  all(): SettingDef[] {
    return [...this.defs.values()];
  }
  crossRules(): readonly CrossRule[] {
    return this.rules;
  }
  categories(): string[] {
    return [...new Set(this.all().map((d) => d.category))];
  }
  defaults(): SettingValues {
    return Object.fromEntries(this.all().map((d) => [d.key, d.default]));
  }
  /** Zod schéma jedné hodnoty, odvozené z definice. */
  schemaFor(def: SettingDef): z.ZodTypeAny {
    switch (def.type) {
      case 'int': {
        const s = z.number().int().min(def.min).max(def.max);
        const step = def.step;
        if (step && step > 1) return s.refine((n) => (n - def.min) % step === 0);
        return s;
      }
      case 'bool':
        return z.boolean();
      case 'enum':
        return z.enum(def.options as [string, ...string[]]);
      case 'string':
        return z.string().max(def.maxLength ?? 200);
      case 'color':
        return z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
    }
  }
  /** Zod schéma částečného objektu hodnot, neznámé klíče odmítne. */
  partialSchema(): z.ZodTypeAny {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const d of this.all()) shape[d.key] = this.schemaFor(d).optional();
    return z.object(shape).strict();
  }
}
