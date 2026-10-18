import { useSettings } from './settings';

/**
 * Funkce, které správce může vypnout v globálním nastavení. Každé místo v aplikaci, které k nim vede
 * (nabídka, tlačítko u stolu, karta na úvodní stránce, widget), se podle toho schová.
 * Server vypnutou funkci odmítá vždy sám; tohle jen skrývá, co by hráč zbytečně hledal.
 */
export interface Features {
  polls: boolean;
  chat: boolean;
  shop: boolean;
  xp: boolean;
  rating: boolean;
  bets: boolean;
  headBounty: boolean;
  evenings: boolean;
  liveCash: boolean;
  shareHands: boolean;
  limits: boolean;
  assistant: boolean;
}

type Values = Record<string, unknown>;
const on = (v: Values, key: string) => v[key] !== false;

export function featuresOf(v: Values): Features {
  return {
    polls: on(v, 'poll.enabled'),
    chat: on(v, 'chat.enabled'),
    shop: on(v, 'cosmetics.enabled') && on(v, 'cosmetics.shopEnabled'),
    xp: on(v, 'xp.enabled'),
    rating: on(v, 'rating.enabled'),
    bets: on(v, 'bets.enabled'),
    headBounty: on(v, 'headBounty.enabled'),
    evenings: on(v, 'evening.enabled'),
    // Živý cash je ve výchozím stavu schovaný
    liveCash: v['liveCash.enabled'] === true,
    shareHands: on(v, 'hands.shareEnabled'),
    limits: on(v, 'limits.enabled'),
    assistant: on(v, 'assistant.enabled'),
  };
}

export function useFeatures(): Features {
  return featuresOf(useSettings().values);
}
