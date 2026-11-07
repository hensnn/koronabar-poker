import { describe, expect, it } from 'vitest';
import { CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { randomLegalAction, seededRandom } from './bot.js';
import { FakeClock } from './clock.js';
import { TableActor } from './table-actor.js';

const reg = createDefaultRegistry();

/**
 * Plánovaný tah „Check / Fold“ se řídí údajem `legal.canCheck` (check, když jde, jinak fold). Když by údaj lhal (řekl „nejde“,
 * i když hráč nic nedoplácí), plán by hráče složil místo checku. Tady se `canCheck` srovnává s nezávisle spočtenou pravdou:
 * hráč smí checkovat právě tehdy, když na stole není vyšší sázka, než má on (před flopem aspoň big blind).
 */
function run(seed: number, over: Record<string, number | boolean | string>, players: number) {
  const rnd = seededRandom(seed);
  const clock = new FakeClock();
  const cash = new CashService(new Ledger());
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 5, 'cash.maxBuyInBb': 500, 'time.betweenHandsMs': 100, 'time.showdownMs': 100, 'time.potToWinnerMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'odds.enabled': false, ...over } as SettingValues;
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: seededRandom(seed + 1) });
  const bb = Number(settings['table.bigBlind']);
  for (let i = 0; i < players; i++) {
    cash.mint(`u${i}`, 1_000_000, `m${i}`);
    actor.join(`u${i}`, `U${i}`, i, bb * (5 + Math.floor(rnd() * 150)));
  }
  let checked = 0;
  let mismatches: string[] = [];
  for (let step = 0; step < 900; step++) {
    clock.advance(60);
    const v = actor.viewFor(null);
    if (actor.currentPhase() !== 'hand' || v.actingSeat === null) continue;
    const p = v.seats.find((s) => s.seat === v.actingSeat)!;
    const legal = actor.viewFor(p.playerId).legal;
    if (!legal) continue;
    const top = v.seats.reduce((m, s) => Math.max(m, s.bet), 0);
    const floor = v.street === 'PREFLOP' ? bb : 0;
    const truth = Math.max(floor, top) <= p.bet;
    if (truth !== legal.canCheck) mismatches.push(`seed ${seed} ${v.street} sedadlo ${p.seat}: sázka ${p.bet}, nejvyšší ${top}, canCheck ${legal.canCheck}, dorovnání ${legal.callAmount}`);
    if (legal.canCheck) {
      // plán „Check / Fold“ musí vyjít jako check a engine ho musí přijmout
      expect(() => actor.act(p.playerId, { type: 'check' })).not.toThrow();
      checked++;
      continue;
    }
    actor.act(p.playerId, randomLegalAction(legal, rnd));
  }
  return { checked, mismatches };
}

const VARIANTS: { name: string; over: Record<string, number | boolean | string> }[] = [
  { name: 'základní no-limit', over: {} },
  { name: 'ante', over: { 'table.ante': 2 } },
  { name: 'big blind ante', over: { 'table.bbAnte': true } },
  { name: 'povinný straddle', over: { 'table.straddleEnabled': true, 'table.straddleMandatory': true } },
  { name: 'dobrovolný straddle', over: { 'table.straddleEnabled': true, 'table.straddleMandatory': false } },
  { name: 'pot-limit', over: { 'table.bettingLimit': 'potLimit' } },
  { name: 'fixed-limit', over: { 'table.bettingLimit': 'fixedLimit' } },
];

describe('plán Check / Fold: „můžeš checkovat“ odpovídá skutečnosti', () => {
  for (const v of VARIANTS) {
    it(`${v.name}: canCheck je pravdivé a engine check přijme (náhodné ruce, 2 až 7 hráčů)`, () => {
      let checked = 0;
      const bad: string[] = [];
      for (let seed = 1; seed <= 12; seed++) {
        const r = run(seed, v.over, 2 + (seed % 6));
        checked += r.checked;
        bad.push(...r.mismatches);
      }
      expect(bad.slice(0, 5)).toEqual([]);
      expect(checked).toBeGreaterThan(20);
    });
  }
});
