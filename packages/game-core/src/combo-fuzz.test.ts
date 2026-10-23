// Kombinovaný fuzz: všechny speciální prvky, rake a jackpoty najednou ve všech sázkových limitech.
import { describe, it } from 'vitest';
import { run } from './fuzz-harness.js';
const SPECIAL = { 'special.runItTwice': true, 'special.runItTimes': 3, 'special.runItVoteSeconds': 4, 'special.sevenTwoBonus': true, 'special.sevenTwoAmountBb': 1, 'special.bombPot': true, 'special.bombPotEveryHands': 3, 'special.bombPotAnteBb': 1, 'special.rabbitHunt': true, 'special.showCards': true };
const RAKE = { 'rake.enabled': true, 'rake.percent': 8, 'rake.cap': 3, 'rake.jackpotPercent': 50, 'rake.rakebackPercent': 30, 'rake.timeChargeEnabled': true, 'rake.timeChargeMinutes': 1, 'rake.timeChargeAmount': 2, 'jackpot.royalFlushEnabled': true, 'jackpot.badBeatEnabled': true, 'jackpot.badBeatMinHand': 'quads', 'jackpot.highHandEnabled': true, 'jackpot.highHandMinutes': 1, 'jackpot.highHandPercent': 50 };
describe('kombinované fuzz', { timeout: 300_000 }, () => {
  for (const limit of ['noLimit', 'potLimit', 'fixedLimit']) {
    for (let seed = 200; seed < 203; seed++) {
      it(`${limit} seed ${seed} vše zapnuto`, () => {
        run(seed, { 'table.bettingLimit': limit, 'table.limitMaxBets': 3, 'table.ante': seed % 2, 'odds.enabled': seed % 3 === 0, 'time.turnSeconds': 3, 'time.timeBankSeconds': 5, 'time.timeoutsToSitOut': 2, 'cash.minBuyInBb': 5, ...SPECIAL, ...RAKE }, 1500);
      });
    }
  }
});
