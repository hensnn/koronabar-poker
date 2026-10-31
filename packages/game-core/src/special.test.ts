import { describe, expect, it } from 'vitest';
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { FakeClock } from './clock.js';
import { settleRuns, extraBoards } from './runs.js';
import { TableActor, type TableEvent } from './table-actor.js';
import type { Card, HandPlayer, HandState } from './types.js';

const reg = createDefaultRegistry();

function make(over: Record<string, number | boolean | string> = {}, players = ['a', 'b'], stack = 1000, seed = 1) {
  const clock = new FakeClock();
  const ledger = new Ledger();
  const cash = new CashService(ledger);
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'time.betweenHandsMs': 100, 'time.showdownMs': 100, 'time.potToWinnerMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.runItDelayMs': 100, 'odds.enabled': false, ...over } as SettingValues;
  const events: TableEvent[] = [];
  let n = seed;
  const rnd = () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: rnd, onEvent: (e) => events.push(e) });
  players.forEach((p, i) => {
    cash.mint(p, 100_000, `m-${p}`);
    actor.join(p, p.toUpperCase(), i, stack);
  });
  clock.advance(100);
  const acting = () => {
    const v = actor.viewFor(null);
    return v.seats.find((s) => s.seat === v.actingSeat)?.playerId;
  };
  const allIn = () => {
    for (let i = 0; i < 12 && actor.currentPhase() === 'hand'; i++) {
      const p = acting();
      if (!p) break;
      const legal = actor.viewFor(p).legal!;
      actor.act(p, legal.callAmount > 0 && legal.callAmount >= legal.maxRaiseTo ? { type: 'call' } : { type: 'allIn' });
    }
  };
  /** Posouvá čas, dokud handa nedojde do pauzy (výsledek je odhalen, ještě nezačala další). */
  const untilPause = () => {
    for (let i = 0; i < 400 && actor.currentPhase() !== 'pause'; i++) clock.advance(25);
  };
  return { clock, ledger, actor, events, settings, acting, allIn, untilPause };
}

describe('run it twice/třikrát', () => {
  it('po all-inu se hlasuje, karty se do rozhodnutí neukážou; po souhlasu se dělí pot mezi běhy a součty sedí', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const m = make({ 'special.runItTwice': true }, ['a', 'b'], 1000, seed);
      m.allIn();
      expect(m.actor.currentPhase()).toBe('runout');
      const v = m.actor.viewFor('a');
      expect(v.vote).toMatchObject({ kind: 'runit', canVote: true, status: 'open' });
      expect(v.board).toHaveLength(0); // preflop all-in: nic z boardu se zatím neukázalo
      expect(v.winners).toBeNull();
      // hlasuje se dřív, než se otočí karty: soupeřovy karty ani šance na výhru se zatím neukazují
      expect(v.seats.find((q) => q.playerId === 'b')!.cards).toBeNull();
      expect(v.odds).toBeNull();
      expect(m.actor.viewFor('b').vote!.myVote).toBeNull();
      m.actor.voteRunIt('a', true);
      m.actor.voteRunIt('b', true);
      m.untilPause();
      expect(m.actor.currentPhase()).toBe('pause');
      const view = m.actor.viewFor('a');
      expect(view.runs).toHaveLength(2);
      const perRun = view.runs!.map((r) => r.winners.reduce((n, w) => n + w.amount, 0));
      expect(perRun).toEqual([1000 + 1000 - 1000, 1000]); // pot 2000: 1000 na běh
      // poslední karty obou boardů (kromě společného prefixu) se mohou lišit, prefix je shodný
      expect(view.runs![0]!.board).toHaveLength(5);
      expect(view.runs![1]!.board).toHaveLength(5);
      // celkem: součet stacků u stolu = 2000 a kniha sedí
      expect(m.actor.totalChips()).toBe(2000);
      expect(m.ledger.balance(accounts.table('t'))).toBe(2000);
      const chips = Object.fromEntries(m.actor.playersSeated().map((s) => [s.userId, s.chips + s.pendingChips]));
      expect(chips.a! + chips.b!).toBe(2000);
      // výsledek odpovídá součtu výher v obou bězích
      const wonBySeat = new Map<number, number>();
      for (const r of view.runs!) for (const w of r.winners) wonBySeat.set(w.seat, (wonBySeat.get(w.seat) ?? 0) + w.amount);
      expect((wonBySeat.get(0) ?? 0) + (wonBySeat.get(1) ?? 0)).toBe(2000);
      // po předělu: nová handa běží s přepočítanými žetony
      m.clock.advance(1000);
      expect(m.actor.totalChips()).toBe(2000);
    }
  });

  it('bez souhlasu všech (nesouhlas i vypršení) se hraje jen jednou', () => {
    const no = make({ 'special.runItTwice': true }, ['a', 'b']);
    no.allIn();
    no.actor.voteRunIt('a', true);
    no.actor.voteRunIt('b', false);
    no.clock.advance(3000);
    expect(no.actor.viewFor('a').runs).toBeNull();
    expect(no.actor.totalChips()).toBe(2000);

    const late = make({ 'special.runItTwice': true, 'special.runItVoteSeconds': 5 }, ['a', 'b']);
    late.allIn();
    late.actor.voteRunIt('a', true);
    late.clock.advance(5_001);
    // výsledek (vypršelo) se ještě chvíli ukazuje všem u stolu, pak se rozdává
    expect(late.actor.viewFor(null).vote?.status).toBe('expired');
    late.clock.advance(3000);
    expect(late.actor.viewFor(null).vote).toBeNull();
    expect(late.actor.viewFor('a').runs).toBeNull();
  });

  it('výsledek hlasování vidí všichni (i divák) po dobu pauzy a až pak se rozdává; kdo jak hlasoval je vidět', () => {
    const t = make({ 'special.runItTwice': true, 'time.runItResultMs': 2000 }, ['a', 'b']);
    t.allIn();
    // během hlasování vidí divák, kdo už souhlasil
    t.actor.voteRunIt('a', true);
    const open = t.actor.viewFor(null).vote!;
    expect(open.status).toBe('open');
    expect(open.voters.find((v) => v.userId === 'a')).toMatchObject({ voted: true, vote: true });
    expect(open.voters.find((v) => v.userId === 'b')).toMatchObject({ voted: false, vote: null });
    t.actor.voteRunIt('b', true);
    // rozhodnuto: výsledek je vidět, ale rozdávání ještě nezačalo
    const decided = t.actor.viewFor(null).vote!;
    expect(decided.status).toBe('passed');
    expect(decided.voters.every((v) => v.vote === true)).toBe(true);
    expect(t.actor.viewFor('a').runs).toBeNull();
    t.clock.advance(1_000);
    expect(t.actor.viewFor(null).vote?.status).toBe('passed');
    t.clock.advance(1_100);
    expect(t.actor.viewFor(null).vote).toBeNull();
    t.untilPause();
    expect(t.actor.viewFor('a').runs).toHaveLength(2);
    expect(t.actor.totalChips()).toBe(2000);
  });

  it('pauza s výsledkem 0 = rozdává se hned jako dřív', () => {
    const t = make({ 'special.runItTwice': true, 'time.runItResultMs': 0 }, ['a', 'b']);
    t.allIn();
    t.actor.voteRunIt('a', true);
    t.actor.voteRunIt('b', false);
    expect(t.actor.viewFor(null).vote).toBeNull();
  });

  it('třikrát; vypnuté nastavení se neptá; tři hráči s vedlejšími poty', () => {
    const three = make({ 'special.runItTwice': true, 'special.runItTimes': 3 }, ['a', 'b', 'c']);
    three.allIn();
    expect(three.actor.currentPhase()).toBe('runout');
    for (const u of ['a', 'b', 'c']) three.actor.voteRunIt(u, true);
    three.untilPause();
    const v = three.actor.viewFor('a');
    expect(v.runs).toHaveLength(3);
    expect(three.actor.totalChips()).toBe(3000);
    expect(three.ledger.balance(accounts.table('t'))).toBe(3000);

    const off = make({}, ['a', 'b']);
    off.allIn();
    expect(off.actor.viewFor('a').vote).toBeNull();
  });

  it('vedlejší pot při různých stacích: součet výher vždy sedí (náhodné pokusy)', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const clock = new FakeClock();
      const ledger = new Ledger();
      const cash = new CashService(ledger);
      const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'cash.maxBuyInBb': 500, 'time.betweenHandsMs': 100, 'time.showdownMs': 100, 'time.potToWinnerMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.runItDelayMs': 100, 'odds.enabled': false, 'special.runItTwice': true } as SettingValues;
      let n = seed;
      const rnd = () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: rnd });
      const stacks = { a: 300, b: 700, c: 1500 };
      for (const [i, [u, s]] of Object.entries(stacks).entries()) {
        cash.mint(u, 10_000, `m-${u}`);
        actor.join(u, u, i, s);
      }
      clock.advance(100);
      for (let i = 0; i < 12 && actor.currentPhase() === 'hand'; i++) {
        const v = actor.viewFor(null);
        const p = v.seats.find((s) => s.seat === v.actingSeat)!.playerId;
        const legal = actor.viewFor(p).legal!;
        actor.act(p, legal.callAmount > 0 && legal.callAmount >= legal.maxRaiseTo ? { type: 'call' } : { type: 'allIn' });
      }
      if (actor.currentPhase() === 'runout') for (const u of ['a', 'b', 'c']) try { actor.voteRunIt(u, true); } catch { /* už ne ve hře */ }
      for (let i = 0; i < 400 && actor.currentPhase() !== 'pause'; i++) clock.advance(25);
      expect(actor.totalChips()).toBe(2500);
      expect(ledger.balance(accounts.table('t'))).toBe(2500);
    }
  });
});

describe('settleRuns (čistý výpočet)', () => {
  const player = (seat: number, id: string, invested: number, hole: [Card, Card], status: HandPlayer['status'] = 'allIn'): HandPlayer => ({ seat, playerId: id, name: id, stack: 0, bet: 0, invested, status, hole, timeBank: 0, dead: 0 });
  const hand = (players: HandPlayer[], board: Card[]): HandState => ({ handId: 'h', handNumber: 1, street: 'SHOWDOWN', board, buttonSeat: 0, smallBlindSeat: null, bigBlindSeat: null, actingSeat: null, players, pots: [], winners: [], finished: true, minRaiseTo: 0, currentBet: 0, deadMoney: 0, straddleSeat: null });

  it('každý běh dostane polovinu každého potu, lichý žeton první běh', () => {
    // a: AA, b: KK; run 1: bez pomoci pro b (a vyhrává), run 2: král na boardu (b vyhrává set)
    const h = hand([player(0, 'a', 101, ['As', 'Ah'] as [Card, Card]), player(1, 'b', 100, ['Ks', 'Kh'] as [Card, Card])], ['2c', '7d', '9h', '4s', '3c'] as Card[]);
    const boards: Card[][] = [h.board, ['2c', '7d', '9h', 'Kd', '3c'] as Card[]];
    const out = settleRuns(h, boards);
    // pot 200 (nevyrovnaná 1 se vrací a): 100 na běh; a vyhrává běh 1, b běh 2
    expect(out.winnings.get(0)).toBe(100 + 1);
    expect(out.winnings.get(1)).toBe(100);
    expect(out.runs[0]!.winners[0]).toMatchObject({ seat: 0, amount: 100 });
    expect(out.runs[1]!.winners[0]).toMatchObject({ seat: 1, amount: 100 });
  });

  it('složený hráč nad úrovní krátkého all-inu: jeho vklad patří vedlejšímu potu jediného zbývajícího (regrese: chyběly žetony)', () => {
    // c (330) all-in, a a b vložili po 436, b složil, a je all-in; vedlejší pot 212 patří a, hlavní pot 990 vyhraje c
    const h = hand([player(0, 'a', 436, ['7h', '2c'] as [Card, Card]), player(1, 'b', 436, ['2h', '4d'] as [Card, Card], 'folded'), player(2, 'c', 330, ['Ks', '4h'] as [Card, Card])], ['Qs', '3s', '8h', 'Qc', '5d'] as Card[]);
    const out = settleRuns(h, [h.board, ['Qs', '3s', '8h', 'Qc', '5d'] as Card[], ['Qs', '3s', '8h', 'Qc', '5d'] as Card[]]);
    const total = [...out.winnings.values()].reduce((n, x) => n + x, 0);
    expect(total).toBe(436 + 436 + 330);
    expect(out.winnings.get(0)).toBe(212);
  });

  it('extraBoards: zachová společný prefix a bere karty ze zbytku balíčku', () => {
    const first = ['2c', '7d', '9h', '4s', '3c'] as Card[];
    const deck = ['Ah', 'Ad', 'Kc', 'Ks', 'Qc', 'Qs'] as Card[];
    expect(extraBoards(first, 3, deck, 3)).toEqual([first, ['2c', '7d', '9h', 'Ah', 'Ad'], ['2c', '7d', '9h', 'Kc', 'Ks']]);
    expect(extraBoards(first, 5, deck, 2)).toBeNull();
    expect(extraBoards(first, 0, deck.slice(0, 4), 2)).toBeNull();
  });
});
