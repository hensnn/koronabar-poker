import { describe, it, expect } from 'vitest';
import { PokertoolsAdapter } from './adapter.js';
import { seededRandom } from './bot.js';
import type { LegalActions, PlayerAction } from './types.js';

// Rozšířená kontrola pravidla „no limit“: zvýšit smí každý, kdo má víc žetonů než dorovnání a sázky mu byly otevřeny.
// Kontroluje i výši minimálního zvýšení po krátkém all-inu, to, že all-in jde vždy (i pod minimem), antes a straddle.
const base = { smallBlind: 5, bigBlind: 10, ante: 0, maxPlayers: 9, timeBankSeconds: 30 };

const actingId = (a: PokertoolsAdapter) => a.state().players.find((p) => p.seat === a.state().actingSeat)!.playerId;

/** Náhodná, ale pestrá volba tahu včetně přesného minima, přesného maxima a all-inu. */
function pick(legal: LegalActions, rnd: () => number): PlayerAction {
  const r = rnd();
  const aggress = legal.canBet || legal.canRaise;
  if (aggress && r < 0.3) return { type: 'allIn' };
  if (aggress && r < 0.55) return { type: legal.canBet ? 'bet' : 'raise', amount: legal.minRaiseTo };
  if (aggress && r < 0.7) return { type: legal.canBet ? 'bet' : 'raise', amount: legal.maxRaiseTo };
  if (r < 0.85) return legal.canCheck ? { type: 'check' } : { type: 'call' };
  if (legal.canCheck) return { type: 'check' };
  return rnd() < 0.2 ? { type: 'fold' } : { type: 'call' };
}

interface Variant {
  name: string;
  ante: number;
  straddle: boolean;
}
const VARIANTS: Variant[] = [
  { name: 'bez antes', ante: 0, straddle: false },
  { name: 's ante', ante: 2, straddle: false },
  { name: 'se straddle', ante: 0, straddle: true },
];

describe('no limit: kdo má žetony a sázky jsou otevřené, smí zvyšovat (rozšířená kontrola)', () => {
  for (const v of VARIANTS) {
    it(`${v.name}: canRaise, minimum zvýšení, all-in pod minimem a zachování žetonů`, () => {
      let checked = 0;
      let shortAllInRaise = 0;
      let minChecked = 0;
      for (let seed = 1; seed <= 500; seed++) {
        const rnd = seededRandom(seed * 7 + v.ante);
        const n = (v.straddle ? 3 : 2) + (seed % (v.straddle ? 4 : 5));
        const a = new PokertoolsAdapter({ ...base, ante: v.ante });
        for (let i = 0; i < n; i++) a.seat(i, `p${i}`, `P${i}`, 30 + Math.floor(rnd() * 400));
        const sum = a.state().players.reduce((s, p) => s + p.stack + p.invested, 0);
        a.startHand(v.straddle ? { straddle: { type: 'utg', amount: 20 } } : {});
        let street = a.state().street;
        let cur = a.state().currentBet;
        let minInc = base.bigBlind;
        let acted = new Map<string, number>();
        let guard = 0;
        while (!a.state().finished && a.state().actingSeat != null && guard++ < 200) {
          const id = actingId(a);
          const me = a.state().players.find((p) => p.playerId === id)!;
          const l = a.legalActions(id)!;
          const toCall = cur - me.bet;
          const should = me.stack > toCall && (!acted.has(id) || cur - acted.get(id)! >= minInc);
          const ctx = `${v.name}, seed ${seed}, ${id}, cur ${cur}, minInc ${minInc}, stack ${me.stack}, bet ${me.bet}`;
          expect(l.canRaise || l.canBet, ctx).toBe(should);
          checked++;
          if (should) {
            // maximum = všechny žetony; minimum = poslední plné zvýšení, nejvýš všechny žetony
            expect(l.maxRaiseTo, ctx).toBe(me.stack + me.bet);
            const expectedMin = Math.min(me.stack + me.bet, cur === 0 ? base.bigBlind : cur + minInc);
            expect(l.minRaiseTo, ctx).toBe(expectedMin);
            minChecked++;
            if (l.maxRaiseTo < cur + minInc && cur > 0) shortAllInRaise++;
          }
          const action = pick(l, rnd);
          a.act(id, action);
          const s2 = a.state();
          if (s2.street !== street) {
            street = s2.street;
            cur = 0;
            minInc = base.bigBlind;
            acted = new Map();
            continue;
          }
          if (s2.currentBet > cur) {
            const inc = s2.currentBet - cur;
            if (inc >= minInc) minInc = inc;
            cur = s2.currentBet;
          }
          acted.set(id, cur);
          if (!s2.finished) expect(s2.players.reduce((s, p) => s + p.stack + p.invested, 0) + s2.deadMoney, ctx).toBe(sum);
        }
      }
      expect(checked).toBeGreaterThan(2000);
      expect(minChecked).toBeGreaterThan(500);
      expect(shortAllInRaise).toBeGreaterThan(0); // všichni testovaní hráči se do situace „all-in pod minimem“ opravdu dostali
    });
  }
});

describe('no limit: konkrétní situace', () => {
  const cfg = base;
  const mk = (stacks: number[]) => {
    const a = new PokertoolsAdapter(cfg);
    stacks.forEach((s, i) => a.seat(i, `p${i}`, `P${i}`, s));
    return a;
  };
  const toFlop = (a: PokertoolsAdapter) => {
    a.startHand();
    let g = 0;
    while (a.state().street === 'PREFLOP' && g++ < 10) {
      const id = actingId(a);
      a.act(id, { type: a.legalActions(id)!.canCheck ? 'check' : 'call' });
    }
  };

  it('plný all-in (bet) otevírá sázky všem, i těm, kdo už jednali', () => {
    const a = mk([1000, 1000, 1000]);
    toFlop(a);
    a.act('p1', { type: 'check' });
    a.act('p2', { type: 'check' });
    a.act('p0', { type: 'bet', amount: 50 });
    a.act('p1', { type: 'allIn' }); // p1 zvedá na 1000
    expect(a.legalActions('p2')!.canRaise).toBe(false); // p2 nemá nad dorovnání nic (stejný stack)
    a.act('p2', { type: 'call' });
    const l = a.legalActions('p0')!;
    expect(l.callAmount).toBe(940); // stacky po flopu 990, p1 je all-in
    expect(l.canRaise).toBe(false); // už nemá víc než dorovnání
  });

  it('krátký all-in po checku: ti, kdo ještě nejednali i ti, kdo checkli, smějí zvyšovat', () => {
    const a = mk([1000, 1000, 1000, 40]);
    toFlop(a);
    // p1 (SB) a p2 (BB) jednají první, p3 má krátký stack
    const order: string[] = [];
    let g = 0;
    while (a.state().street === 'FLOP' && order.length < 1 && g++ < 5) {
      const id = actingId(a);
      order.push(id);
      a.act(id, { type: 'check' });
    }
    // další hráč jde krátce all-in (bet menší než big blind není možný; all-in 40 je plný bet)
    const next = actingId(a);
    if (next === 'p3') {
      a.act('p3', { type: 'allIn' });
      // kdo checkl, může zvyšovat (bet 40 je plný bet)
      const first = order[0]!;
      const after = a.state().players.find((p) => p.playerId === first)!;
      expect(a.legalActions(actingId(a))!.canRaise).toBe(true);
      expect(after.stack).toBeGreaterThan(40);
    }
  });

  it('všichni ostatní jsou all-in a hráč má víc: smí už jen dorovnat, nic se neztratí', () => {
    const a = mk([1000, 100, 100]);
    a.startHand();
    let g = 0;
    while (!a.state().finished && a.state().actingSeat != null && g++ < 20) {
      const id = actingId(a);
      a.act(id, { type: 'allIn' });
    }
    const st = a.state();
    // po konci handy jsou výhry už ve stacích, před koncem je část žetonů v potu
    const total = st.finished ? st.players.reduce((n, p) => n + p.stack, 0) : st.players.reduce((n, p) => n + p.stack + p.invested, 0) + st.deadMoney;
    expect(total).toBe(1200);
  });
});
