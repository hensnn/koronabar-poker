import type { SettingValues, SettingsRegistry } from '@kb/shared';
import type { GameModule, HookName, ModuleContext, ModuleHooks } from './types.js';

export interface ModuleErrorInfo {
  moduleId: string;
  hook: HookName;
  error: unknown;
}

type HookArgs<K extends HookName> = Parameters<NonNullable<ModuleHooks[K]>> extends [unknown, ...infer R] ? R : never;
type HookResult<K extends HookName> = ReturnType<NonNullable<ModuleHooks[K]>>;

/**
 * Spouští háčky modulů v pevném pořadí (priorita, pak id). Chyba v modulu nezastaví stůl:
 * modul se pro tento stůl vypne a chyba se nahlásí.
 */
export class ModulePipeline {
  private modules: GameModule[];
  private disabled = new Set<string>();

  constructor(
    modules: GameModule[],
    private onError: (e: ModuleErrorInfo) => void = () => undefined,
  ) {
    const ids = new Set<string>();
    for (const m of modules) {
      if (ids.has(m.id)) throw new Error(`Duplicitní modul: ${m.id}`);
      ids.add(m.id);
    }
    for (const m of modules) {
      for (const d of m.dependsOn ?? []) if (!ids.has(d)) throw new Error(`Modul ${m.id} vyžaduje modul ${d}`);
    }
    this.modules = [...modules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  /** Kontrola proti centrálnímu schématu: každý klíč nastavení modulu musí existovat. */
  validate(registry: SettingsRegistry): string[] {
    const problems: string[] = [];
    for (const m of this.modules) for (const k of m.settingKeys) if (!registry.get(k)) problems.push(`${m.id}: neznámý klíč nastavení ${k}`);
    return problems;
  }

  list(): readonly GameModule[] {
    return this.modules;
  }
  isDisabled(id: string): boolean {
    return this.disabled.has(id);
  }
  enabled(settings: SettingValues): GameModule[] {
    return this.modules.filter((m) => !this.disabled.has(m.id) && m.isEnabled(settings));
  }

  /** Spustí háček u všech aktivních modulů a vrátí výsledky. */
  run<K extends HookName>(hook: K, ctx: ModuleContext, ...args: HookArgs<K>): HookResult<K>[] {
    const results: HookResult<K>[] = [];
    for (const m of this.enabled(ctx.settings)) {
      const fn = m.hooks[hook] as ((c: ModuleContext, ...a: unknown[]) => unknown) | undefined;
      if (!fn) continue;
      try {
        results.push(fn.call(m.hooks, ctx, ...(args as unknown[])) as HookResult<K>);
      } catch (error) {
        this.disabled.add(m.id);
        this.onError({ moduleId: m.id, hook, error });
      }
    }
    return results;
  }
}
