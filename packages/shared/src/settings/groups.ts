/** Podskupiny uvnitř kategorie Speciální prvky, aby byl dlouhý seznam přehledný. Pořadí odpovídá pořadí v seznamu. */
export const SPECIAL_GROUPS = ['runIt', 'rabbit', 'showdown', 'sevenTwo', 'bombPot', 'highHand', 'royalFlush', 'badBeat', 'rebuy', 'addon', 'reentry', 'bounty', 'headBounty', 'deal', 'bets'] as const;
export type SpecialGroup = (typeof SPECIAL_GROUPS)[number];

/** Do které podskupiny patří nastavení z kategorie Speciální prvky (jinde žádné podskupiny nejsou). */
export function groupOf(key: string, category: string): SpecialGroup | null {
  if (category !== 'special') return null;
  const rules: [RegExp, SpecialGroup][] = [
    [/^special\.runIt/, 'runIt'],
    [/^special\.rabbit/, 'rabbit'],
    [/^special\.(muckAllowed|showCards)$/, 'showdown'],
    [/^special\.sevenTwo/, 'sevenTwo'],
    [/^special\.bombPot/, 'bombPot'],
    [/^jackpot\.highHand/, 'highHand'],
    [/^jackpot\.royalFlush/, 'royalFlush'],
    [/^jackpot\.badBeat/, 'badBeat'],
    [/^tournament\.rebuy/, 'rebuy'],
    [/^tournament\.addon/, 'addon'],
    [/^tournament\.reentry/, 'reentry'],
    [/^tournament\.(bounty|pkoCash|mystery)/, 'bounty'],
    [/^(tournament\.headBounty|headBounty\.)/, 'headBounty'],
    [/^tournament\.deal/, 'deal'],
    [/^bets\./, 'bets'],
  ];
  return rules.find(([re]) => re.test(key))?.[1] ?? null;
}
