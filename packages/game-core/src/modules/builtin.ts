import type { SettingValues } from '@kb/shared';
import type { GameModule } from './types.js';

const num = (s: SettingValues, k: string) => Number(s[k]);

/** Běžné ante řeší přímo engine; modul jen eviduje, že je funkce aktivní. */
export const anteModule: GameModule = {
  id: 'ante',
  titleKey: 'module.ante',
  priority: 10,
  settingKeys: ['table.ante', 'table.bbAnte'],
  isEnabled: (s) => num(s, 'table.ante') > 0 && !s['table.bbAnte'],
  hooks: {},
};

/** Big blind ante: celé ante za stůl platí hráč na big blindu jako mrtvé peníze. */
export const bbAnteModule: GameModule = {
  id: 'bbAnte',
  titleKey: 'module.bbAnte',
  priority: 20,
  settingKeys: ['table.bbAnte', 'table.ante', 'table.bigBlind'],
  isEnabled: (s) => !!s['table.bbAnte'],
  hooks: {
    beforeDeal(ctx, plan) {
      const amount = num(ctx.settings, 'table.ante') || num(ctx.settings, 'table.bigBlind');
      (plan.deadMoney ??= []).push({ payer: 'bb', amount });
    },
  },
};

/** Straddle (UTG nebo Mississippi), povinný nebo dobrovolný. */
export const straddleModule: GameModule = {
  id: 'straddle',
  titleKey: 'module.straddle',
  priority: 30,
  settingKeys: ['table.straddleEnabled', 'table.straddleType', 'table.straddleMultiplier', 'table.straddleMandatory', 'table.bigBlind'],
  isEnabled: (s) => !!s['table.straddleEnabled'],
  hooks: {
    beforeDeal(ctx, plan) {
      const s = ctx.settings;
      plan.straddle = {
        type: s['table.straddleType'] === 'mississippi' ? 'mississippi' : 'utg',
        amount: num(s, 'table.straddleMultiplier') * num(s, 'table.bigBlind'),
        optInPlayerIds: s['table.straddleMandatory'] ? undefined : ctx.seats.filter((x) => x.wantsStraddle).map((x) => x.userId),
      };
    },
  },
};

/** Pravidlo pro nové hráče: počkat na big blind, nebo zaplatit dead blind. */
export const newPlayerModule: GameModule = {
  id: 'newPlayer',
  titleKey: 'module.newPlayer',
  priority: 40,
  settingKeys: ['table.newPlayerRule', 'table.deadBlindBb', 'table.bigBlind'],
  isEnabled: () => true,
  hooks: {
    seatOptions(ctx, seat) {
      if (seat.fresh && ctx.settings['table.newPlayerRule'] === 'waitForBb') return { waitForBb: true };
    },
    beforeDeal(ctx, plan) {
      if (ctx.settings['table.newPlayerRule'] !== 'postDeadBlind') return;
      const amount = num(ctx.settings, 'table.deadBlindBb') * num(ctx.settings, 'table.bigBlind');
      for (const seat of ctx.seats) if (seat.fresh) (plan.deadMoney ??= []).push({ payer: { playerId: seat.userId }, amount });
    },
  },
};

/**
 * Bomb pot: každou N-tou handu dá každý hráč ante a hraje se rovnou od flopu. Nabídne se jen, když mají
 * všichni dost žetonů na ante a blindy; jinak se hraje běžná handa.
 */
export const bombPotModule: GameModule = {
  id: 'bombPot',
  titleKey: 'module.bombPot',
  priority: 50,
  settingKeys: ['special.bombPot', 'special.bombPotEveryHands', 'special.bombPotAnteBb', 'table.bigBlind'],
  isEnabled: (s) => !!s['special.bombPot'],
  hooks: {
    beforeDeal(ctx, plan) {
      const every = num(ctx.settings, 'special.bombPotEveryHands');
      if ((ctx.handNumber + 1) % every !== 0) return;
      const bb = num(ctx.settings, 'table.bigBlind');
      const ante = num(ctx.settings, 'special.bombPotAnteBb') * bb;
      const players = ctx.seats.filter((x) => x.chips > 0);
      if (players.length < 2 || players.some((x) => x.chips < ante + 2 * bb)) return;
      for (const seat of players) (plan.deadMoney ??= []).push({ payer: { playerId: seat.userId }, amount: ante });
      plan.bombPot = true;
    },
  },
};

export const BUILTIN_MODULES: GameModule[] = [anteModule, bbAnteModule, straddleModule, newPlayerModule, bombPotModule];
