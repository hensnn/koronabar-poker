/** Skupiny pohybů v historii peněženky (filtr): každý druh pohybu patří do právě jedné skupiny. */
export const WALLET_GROUPS = ['cash', 'tournament', 'bounty', 'bets', 'topup', 'credit', 'transfer', 'shop', 'other'] as const;
export type WalletGroup = (typeof WALLET_GROUPS)[number];

const BY_PREFIX: [RegExp, WalletGroup][] = [
  [/^(cash_|rake$|rakeback$|jackpot_|time_charge$)/, 'cash'],
  [/^turnaj_/, 'tournament'],
  [/^(bounty$|head_bounty_)/, 'bounty'],
  [/^bet_/, 'bets'],
  [/^(mint$|manual_adjustment$)/, 'topup'],
  [/^credit_/, 'credit'],
  [/^transfer_/, 'transfer'],
  [/^shop_/, 'shop'],
];

/** Skupina druhu pohybu; neznámý druh spadne do „Ostatní“. */
export function walletGroupOf(kind: string): WalletGroup {
  return BY_PREFIX.find(([re]) => re.test(kind))?.[1] ?? 'other';
}
