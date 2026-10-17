import { describe, expect, it } from 'vitest';
import { assess, computeRake, jackpotAwards, type JackpotRules, type RakeRules } from './rake.js';
import type { Card, HandPlayer, HandState } from './types.js';

const player = (seat: number, id: string, invested: number, hole: [Card, Card] | null, status: HandPlayer['status'] = 'active'): HandPlayer => ({
  seat,
  playerId: id,
  name: id,
  stack: 0,
  bet: 0,
  invested,
  status,
  hole,
  timeBank: 0,
  dead: 0,
});

function hand(players: HandPlayer[], board: Card[], winners: { seat: number; amount: number }[]): HandState {
  return {
    handId: 'h1',
    handNumber: 1,
    street: 'SHOWDOWN',
    board,
    buttonSeat: 0,
    actingSeat: null,
    players,
    pots: [],
    winners: winners.map((w) => ({ ...w, handName: null, cards: null })),
    finished: true,
    minRaiseTo: 0,
    currentBet: 0,
    deadMoney: 0,
    straddleSeat: null,
  };
}

const RULES: RakeRules = { enabled: true, percent: 10, capChips: 0, noFlopNoDrop: true, rate: 1 };
const FLOP: Card[] = ['2c', '7d', 'Kh', '9s', '4c'] as Card[];

describe('rake', () => {
  it('procento z potu se strhne výherci, strop a no flop no drop se dodrží', () => {
    const h = hand([player(0, 'a', 100, ['Ah', 'Ad'] as [Card, Card]), player(1, 'b', 100, ['Kc', 'Qc'] as [Card, Card])], FLOP, [{ seat: 0, amount: 200 }]);
    expect(computeRake(h, RULES).total).toBe(20);
    expect(computeRake(h, RULES).byUser.get('a')).toBe(20);
    expect(computeRake(h, { ...RULES, capChips: 7 }).total).toBe(7);
    expect(computeRake(h, { ...RULES, enabled: false }).total).toBe(0);
    const preflop = { ...h, board: [] as Card[] };
    expect(computeRake(preflop, RULES).total).toBe(0);
    expect(computeRake(preflop, { ...RULES, noFlopNoDrop: false }).total).toBe(20);
  });

  it('nevyrovnaná sázka se nezpoplatňuje a rake je násobek kurzu', () => {
    // a vsadil 300, b dorovnal jen 100: kontestovaný pot je 200, 100 se vrací
    const h = hand([player(0, 'a', 300, null), player(1, 'b', 100, null, 'allIn')], FLOP, [{ seat: 0, amount: 400 }]);
    expect(computeRake(h, RULES).total).toBe(20);
    expect(computeRake(h, { ...RULES, rate: 5 }).total).toBe(20);
    expect(computeRake(h, { ...RULES, rate: 7 }).total % 7).toBe(0);
  });

  it('rake se mezi víc výherců dělí poměrně a součet sedí', () => {
    const h = hand([player(0, 'a', 100, null), player(1, 'b', 100, null), player(2, 'c', 100, null)], FLOP, [
      { seat: 0, amount: 200 },
      { seat: 1, amount: 100 },
    ]);
    const r = computeRake(h, { ...RULES, percent: 7 });
    expect(r.total).toBe(21);
    expect([...r.byUser.values()].reduce((a, b) => a + b, 0)).toBe(r.total);
  });
});

describe('vyhodnocení rukou pro jackpoty', () => {
  it('pozná royal flush, postupku v barvě a čtyřku a to, zda hrají obě karty z ruky', () => {
    const royal = assess(['Ah', 'Kh'] as [Card, Card], ['Qh', 'Jh', 'Th', '2c', '3d'] as Card[])!;
    expect(royal.category).toBe('royalFlush');
    expect(royal.usesBothHole).toBe(true);
    const boardRoyal = assess(['2c', '3d'] as [Card, Card], ['Ah', 'Kh', 'Qh', 'Jh', 'Th'] as Card[])!;
    expect(boardRoyal.category).toBe('royalFlush');
    expect(boardRoyal.usesBothHole).toBe(false);
    expect(assess(['9h', '8h'] as [Card, Card], ['7h', '6h', '5h', 'Kc', '2d'] as Card[])!.category).toBe('straightFlush');
    expect(assess(['9h', '9d'] as [Card, Card], ['9c', '9s', '5h', 'Kc', '2d'] as Card[])!.category).toBe('quads');
    expect(assess(['9h', '8d'] as [Card, Card], ['9c', 'Js', '5h', 'Kc', '2d'] as Card[])!.category).toBe('other');
  });
});

describe('jackpoty', () => {
  const rules: JackpotRules = {
    royalFlush: { enabled: true, percent: 50 },
    badBeat: { enabled: true, percent: 50, minHand: 'quads', loserShare: 50, winnerShare: 25 },
  };

  it('royal flush vyplatí podíl z fondu', () => {
    const h = hand([player(0, 'a', 50, ['Ah', 'Kh'] as [Card, Card]), player(1, 'b', 50, ['2c', '3d'] as [Card, Card])], ['Qh', 'Jh', 'Th', '9c', '4d'] as Card[], [{ seat: 0, amount: 100 }]);
    const awards = jackpotAwards(h, rules, 1000);
    expect(awards).toHaveLength(1);
    expect(awards[0]!.kind).toBe('royalFlush');
    expect(awards[0]!.payouts.get('a')).toBe(500);
  });

  it('bad beat: čtyřka prohrává se silnější rukou, výplata se dělí poražený / vítěz / ostatní', () => {
    // a: poker 9, obě karty v kombinaci; b: postupka v barvě 5-9 srdcí... nižší než poker? použijeme královskou postupku soupeře
    const board = ['9c', '9s', 'Th', 'Jh', 'Qh'] as Card[];
    const h = hand(
      [
        player(0, 'poraz', 50, ['9h', '9d'] as [Card, Card]), // čtyřka devítek
        player(1, 'vitez', 50, ['Ah', 'Kh'] as [Card, Card]), // royal flush v srdcích je lepší
        player(2, 'treti', 50, ['2c', '3d'] as [Card, Card], 'active'),
      ],
      board,
      [{ seat: 1, amount: 150 }],
    );
    const awards = jackpotAwards(h, { ...rules, royalFlush: { enabled: false, percent: 0 } }, 1000);
    expect(awards).toHaveLength(1);
    const p = awards[0]!.payouts;
    expect(awards[0]!.kind).toBe('badBeat');
    expect(p.get('poraz')).toBe(250);
    expect(p.get('vitez')).toBe(125);
    expect(p.get('treti')).toBe(125);
    expect([...p.values()].reduce((a, b) => a + b, 0)).toBe(500);
  });

  it('bez showdownu, s prázdným fondem nebo s vypnutými jackpoty se nic nevyplácí', () => {
    const h = hand([player(0, 'a', 50, ['Ah', 'Kh'] as [Card, Card]), player(1, 'b', 50, ['2c', '3d'] as [Card, Card], 'folded')], ['Qh', 'Jh', 'Th', '9c', '4d'] as Card[], [{ seat: 0, amount: 100 }]);
    expect(jackpotAwards(h, rules, 1000)).toHaveLength(0);
    const h2 = hand([player(0, 'a', 50, ['Ah', 'Kh'] as [Card, Card]), player(1, 'b', 50, ['2c', '3d'] as [Card, Card])], ['Qh', 'Jh', 'Th', '9c', '4d'] as Card[], [{ seat: 0, amount: 100 }]);
    expect(jackpotAwards(h2, rules, 0)).toHaveLength(0);
    expect(jackpotAwards(h2, { royalFlush: { enabled: false, percent: 50 }, badBeat: { ...rules.badBeat, enabled: false } }, 1000)).toHaveLength(0);
  });
});

describe('rake nad skutečným enginem', () => {
  it('výhra zahrnuje vrácenou nevyrovnanou sázku, takže základ rake odpovídá kontestovanému potu', async () => {
    const { PokertoolsAdapter } = await import('./adapter.js');
    for (let i = 0; i < 20; i++) {
      const a = new PokertoolsAdapter({ smallBlind: 5, bigBlind: 10, ante: 0, maxPlayers: 9, timeBankSeconds: 30 });
      a.seat(0, 'big', 'Big', 1000);
      a.seat(1, 'small', 'Small', 300);
      a.startHand();
      for (let guard = 0; guard < 20 && !a.state().finished; guard++) {
        const s = a.state();
        const id = s.players.find((p) => p.seat === s.actingSeat)!.playerId;
        const legal = a.legalActions(id)!;
        a.act(id, id === 'big' ? { type: 'allIn' } : legal.callAmount > 0 ? { type: 'call' } : { type: 'check' });
      }
      const h = a.state();
      expect(h.finished).toBe(true);
      const invested = h.players.reduce((n, p) => n + p.invested + p.dead, 0);
      const won = (h.winners ?? []).reduce((n, w) => n + w.amount, 0);
      // vítězství zahrnuje vše, co bylo v potu, včetně vrácené nevyrovnané sázky
      expect(won).toBe(invested);
      const r = computeRake(h, { ...RULES, noFlopNoDrop: false, percent: 10 });
      // kontestovaný pot je 2 × 300 = 600, rake 60 (vrácených 700 se nezpoplatňuje)
      expect(r.total).toBe(60);
    }
  });
});

describe('rake a jackpot u stolu', () => {
  it('rake se stáhne vítězi a zapíše do knihy, royal flush vyplatí jackpot a součty sedí', async () => {
    const { accounts, CashService, Ledger } = await import('@kb/ledger');
    const { createDefaultRegistry, resolveSettings } = await import('@kb/shared');
    const { PokertoolsAdapter } = await import('./adapter.js');
    const { FakeClock } = await import('./clock.js');
    const { TableActor } = await import('./table-actor.js');

    const clock = new FakeClock();
    const ledger = new Ledger();
    const cash = new CashService(ledger);
    for (const u of ['u1', 'u2']) cash.mint(u, 10_000, `m-${u}`);
    // jackpotový fond naplněný dřívějším rake
    ledger.post({ kind: 'mint', idempotencyKey: 'seed-fund', entries: [{ account: accounts.mint(), amount: -1000 }, { account: accounts.fund('jackpot'), amount: 1000 }] });
    const settings = resolveSettings(createDefaultRegistry(), [
      {
        scope: 'global',
        values: { 'cash.minBuyInBb': 10, 'cash.maxBuyInBb': 500, 'time.betweenHandsMs': 100, 'time.showdownMs': 50, 'time.potToWinnerMs': 50, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'odds.enabled': false, 'rake.enabled': true, 'rake.percent': 10, 'rake.cap': 0, 'rake.jackpotPercent': 50, 'jackpot.royalFlushEnabled': true, 'jackpot.royalFlushPercent': 50 },
      },
    ]).values;
    const events: string[] = [];
    // Skutečný engine, jen výsledek handy se podvrhne: u1 má royal flush a vyhrává
    const factory = (cfg: ConstructorParameters<typeof PokertoolsAdapter>[0]) => {
      const real = new PokertoolsAdapter(cfg);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'state') {
            return () => {
              const s = target.state();
              if (!s.finished || !s.winners || s.players.length !== 2) return s;
              const total = s.winners.reduce((n, w) => n + w.amount, 0);
              const p0 = s.players.find((p) => p.playerId === 'u1')!;
              return {
                ...s,
                board: ['Qh', 'Jh', 'Th', '9c', '4d'] as Card[],
                players: s.players.map((p) => ({ ...p, hole: (p.playerId === 'u1' ? ['Ah', 'Kh'] : ['2c', '3d']) as [Card, Card], status: 'active' as const })),
                winners: [{ seat: p0.seat, amount: total, handName: null, cards: null }],
              };
            };
          }
          const v = (target as never)[prop];
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    };
    const table = new TableActor({ tableId: 'T', settings: () => settings, clock, cash, adapterFactory: factory, onEvent: (e) => events.push(e.type) });
    table.join('u1', 'u1', 0, 1000);
    table.join('u2', 'u2', 1, 1000);
    for (let i = 0; i < 400 && !events.includes('jackpot'); i++) {
      const v = table.viewFor(null);
      if (table.currentPhase() === 'hand' && v.actingSeat !== null) {
        const p = v.seats.find((x) => x.seat === v.actingSeat)!;
        const legal = table.viewFor(p.playerId).legal!;
        table.act(p.playerId, legal.canCheck ? { type: 'check' } : { type: 'call' });
      }
      clock.advance(300);
    }
    clock.advance(2000);
    expect(events).toContain('rake');
    expect(events).toContain('jackpot');
    // pot 40 (blindy 10+10 doplatí se na showdownu), rake 10 % = 4: polovina domu, polovina do fondu, jackpot 50 % fondu
    expect(ledger.balance(accounts.house())).toBeGreaterThan(0);
    const fund = ledger.balance(accounts.fund('jackpot'));
    expect(fund).toBeLessThan(1000 + 5);
    expect(ledger.totalIsZero([accounts.mint(), accounts.house(), accounts.fund('jackpot'), accounts.table('T'), accounts.wallet('u1'), accounts.wallet('u2')])).toBe(true);
    expect(ledger.balance(accounts.table('T'))).toBe(table.totalChips());
    // u1 má víc, než kolik vložil a vyhrál v potu: jackpot 50 % fondu (~500) je v jeho žetonech
    const chips = table.playersSeated().find((s) => s.userId === 'u1')!.chips;
    expect(chips).toBeGreaterThan(1000 + 400);
  });
});
