import { describe, it, expect } from 'vitest';
import { PokertoolsAdapter } from './adapter.js';
import { buildView, wentToShowdown, type Reveal } from './view.js';
import type { PlayerAction } from './types.js';

const cfg = { smallBlind: 5, bigBlind: 10, ante: 0, maxPlayers: 9, timeBankSeconds: 30 };
const info = { seatCount: 9, smallBlind: 5, bigBlind: 10, minBuyIn: 100, maxBuyIn: 1000, chipsPerCurrencyUnit: 1, topUpEnabled: true, rebuyEnabled: true, currencySymbol: 'KČ', currencyForms: ['Korona', 'Korony', 'Koron'] as [string, string, string], currencyDecimals: 0, straddle: 'off' as const };
const none: Reveal = { boardCards: 0, holeCards: false, winners: false };

function randomAction(a: PokertoolsAdapter, rnd: () => number): { id: string; act: PlayerAction } {
  const s = a.state();
  const p = s.players.find((x) => x.seat === s.actingSeat)!;
  const l = a.legalActions(p.playerId)!;
  const r = rnd();
  if (r < 0.15) return { id: p.playerId, act: { type: 'fold' } };
  if (r < 0.3 && (l.canBet || l.canRaise)) return { id: p.playerId, act: { type: 'allIn' } };
  if (r < 0.5 && (l.canBet || l.canRaise)) {
    const amt = l.minRaiseTo;
    return { id: p.playerId, act: { type: l.canBet ? 'bet' : 'raise', amount: amt } };
  }
  return { id: p.playerId, act: l.canCheck ? { type: 'check' } : { type: 'call' } };
}

describe('maska pohledu: klient nikdy nedostane cizí karty', () => {
  it('v průběhu handy vidí hráč jen své karty a nic z balíčku (náhodné handy)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let hand = 0; hand < 60; hand++) {
      const a = new PokertoolsAdapter(cfg);
      const n = 2 + Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) a.seat(i, `p${i}`, `P${i}`, 100 + Math.floor(rnd() * 900));
      a.startHand();
      let guard = 0;
      while (!a.state().finished && guard++ < 80) {
        const h = a.state();
        const deck = a.remainingDeck();
        for (const viewer of [...h.players.map((p) => p.playerId), null]) {
          const v = buildView(h, { seq: 1, info, viewerId: viewer, deadline: null, reveal: { ...none, boardCards: h.board.length }, legal: null, odds: null });
          const json = JSON.stringify(v);
          for (const p of h.players) {
            if (p.playerId === viewer) continue;
            for (const c of p.hole!) expect(json, `cizí karta ${c}`).not.toContain(`"${c}"`);
          }
          // Z balíčku se nic neposílá (karty, které teprve přijdou)
          for (const c of deck.slice(0, 3)) expect(json).not.toContain(`"${c}"`);
        }
        const { id, act } = randomAction(a, rnd);
        a.act(id, act);
      }
    }
  });

  it('po showdownu se ukážou karty hráčů ve hře, složené zůstávají skryté', () => {
    const a = new PokertoolsAdapter(cfg);
    for (let i = 0; i < 3; i++) a.seat(i, `p${i}`, `P${i}`, 1000);
    a.startHand();
    const first = a.state().players.find((p) => p.seat === a.state().actingSeat)!;
    a.act(first.playerId, { type: 'fold' });
    for (let g = 0; g < 20 && !a.state().finished; g++) {
      const s = a.state();
      const p = s.players.find((x) => x.seat === s.actingSeat)!;
      const l = a.legalActions(p.playerId)!;
      a.act(p.playerId, l.canCheck ? { type: 'check' } : { type: 'call' });
    }
    const h = a.state();
    expect(h.finished).toBe(true);
    expect(wentToShowdown(h)).toBe(true);
    const v = buildView(h, { seq: 1, info, viewerId: null, deadline: null, reveal: { boardCards: 5, holeCards: true, winners: true }, legal: null, odds: null });
    const folded = v.seats.find((s) => s.playerId === first.playerId)!;
    expect(folded.cards).toBeNull();
    expect(v.seats.filter((s) => s.cards).length).toBe(2);
    expect(v.winners!.length).toBeGreaterThan(0);
  });

  it('před odhalením výherců se výhra nezobrazí ani ve stacku', () => {
    const a = new PokertoolsAdapter(cfg);
    a.seat(0, 'a', 'A', 100);
    a.seat(1, 'b', 'B', 100);
    a.startHand();
    for (let g = 0; g < 10 && !a.state().finished; g++) a.act(a.state().players.find((x) => x.seat === a.state().actingSeat)!.playerId, { type: 'allIn' });
    const h = a.state();
    const v = buildView(h, { seq: 1, info, viewerId: 'a', deadline: null, reveal: { boardCards: 0, holeCards: false, winners: false }, legal: null, odds: null });
    expect(v.winners).toBeNull();
    expect(v.board).toEqual([]);
    expect(v.totalPot).toBe(200);
    expect(v.seats.reduce((n, s) => n + s.stack, 0)).toBe(0);
    expect(v.seats.find((s) => s.playerId === 'b')!.cards).toBeNull();
  });
});

describe('výhra bez showdownu neprozradí karty', () => {
  it('při složení všech ostatních se kombinace výherce neukáže a karty zůstanou skryté', () => {
    const a = new PokertoolsAdapter(cfg);
    for (let i = 0; i < 3; i++) a.seat(i, `p${i}`, `P${i}`, 1000);
    a.startHand();
    for (let g = 0; g < 5 && !a.state().finished; g++) a.act(a.state().players.find((p) => p.seat === a.state().actingSeat)!.playerId, { type: 'fold' });
    const h = a.state();
    expect(h.finished).toBe(true);
    expect(wentToShowdown(h)).toBe(false);
    const winner = h.winners![0]!;
    const v = buildView(h, { seq: 1, info, viewerId: null, deadline: null, reveal: { boardCards: 5, holeCards: true, winners: true }, legal: null, odds: null });
    expect(v.winners![0]!.hand).toBeNull();
    expect(JSON.stringify(v)).not.toContain(`"${h.players.find((p) => p.seat === winner.seat)!.hole![0]}"`);
    expect(v.seats.every((s) => s.cards === null)).toBe(true);
  });
});
