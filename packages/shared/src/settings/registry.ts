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
  /** Odvozené hodnoty se počítají jen jednou; každá registrace je zahodí. */
  private allCache: readonly SettingDef[] | null = null;
  private defaultsCache: Readonly<SettingValues> | null = null;
  private partialSchemaCache: z.ZodTypeAny | null = null;

  register(...defs: SettingDef[]): this {
    for (const d of defs) {
      if (this.defs.has(d.key)) throw new Error(`Duplicitní klíč nastavení: ${d.key}`);
      // Herní parametr (cash/turnaj/živá hra) bez vlastních rozsahů: globální formulář ho nenabízí (viz `globalHidden`).
      this.defs.set(d.key, d.scopes === undefined && d.appliesTo && d.appliesTo !== 'all' && d.globalHidden === undefined ? { ...d, globalHidden: true } : d);
    }
    this.allCache = null;
    this.defaultsCache = null;
    this.partialSchemaCache = null;
    return this;
  }
  addRule(...rules: CrossRule[]): this {
    this.rules.push(...rules);
    return this;
  }
  get(key: string): SettingDef | undefined {
    return this.defs.get(key);
  }
  /** Všechny definice v pořadí registrace. Vrací se sdílené (zmrazené) pole, nekopíruje se. */
  all(): readonly SettingDef[] {
    if (!this.allCache) this.allCache = Object.freeze([...this.defs.values()]);
    return this.allCache;
  }
  crossRules(): readonly CrossRule[] {
    return this.rules;
  }
  categories(): string[] {
    return [...new Set(this.all().map((d) => d.category))];
  }
  /** Výchozí hodnoty všech parametrů. Sdílený zmrazený objekt; kdo chce měnit, udělá si kopii (`{ ...reg.defaults() }`). */
  defaults(): Readonly<SettingValues> {
    if (!this.defaultsCache) this.defaultsCache = Object.freeze(Object.fromEntries(this.all().map((d) => [d.key, d.default])));
    return this.defaultsCache;
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
    if (!this.partialSchemaCache) {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const d of this.all()) shape[d.key] = this.schemaFor(d).optional();
      this.partialSchemaCache = z.object(shape).strict();
    }
    return this.partialSchemaCache;
  }
}
