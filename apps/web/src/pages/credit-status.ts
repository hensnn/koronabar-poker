/** The player's overdraft as the server sends it (`/api/wallet/credit`). */
export interface CreditInfo {
  enabled: boolean;
  autoRepay?: boolean;
  limit: number;
  debt: number;
  available: number;
}

export interface CreditStatus {
  /** What the player owes right now (0 = nothing is drawn). */
  debt: number;
  /**
   * Nothing drawn:
   * `unused`: the overdraft is on and the player has a limit; the whole limit is free.
   * `none`: the overdraft is on, but this player's limit is zero.
   * Something drawn (shown as a warning):
   * `left`: something is still left within the limit.
   * `exhausted`: the limit is used up (or exceeded): nothing more can be drawn.
   * `off`: the overdraft is switched off; the debt stays until it is repaid.
   */
  state: 'unused' | 'none' | 'left' | 'exhausted' | 'off';
  limit: number;
  available: number;
  /** The debt is repaid by itself from every income (the default); otherwise the player repays it in the wallet. */
  autoRepay: boolean;
}

/**
 * What the lobby shows about the overdraft. Every player sees their limit, even when nothing is drawn; a debt turns it
 * into a warning. Nothing is shown only when the overdraft is switched off for everybody and the player owes nothing.
 */
export function creditStatus(c: CreditInfo | null | undefined): CreditStatus | null {
  if (!c) return null;
  const debt = Number.isFinite(c.debt) && c.debt > 0 ? c.debt : 0;
  if (debt === 0 && !c.enabled) return null;
  const limit = Math.max(0, c.limit);
  const available = Math.max(0, c.available);
  const state = debt === 0 ? (limit > 0 ? 'unused' : 'none') : !c.enabled ? 'off' : available > 0 ? 'left' : 'exhausted';
  return { debt, state, limit, available, autoRepay: c.autoRepay !== false };
}
