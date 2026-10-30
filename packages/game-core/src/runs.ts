import { evaluate, getCardCode } from '@pokertools/evaluator';
import { describeHand, type HandDescription } from './hand-names.js';
import { computeSidePots } from './pots.js';
import type { Card, HandState } from './types.js';

/**
 * Run it twice / třikrát: board se dokládá vícekrát ze zbytku téhož balíčku a každý pot se dělí
 * mezi běhy (lichý žeton dostane první běh). Počítá se z výsledku skutečně odehrané handy,
 * takže dělení potů, nevyrovnaná sázka i mrtvé peníze odpovídají tomu, co se dělo u stolu.
 */

export interface RunResult {
  board: Card[];
  winners: { seat: number; amount: number; hand: HandDescription | null }[];
}

export interface RunsOutcome {
  runs: RunResult[];
  /** Co kdo vyhrál celkem, podle sedadla (včetně vrácené nevyrovnané sázky). */
  winnings: Map<number, number>;
}

function combos5(cards: Card[]): Card[][] {
  const out: Card[][] = [];
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++) for (let e = d + 1; e < n; e++) out.push([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
  return out;
}

/** Nejlepší pětice z karet v ruce a na boardu (nižší skóre je lepší). */
export function bestFive(hole: [Card, Card], board: Card[]): { score: number; cards: Card[] } {
  let best = Infinity;
  let cards: Card[] = [];
  for (const five of combos5([...hole, ...board])) {
    const score = evaluate(five.map((c) => getCardCode(c)));
    if (score < best) {
      best = score;
      cards = five;
    }
  }
  return { score: best, cards };
}

/**
 * Doplní další boardy: u každého běhu zůstávají karty, které už byly na stole v době all-inu (`prefix`),
 * chybějící karty se berou postupně ze zbytku balíčku.
 */
export function extraBoards(firstBoard: Card[], prefix: number, deck: Card[], runs: number): Card[][] | null {
  const need = 5 - prefix;
  if (need <= 0 || firstBoard.length < 5) return null;
  if (deck.length < need * (runs - 1)) return null;
  const boards: Card[][] = [firstBoard];
  for (let r = 1; r < runs; r++) boards.push([...firstBoard.slice(0, prefix), ...deck.slice((r - 1) * need, r * need)]);
  return boards;
}

/** Rozdělení potů mezi běhy. `boards[0]` je board, který skutečně dorazil při hře. */
export function settleRuns(h: HandState, boards: Card[][]): RunsOutcome {
  const n = boards.length;
  const pots = computeSidePots(h);
  if (pots.length > 0 && h.deadMoney > 0) pots[0] = { ...pots[0]!, amount: pots[0]!.amount + h.deadMoney };
  const winnings = new Map<number, number>();
  const add = (seat: number, amount: number) => winnings.set(seat, (winnings.get(seat) ?? 0) + amount);

  // Nevyrovnaná sázka nejvyššího vkladu se vrací jeho majiteli.
  // Mrtvé peníze (big blind ante) nejsou sázka, kterou by šlo nevyrovnat: jdou do hlavního potu výše, nevracejí se.
  const invested = h.players.map((p) => p.invested);
  const sorted = [...invested].sort((a, b) => b - a);
  const uncalled = Math.max(0, (sorted[0] ?? 0) - (sorted[1] ?? 0));
  if (uncalled > 0) {
    const top = h.players[invested.indexOf(sorted[0]!)];
    if (top) add(top.seat, uncalled);
  }

  const runs: RunResult[] = boards.map((board) => ({ board, winners: [] }));
  const scoreOf = new Map<string, number>();
  const cardsOf = new Map<string, Card[]>();
  const rank = (seat: number, r: number) => {
    const key = `${seat}:${r}`;
    if (!scoreOf.has(key)) {
      const p = h.players.find((x) => x.seat === seat)!;
      const b = bestFive(p.hole!, boards[r]!);
      scoreOf.set(key, b.score);
      cardsOf.set(key, b.cards);
    }
    return scoreOf.get(key)!;
  };

  for (const pot of pots) {
    const base = Math.floor(pot.amount / n);
    for (let r = 0; r < n; r++) {
      const share = base + (r === 0 ? pot.amount - base * n : 0);
      if (share <= 0) continue;
      const eligible = pot.eligibleSeats.filter((s) => h.players.find((p) => p.seat === s)?.hole);
      const best = Math.min(...eligible.map((s) => rank(s, r)));
      const winners = eligible.filter((s) => rank(s, r) === best).sort((a, b) => a - b);
      const each = Math.floor(share / winners.length);
      let rest = share - each * winners.length;
      for (const seat of winners) {
        const amount = each + (rest > 0 ? 1 : 0);
        if (rest > 0) rest--;
        add(seat, amount);
        const entry = runs[r]!.winners.find((w) => w.seat === seat);
        if (entry) entry.amount += amount;
        else runs[r]!.winners.push({ seat, amount, hand: describeHand(cardsOf.get(`${seat}:${r}`)!) });
      }
    }
  }
  return { runs, winnings };
}
