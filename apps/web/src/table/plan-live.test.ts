import { describe, expect, it } from 'vitest';
// Skutečný stůl a účetní kniha leží v jiných balíčcích než web; test je bere přímo ze zdrojů.
import { CashService, Ledger } from '../../../../packages/ledger/src/index';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { randomLegalAction, seededRandom } from '../../../../packages/game-core/src/bot';
import { FakeClock } from '../../../../packages/game-core/src/clock';
import { TableActor } from '../../../../packages/game-core/src/table-actor';
import type { PlayerAction, TableView } from '@kb/game-core';
import { planTarget, stepPlan, type PlanState } from './plan';

const reg = createDefaultRegistry();

/**
 * Celé hry se skutečným stolem: hráč u0 má pořád zvolený plán „Check / Fold“ a jeho plán se vyhodnocuje stejně jako v prohlížeči
 * (stepPlan na skutečném pohledu stolu). Plán smí složit jen tehdy, když hráč opravdu musí něco doplatit; když je check zadarmo, musí checkovat.
 */
function play(seed: number, over: Record<string, number | boolean | string> = {}) {
  const rnd = seededRandom(seed);
  const clock = new FakeClock();
  const cash = new CashService(new Ledger());
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 5, 'cash.maxBuyInBb': 500, 'time.betweenHandsMs': 100, 'time.showdownMs': 100, 'time.potToWinnerMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'odds.enabled': false, ...over } as SettingValues;
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: seededRandom(seed + 1) });
  const bb = Number(settings['table.bigBlind']);
  const n = 3 + (seed % 4);
  for (let i = 0; i < n; i++) {
    cash.mint(`u${i}`, 1_000_000, `m${i}`);
    actor.join(`u${i}`, `U${i}`, i, bb * 100);
  }
  const ME = 'u0';
  let plan = null as PlanState | null;
  let checks = 0;
  let folds = 0;
  const problems: string[] = [];
  for (let step = 0; step < 1500; step++) {
    clock.advance(60);
    const v = actor.viewFor(ME) as TableView;
    const publicView = actor.viewFor(null) as TableView;
    if (actor.currentPhase() === 'hand' && publicView.actingSeat !== null) {
      const acting = publicView.seats.find((s) => s.seat === publicView.actingSeat)!;
      if (acting.playerId === ME) {
        // Prohlížeč: pohled dorazí, plán se vyhodnotí a případně se pošle akce.
        if (!plan) plan = { plan: 'checkFold', tableId: 't', handId: v.handId, callAmount: 0 };
        const stepRes = stepPlan(plan, v, 't');
        if (stepRes.kind === 'bind') plan = { ...plan, handId: stepRes.handId };
        if (stepRes.kind === 'drop') plan = null;
        if (stepRes.kind === 'act') {
          plan = null;
          const legal = v.legal!;
          const action = stepRes.action as PlayerAction;
          if (action.type === 'check') checks++;
          else if (action.type === 'fold') {
            folds++;
            if (legal.canCheck || legal.callAmount === 0) problems.push(`seed ${seed}: plán složil, ač šlo zadarmo checkovat (${v.street})`);
          } else problems.push(`seed ${seed}: plán poslal neočekávanou akci ${action.type}`);
          actor.act(ME, action, v.handId ?? undefined);
          continue;
        }
        if (stepRes.kind === 'keep') {
          // mimo tah to nenastane; tady by hráč stejně musel odehrát sám
          actor.act(ME, randomLegalAction(v.legal!, rnd));
          continue;
        }
        // plán se zrušil (jiná handa): hráč hraje sám
        actor.act(ME, randomLegalAction(v.legal!, rnd));
        continue;
      }
      const legal = actor.viewFor(acting.playerId).legal;
      if (legal) actor.act(acting.playerId, randomLegalAction(legal, rnd));
    }
    // mimo můj tah se plán zvolí dopředu (jako klik na tlačítko), vázaný na právě rozehranou handu
    if (!plan) plan = { plan: 'checkFold', tableId: 't', handId: planTarget(v), callAmount: 0 };
    else if (plan.handId === null && planTarget(v) !== null) plan = { ...plan, handId: planTarget(v) };
  }
  return { checks, folds, problems };
}

describe('plán Check / Fold na skutečných hrách', () => {
  for (const [name, over] of [
    ['základní', {}],
    ['straddle a ante', { 'table.straddleEnabled': true, 'table.straddleMandatory': true, 'table.ante': 2 }],
    ['pot-limit', { 'table.bettingLimit': 'potLimit' }],
  ] as [string, Record<string, number | boolean | string>][]) {
    it(`${name}: skládá jen tehdy, když je co doplácet, jinak checkuje`, () => {
      let checks = 0;
      let folds = 0;
      const problems: string[] = [];
      for (let seed = 1; seed <= 10; seed++) {
        const r = play(seed, over);
        checks += r.checks;
        folds += r.folds;
        problems.push(...r.problems);
      }
      expect(problems.slice(0, 5)).toEqual([]);
      // oba případy se opravdu vyskytly, takže test něco dokazuje
      expect(checks).toBeGreaterThan(10);
      expect(folds).toBeGreaterThan(10);
    });
  }
});
