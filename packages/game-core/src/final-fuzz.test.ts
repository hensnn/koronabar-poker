// Závěrečný fuzz: náhodné kombinace nastavení stolu (limity, blindy, ante, straddle, živé/mrtvé tlačítko, speciální prvky, rake) z pevných semínek.
import { describe, it } from 'vitest';
import { combo } from './final-fuzz-combo.js';
import { run } from './fuzz-harness.js';

describe('závěrečný fuzz: náhodné kombinace nastavení (žetony nevznikají ani nemizí)', { timeout: 900_000 }, () => {
  for (let seed = 1; seed <= Number(process.env.FUZZ_N ?? 40); seed++) {
    it(`kombinace č. ${seed}`, () => {
      run(1000 + seed, combo(seed), 1200);
    });
  }
});

// Regrese: big blind ante spolu s run it twice dřív počítal mrtvé peníze dvakrát (žetony vznikaly).
describe('regrese: big blind ante + run it twice', { timeout: 300_000 }, () => {
  for (let seed = 1; seed <= 8; seed++) {
    it(`semínko ${seed}`, () => {
      run(3000 + seed, { 'table.bbAnte': true, 'special.runItTwice': true, 'special.runItVoteSeconds': 4, 'time.turnSeconds': 3, 'cash.minBuyInBb': 10 }, 1200);
    });
  }
});
