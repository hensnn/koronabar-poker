import type { SettingsRegistry } from './registry.js';

export interface ChangeContext {
  /** Hra už běží (platí pro `beforeStart`). */
  gameStarted: boolean;
  handInProgress: boolean;
  isAdmin: boolean;
}

/**
 * apply   – změnu lze provést hned,
 * pending – zařadit do fronty a použít od příští handy,
 * denied  – nelze (důvod = překladový klíč).
 */
export type ChangeDecision =
  | { result: 'apply' }
  | { result: 'pending' }
  | { result: 'denied'; reasonKey: string };

export function decideChange(
  reg: SettingsRegistry,
  key: string,
  ctx: ChangeContext,
): ChangeDecision {
  const def = reg.get(key);
  if (!def) return { result: 'denied', reasonKey: 'validation.unknownKey' };
  switch (def.mutability) {
    case 'anytime':
      return { result: 'apply' };
    case 'betweenHands':
      return ctx.handInProgress ? { result: 'pending' } : { result: 'apply' };
    case 'beforeStart':
      return ctx.gameStarted
        ? { result: 'denied', reasonKey: 'change.denied.afterStart' }
        : { result: 'apply' };
    case 'adminOnly':
      return ctx.isAdmin
        ? { result: 'apply' }
        : { result: 'denied', reasonKey: 'change.denied.adminOnly' };
  }
}
