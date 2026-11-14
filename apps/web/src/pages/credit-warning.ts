/** The player's overdraft as the server sends it (`/api/wallet/credit`). */
export interface CreditInfo {
  enabled: boolean;
  autoRepay?: boolean;
  limit: number;
  debt: number;
  available: number;
}

export interface CreditWarning {
  /** What the player owes right now (always above zero). */
  debt: number;
  /**
   * `left`: the overdraft is on and something is still left within the limit.
   * `exhausted`: the overdraft is on, but the limit is used up (or exceeded): nothing more can be drawn.
   * `off`: the overdraft is switched off; the debt stays until it is repaid.
   */
  state: 'left' | 'exhausted' | 'off';
  limit: number;
  available: number;
  /** The debt is repaid by itself from every income (the default); otherwise the player repays it in the wallet. */
  autoRepay: boolean;
}

/** What the lobby shows about the overdraft: nothing unless the player owes something. */
export function creditWarning(c: CreditInfo | null | undefined): CreditWarning | null {
  if (!c || !Number.isFinite(c.debt) || c.debt <= 0) return null;
  const state = !c.enabled ? 'off' : c.available > 0 ? 'left' : 'exhausted';
  return { debt: c.debt, state, limit: c.limit, available: Math.max(0, c.available), autoRepay: c.autoRepay !== false };
}
