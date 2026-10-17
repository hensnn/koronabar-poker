import type { SettingsRegistry } from './registry.js';
import type { SettingValues } from './types.js';

export interface ValidationIssue {
  keys: string[];
  /** Překladový klíč hlášky + parametry. */
  messageKey: string;
  params?: Record<string, unknown>;
}

/** Validuje hodnoty podle schématu a vzájemné konzistence. */
export function validateValues(
  reg: SettingsRegistry,
  values: Partial<SettingValues>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [key, val] of Object.entries(values)) {
    const def = reg.get(key);
    if (!def) {
      issues.push({ keys: [key], messageKey: 'validation.unknownKey', params: { key } });
      continue;
    }
    const r = reg.schemaFor(def).safeParse(val);
    if (!r.success) {
      const params: Record<string, unknown> = { key };
      if (def.type === 'int') Object.assign(params, { min: def.min, max: def.max, step: def.step });
      issues.push({ keys: [key], messageKey: `validation.invalid.${def.type}`, params });
    }
  }
  if (issues.length) return issues;
  const full = { ...reg.defaults(), ...values } as SettingValues;
  for (const rule of reg.crossRules()) {
    if (!rule.check(full)) issues.push({ keys: rule.keys, messageKey: rule.messageKey });
  }
  return issues;
}
