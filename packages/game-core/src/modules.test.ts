import { describe, it, expect } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { FakeClock } from './clock.js';
import { BUILTIN_MODULES, ModulePipeline, type GameModule } from './modules/index.js';
import { TableActor, type TableEvent } from './table-actor.js';
import { GameError } from './types.js';
import { randomLegalAction, seededRandom } from './bot.js';

const reg = createDefaultRegistry();
const USERS = ['a', 'b', 'c', 'd', 'e'];

function make(over: Record<string, number | boolean | string> = {}, modules?: GameModule[]) {
  const clock = new FakeClock();
  const ledger = new Ledger();
  const cash = new CashService(ledger);
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'odds.enabled': false, 'time.betweenHandsMs': 100, ...over } as SettingValues;
  const events: TableEvent[] = [];
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, modules, randomProvider: seededRandom(over.__seed as number ?? 77), onEvent: (e) => events.push(e) });
  for (const u of USERS) cash.mint(u, 100_000, `m-${u}`);
  const sit = (u: string, seat: number, amount = 1000) => actor.join(u, u.toUpperCase(), seat, amount);
  return { clock, ledger, cash, settings, actor, events, sit };
}
type M = ReturnType<typeof make>;
const next = (m: M) => m.clock.advance(Number(m.settings['time.betweenHandsMs']) + 1);
const view = (m: M, who: string | null = null) => m.actor.viewFor(who);
const actingId = (m: M) => {
  const v = view(m);
  return v.seats.find((s) => s.seat === v.actingSeat)?.playerId;
};
const fold = (m: M) => m.actor.act(actingId(m)!, { type: 'fold' });
function playOut(m: M, maxSteps = 40) {
  for (let i = 0; i < maxSteps && view(m).actingSeat !== null; i++) {
    const id = actingId(m)!;
    const legal = view(m, id).legal!;
    m.actor.act(id, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}
/** Dohraje handu a počká na další. */
const finishAndNext = (m: M) => {
  playOut(m);
  m.clock.advance(20_000);
};

describe('pravidlo pro nové hráče: čekání na big blind', () => {
  function started() {
    const m = make({ 'table.newPlayerRule': 'waitForBb' });
    for (const [i, u] of ['a', 'b', 'c'].entries()) m.sit(u, i);
    next(m);
    for (let i = 0; i < 2; i++) {
      playOut(m);
      m.clock.advance(20_000);
    }
    return m;
  }

  it('nováček je „čeká“ a dostane karty, až je na big blindu', () => {
    const m = started();
    m.sit('d', 3);
    expect(view(m, 'd').seats.find((s) => s.playerId === 'd')!.status).toBe('waiting');
    let dealt = -1;
    for (let hand = 0; hand < 16; hand++) {
      const v = view(m, 'd');
      const d = v.seats.find((s) => s.playerId === 'd')!;
      if (v.handId && d.cards) {
        dealt = hand;
        const bbSeat = v.seats.find((s) => s.bet === Number(m.settings['table.bigBlind']) && s.playerId === 'd');
        expect(bbSeat, 'nováček má hrát poprvé na big blindu').toBeDefined();
        break;
      }
      if (v.actingSeat !== null) {
        expect(d.status).toBe('waiting');
        expect(d.cards).toBeNull();
      }
      finishAndNext(m);
    }
    expect(dealt).toBeGreaterThanOrEqual(0);
    expect(m.actor.totalChips()).toBe(4000);
  });

  it('když ostatním nezbyde protihráč, čekání se zruší a hraje se dál', () => {
    const m = make({ 'table.newPlayerRule': 'waitForBb' });
    m.sit('a', 0);
    m.sit('b', 1);
    next(m);
    playOut(m);
    m.clock.advance(20_000);
    m.sit('c', 2);
    m.actor.leave('b');
    playOut(m);
    m.clock.advance(20_000);
    // zbývají a (zkušený) a c (nový): nikdo nesmí zůstat viset
    for (let i = 0; i < 4 && view(m).actingSeat === null; i++) m.clock.advance(1000);
    expect(view(m).handNumber).toBeGreaterThanOrEqual(3);
    expect(m.actor.hasError()).toBeNull();
  });
});

describe('straddle přes stůl', () => {
  it('povinný UTG straddle: platí ho hráč za big blindem a hraje se podle pravidel', () => {
    const m = make({ 'table.straddleEnabled': true, 'table.straddleMandatory': true, 'table.straddleMultiplier': 2, 'table.newPlayerRule': 'postDeadBlind' });
    ['a', 'b', 'c', 'd'].forEach((u, i) => m.sit(u, i));
    next(m);
    const v = view(m);
    expect(v.straddleSeat).toBe(3);
    expect(v.seats.find((s) => s.seat === 3)!.bet).toBe(20);
    expect(v.actingSeat).toBe(0);
    expect(v.legal === null).toBe(true);
    const l = view(m, 'a').legal!;
    expect(l.callAmount).toBe(20);
    expect(l.minRaiseTo).toBe(30);
    expect(m.actor.totalChips()).toBe(4000);
    playOut(m);
    expect(m.actor.totalChips()).toBe(4000);
  });

  it('dobrovolný straddle se platí jen na žádost hráče', () => {
    const m = make({ 'table.straddleEnabled': true, 'table.straddleMandatory': false });
    ['a', 'b', 'c', 'd'].forEach((u, i) => m.sit(u, i));
    m.actor.setStraddle('d', true);
    next(m);
    expect(view(m).straddleSeat).toBe(3);
    playOut(m);
    m.clock.advance(20_000);
    m.actor.setStraddle('d', false);
    m.actor.setStraddle('a', true);
    // další handa: straddler by byl hráč na jiném místě (button se posunul), tedy bez souhlasu se neplatí
    for (let i = 0; i < 3 && view(m).actingSeat === null; i++) m.clock.advance(500);
    const v = view(m);
    const straddler = v.straddleSeat === null ? null : v.seats.find((s) => s.seat === v.straddleSeat)!.playerId;
    expect(straddler === null || straddler === 'a').toBe(true);
  });

  it('vypnutý straddle nelze vyžádat', () => {
    const m = make();
    m.sit('a', 0);
    expect(() => m.actor.setStraddle('a', true)).toThrowError(expect.objectContaining({ code: 'STRADDLE_DISABLED' }));
  });
});

describe('big blind ante přes stůl', () => {
  it('BB zaplatí ante do potu, součet žetonů sedí a ante získá vítěz hlavního potu', () => {
    const m = make({ 'table.bbAnte': true, 'table.ante': 10 });
    ['a', 'b', 'c'].forEach((u, i) => m.sit(u, i));
    next(m);
    const v = view(m);
    // SB 5 + BB 10 + ante 10
    expect(v.totalPot).toBe(25);
    expect(m.actor.totalChips()).toBe(3000);
    fold(m);
    fold(m);
    expect(view(m).winners).not.toBeNull();
    expect(m.actor.totalChips()).toBe(3000);
    expect(m.ledger.balance(accounts.table('t'))).toBe(3000);
  });

  it('ante 0 při zapnutém BB ante = velikost big blindu', () => {
    const m = make({ 'table.bbAnte': true, 'table.ante': 0 });
    ['a', 'b', 'c'].forEach((u, i) => m.sit(u, i));
    next(m);
    expect(view(m).totalPot).toBe(5 + 10 + 10);
  });
});

describe('systém modulů', () => {
  const settingsOnly = (id: string, priority: number, extra: Partial<GameModule> = {}): GameModule => ({
    id,
    titleKey: `module.${id}`,
    priority,
    settingKeys: [],
    isEnabled: () => true,
    hooks: {},
    ...extra,
  });

  it('vestavěné moduly odkazují jen na existující nastavení a mají české názvy', () => {
    const p = new ModulePipeline(BUILTIN_MODULES);
    expect(p.validate(reg)).toEqual([]);
  });

  it('pořadí háčků určuje priorita a pak id', () => {
    const order: string[] = [];
    const mk = (id: string, priority: number) => settingsOnly(id, priority, { hooks: { onHandEnd: () => void order.push(id) } });
    const p = new ModulePipeline([mk('c', 5), mk('a', 20), mk('b', 5)]);
    p.run('onHandEnd', { settings: reg.defaults(), handNumber: 1, seats: [] }, {} as never);
    expect(order).toEqual(['b', 'c', 'a']);
  });

  it('duplicitní modul a chybějící závislost se odmítnou', () => {
    expect(() => new ModulePipeline([settingsOnly('x', 1), settingsOnly('x', 2)])).toThrow(/Duplicitní/);
    expect(() => new ModulePipeline([settingsOnly('x', 1, { dependsOn: ['nic'] })])).toThrow(/vyžaduje/);
  });

  it('neaktivní modul (podle nastavení) se nevolá', () => {
    let calls = 0;
    const p = new ModulePipeline([settingsOnly('x', 1, { isEnabled: (s) => !!s['special.rabbitHunt'], hooks: { onHandEnd: () => void calls++ } })]);
    const ctx = { settings: reg.defaults(), handNumber: 1, seats: [] };
    p.run('onHandEnd', ctx, {} as never);
    expect(calls).toBe(0);
    p.run('onHandEnd', { ...ctx, settings: { ...ctx.settings, 'special.rabbitHunt': true } }, {} as never);
    expect(calls).toBe(1);
  });

  it('chyba v modulu stůl nezastaví: modul se vypne a hra pokračuje', () => {
    const bad: GameModule = settingsOnly('bad', 1, {
      hooks: {
        onHandStart: () => {
          throw new Error('rozbitý modul');
        },
      },
    });
    const m = make({}, [bad, ...BUILTIN_MODULES]);
    m.sit('a', 0);
    m.sit('b', 1);
    next(m);
    expect(m.actor.hasError()).toBeNull();
    expect(m.actor.currentPhase()).toBe('hand');
    expect(m.events.some((e) => e.type === 'moduleError' && e.moduleId === 'bad' && e.message === 'rozbitý modul')).toBe(true);
    fold(m);
    m.clock.advance(5000);
    expect(view(m).handNumber).toBe(2);
    expect(m.events.filter((e) => e.type === 'moduleError')).toHaveLength(1);
  });

  it('vlastní modul dostane háčky v průběhu handy (nový prvek bez zásahu do jádra)', () => {
    const calls: string[] = [];
    const spy = settingsOnly('spy', 99, {
      hooks: {
        beforeDeal: () => void calls.push('beforeDeal'),
        onHandStart: () => void calls.push('onHandStart'),
        afterAction: (_c, _h, i) => void calls.push(`afterAction:${i.action}`),
        afterPotAwarded: () => void calls.push('afterPotAwarded'),
        onHandEnd: () => void calls.push('onHandEnd'),
        onPlayerBusted: (_c, s) => void calls.push(`busted:${s.userId}`),
      },
    });
    const m = make({}, [spy, ...BUILTIN_MODULES]);
    m.sit('a', 0);
    m.sit('b', 1);
    next(m);
    fold(m);
    m.clock.advance(5000);
    expect(calls.slice(0, 5)).toEqual(['beforeDeal', 'onHandStart', 'afterAction:fold', 'afterPotAwarded', 'onHandEnd']);
  });
});

describe('simulace s pravidly: BB ante, straddle, noví hráči, dead blind', () => {
  function run(seed: number, over: Record<string, number | boolean | string>, steps = 1200) {
    const rnd = seededRandom(seed);
    const m = make({ __seed: seed, 'cash.maxBuyInBb': 200, 'time.allInRunoutDelayMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.allInRiverDramaMs': 50, ...over });
    let hands = 0;
    for (let step = 0; step < steps; step++) {
      const user = USERS[Math.floor(rnd() * USERS.length)]!;
      const seated = m.actor.playersSeated().find((s) => s.userId === user);
      const r = rnd();
      try {
        if (!seated && r < 0.5) {
          const free = [...Array(9).keys()].find((n) => !m.actor.playersSeated().some((s) => s.seat === n))!;
          m.actor.join(user, user, free, 100 + Math.floor(rnd() * 1500));
        } else if (seated) {
          if (r < 0.05) m.actor.leave(user);
          else if (r < 0.09) m.actor.sitOut(user);
          else if (r < 0.15) m.actor.sitIn(user);
          else if (r < 0.2) m.actor.topUp(user, 10 * (1 + Math.floor(rnd() * 20)));
          else if (r < 0.25 && m.settings['table.straddleEnabled']) m.actor.setStraddle(user, rnd() < 0.5);
        }
      } catch (e) {
        if (!(e instanceof GameError)) throw e;
      }
      const v = view(m);
      if (m.actor.currentPhase() === 'hand' && v.actingSeat !== null) {
        const id = actingId(m)!;
        m.actor.act(id, randomLegalAction(view(m, id).legal!, rnd));
        hands = Math.max(hands, v.handNumber);
      }
      m.clock.advance(Math.floor(rnd() * 1500));
      expect(m.ledger.balance(accounts.table('t')), `krok ${step}`).toBe(m.actor.totalChips());
      expect(m.actor.hasError()).toBeNull();
      expect(m.ledger.totalIsZero([accounts.mint(), accounts.house(), accounts.table('t'), ...USERS.map(accounts.wallet)])).toBe(true);
    }
    return hands;
  }

  it('BB ante + povinný straddle + čekání na BB', () => {
    expect(run(Number(process.env.S ?? 1), { 'table.bbAnte': true, 'table.ante': 10, 'table.straddleEnabled': true, 'table.straddleMandatory': true, 'table.newPlayerRule': 'waitForBb' })).toBeGreaterThan(20);
  });
  it('dobrovolný straddle, dead blind a běžné ante', () => {
    expect(run(Number(process.env.S ?? 2), { 'table.ante': 2, 'table.straddleEnabled': true, 'table.straddleMandatory': false, 'table.straddleType': 'mississippi', 'table.newPlayerRule': 'postDeadBlind', 'table.deadBlindBb': 2 })).toBeGreaterThan(20);
  });
  it('všechno vypnuto a časovače krátké', () => {
    expect(run(Number(process.env.S ?? 3), { 'time.turnSeconds': 3, 'time.timeBankSeconds': 1, 'table.newPlayerRule': 'postDeadBlind' })).toBeGreaterThan(20);
  });
});
