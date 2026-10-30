// Náhodné kombinace nastavení stolu pro závěrečný fuzz (z pevných semínek).
import { seededRandom } from './bot.js';

const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

export function combo(seed: number): Record<string, number | boolean | string> {
  const rnd = seededRandom(seed * 7919);
  const bb = pick(rnd, [2, 10, 20, 50]);
  const o: Record<string, number | boolean | string> = {
    'table.bigBlind': bb,
    'table.smallBlind': Math.max(1, Math.floor(bb / 2)),
    'table.bettingLimit': pick(rnd, ['noLimit', 'potLimit', 'fixedLimit'] as const),
    'table.limitMaxBets': pick(rnd, [3, 4]),
    'table.ante': pick(rnd, [0, 0, 1, 2]),
    'table.bbAnte': rnd() < 0.3,
    'table.deadButton': rnd() < 0.5,
    'table.straddleEnabled': rnd() < 0.4,
    'table.straddleMandatory': rnd() < 0.2,
    'time.turnSeconds': pick(rnd, [3, 5, 15]),
    'time.timeBankSeconds': pick(rnd, [0, 5]),
    'time.timeoutsToSitOut': pick(rnd, [1, 2, 3]),
    'cash.minBuyInBb': pick(rnd, [5, 10, 20]),
    'special.runItTwice': rnd() < 0.5,
    'special.runItTimes': pick(rnd, [2, 3]),
    'special.runItVoteSeconds': 4,
    'special.sevenTwoBonus': rnd() < 0.3,
    'special.sevenTwoAmountBb': 1,
    'special.bombPot': rnd() < 0.3,
    'special.bombPotEveryHands': 3,
    'special.bombPotAnteBb': 1,
    'special.rabbitHunt': rnd() < 0.5,
    'special.showCards': rnd() < 0.5,
    'rake.enabled': rnd() < 0.6,
    'rake.percent': pick(rnd, [3, 5, 8]),
    'rake.cap': pick(rnd, [0, 3, 10]),
    'rake.jackpotPercent': pick(rnd, [0, 30, 50]),
    'rake.rakebackPercent': pick(rnd, [0, 20]),
    'jackpot.royalFlushEnabled': rnd() < 0.4,
    'jackpot.badBeatEnabled': rnd() < 0.4,
    'jackpot.badBeatMinHand': 'quads',
    'odds.enabled': rnd() < 0.3,
  };
  return o;
}
