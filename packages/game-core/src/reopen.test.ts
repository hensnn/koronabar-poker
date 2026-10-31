import { describe, it, expect } from 'vitest';
import { PokertoolsAdapter } from './adapter.js';
import { seededRandom, randomLegalAction } from './bot.js';

// Znovuotevření sázení po all-inu: kdo už jednal, smí zvyšovat jen když ho zvýšení o plnou hodnotu (nebo součet krátkých all-inů) opravdu otevřelo.
const cfg = { smallBlind: 5, bigBlind: 10, ante: 0, maxPlayers: 9, timeBankSeconds: 30 };

function table(stacks: number[]) {
  const a = new PokertoolsAdapter(cfg);
  stacks.forEach((s, i) => a.seat(i, `p${i}`, `P${i}`, s));
  return a;
}
const actingId = (a: PokertoolsAdapter) => a.state().players.find((p) => p.seat === a.state().actingSeat)!.playerId;
const total = (a: PokertoolsAdapter) => a.state().players.reduce((n, p) => n + p.stack + p.invested, 0) + a.state().deadMoney;

/** Preflop všichni dorovnají / checknou, takže na flopu je pot 30 a hraje se postflop. První na tahu je small blind (p1). */
function toFlop(a: PokertoolsAdapter) {
  a.startHand();
  let guard = 0;
  while (a.state().street === 'PREFLOP' && guard++ < 10) {
    const id = actingId(a);
    a.act(id, { type: a.legalActions(id)!.canCheck ? 'check' : 'call' });
  }
  expect(a.state().street).toBe('FLOP');
}

describe('znovuotevření sázení po all-inu (3 hráči, stack p2 je krátký)', () => {
  it('bet 100, soupeř jde all-in krátce (celkem 140 = zvýšení o 40, neúplné): původní bettor smí jen dorovnat nebo složit', () => {
    const a = table([1000, 1000, 150]);
    toFlop(a);
    expect(actingId(a)).toBe('p1');
    a.act('p1', { type: 'bet', amount: 100 });
    // p2 (zbývá 140) nemá na plný raise (min. 200): jde all-in
    // all-in pod minimálním zvýšením je legální (jediná možná výše = všechno), ale zvýšení neotevírá
    const l2 = a.legalActions('p2')!;
    expect(l2.minRaiseTo).toBe(l2.maxRaiseTo);
    a.act('p2', { type: 'allIn' });
    // p0 ještě nejednal a vidí sázku 100 + neúplné zvýšení; smí zvyšovat
    expect(actingId(a)).toBe('p0');
    a.act('p0', { type: 'call' });
    // p1 jednal před krátkým all-inem: raise mu otevřený není
    const l = a.legalActions('p1')!;
    expect(l.callAmount).toBe(40);
    expect(l.canRaise).toBe(false);
    // i přímý pokus o zvýšení (obejití klienta) server odmítne a stav se nezmění
    expect(() => a.act('p1', { type: 'raise', amount: 400 })).toThrow();
    expect(actingId(a)).toBe('p1');
    a.act('p1', { type: 'call' });
    expect(a.state().street).toBe('TURN');
    expect(total(a)).toBe(2150);
  });

  it('bet 100, soupeř jde all-in na plný raise (celkem 250, zvýšení o 150): původní bettor smí znovu zvyšovat', () => {
    const a = table([1000, 1000, 260]);
    toFlop(a);
    a.act('p1', { type: 'bet', amount: 100 });
    a.act('p2', { type: 'allIn' });
    a.act('p0', { type: 'call' });
    const l = a.legalActions('p1')!;
    expect(l.callAmount).toBe(150);
    expect(l.canRaise).toBe(true);
    expect(l.minRaiseTo).toBeGreaterThanOrEqual(400);
  });

  it('bet 100, soupeř dorovná all-inem za méně (nižší než sázka): nikdo další nezvyšuje, bettor už nedostane tah, hand běží dál', () => {
    const a = table([1000, 1000, 80]);
    toFlop(a);
    a.act('p1', { type: 'bet', amount: 100 });
    const l2 = a.legalActions('p2')!;
    expect(l2.callAmount).toBe(70);
    expect(l2.canRaise).toBe(false);
    a.act('p2', { type: 'allIn' });
    a.act('p0', { type: 'call' });
    // bettor má všechno dorovnané; hand pokračuje na turn
    expect(a.state().street).toBe('TURN');
    expect(actingId(a)).toBe('p1');
    expect(total(a)).toBe(2080);
  });

  it('raise a dorovnání all-inem za méně u heads-upu: raiser nedostane další tah a hand se dohraje', () => {
    const a = table([1000, 80]);
    a.startHand();
    // heads-up: button = small blind (p0) jedná první
    const first = actingId(a);
    a.act(first, { type: 'raise', amount: 100 });
    const other = actingId(a);
    const l = a.legalActions(other)!;
    expect(l.canRaise).toBe(false);
    a.act(other, { type: 'allIn' });
    // nikdo další nemá co dělat: žádný hráč nemá tah, ruka běží do showdownu
    let guard = 0;
    while (!a.state().finished && a.state().actingSeat != null && guard++ < 5) a.act(actingId(a), { type: 'check' });
    expect(a.state().finished || a.state().actingSeat == null).toBe(true);
    if (a.state().finished) expect(a.state().players.reduce((n, p) => n + p.stack, 0)).toBe(1080);
    else expect(total(a)).toBe(1080);
  });

  it('dva krátké all-iny dohromady dávají plné zvýšení (100 → 150 → 200): kdo jednal dřív, smí zvyšovat (pravidlo TDA)', () => {
    const a = table([1000, 1000, 160, 210]);
    a.startHand();
    // 4 hráči: UTG = p3, pak p0 (button), p1 (SB), p2 (BB)
    let guard = 0;
    while (a.state().street === 'PREFLOP' && guard++ < 10) {
      const id = actingId(a);
      a.act(id, { type: a.legalActions(id)!.canCheck ? 'check' : 'call' });
    }
    expect(a.state().street).toBe('FLOP');
    // flop: p1 bet 100, p2 (zbývá 150) all-in 150 = +50 neúplné, p3 (zbývá 200) all-in 200 = +50 neúplné; dohromady +100 = plné zvýšení
    a.act('p1', { type: 'bet', amount: 100 });
    a.act('p2', { type: 'allIn' });
    a.act('p3', { type: 'allIn' });
    a.act('p0', { type: 'call' });
    const l = a.legalActions('p1')!;
    expect(l.callAmount).toBe(100);
    expect(l.canRaise).toBe(true);
    expect(total(a)).toBe(2370);
  });
});

describe('znovuotevření: náhodné hry s krátkými stacky proti nezávislému výpočtu pravidla', () => {
  it('canRaise odpovídá pravidlu (zvýšení od posledního tahu hráče ≥ poslední plné zvýšení) a žetony se zachovají', () => {
    let checked = 0;
    let denied = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rnd = seededRandom(seed);
      const n = 2 + (seed % 5);
      const a = table(Array.from({ length: n }, () => 30 + Math.floor(rnd() * 400)));
      const sum = total(a);
      a.startHand();
      let street = a.state().street;
      let cur = a.state().currentBet;
      let minInc = cfg.bigBlind;
      let acted = new Map<string, number>();
      let guard = 0;
      while (!a.state().finished && a.state().actingSeat != null && guard++ < 200) {
        const id = actingId(a);
        const me = a.state().players.find((p) => p.playerId === id)!;
        const l = a.legalActions(id)!;
        const toCall = cur - me.bet;
        if (!(a.state().street !== street)) {
          const should = me.stack > toCall && (!acted.has(id) || cur - acted.get(id)! >= minInc);
          const can = l.canRaise || l.canBet;
          checked++;
          if (!should && me.stack > toCall) denied++;
          expect(can, `seed ${seed}, ${id}, cur ${cur}, minInc ${minInc}, naposledy na ${acted.get(id)}`).toBe(should);
        }
        a.act(id, randomLegalAction(l, rnd));
        const s2 = a.state();
        if (s2.street !== street) {
          street = s2.street;
          cur = 0;
          minInc = cfg.bigBlind;
          acted = new Map();
          continue;
        }
        if (s2.currentBet > cur) {
          const inc = s2.currentBet - cur;
          if (inc >= minInc) minInc = inc;
          cur = s2.currentBet;
        }
        acted.set(id, cur);
        if (!s2.finished) expect(total(a)).toBe(sum);
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(denied).toBeGreaterThan(0);
  });
});
