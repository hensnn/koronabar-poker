import { evaluate, getCardCode } from '@pokertools/evaluator';
import { describeHand } from './hand-names.js';
import type { Card, HandState } from './types.js';

/** Rake a jackpoty: čisté výpočty z výsledku handy. Peníze pohybuje až stůl přes účetní knihu. */

export interface RakeRules {
  enabled: boolean;
  percent: number;
  /** Strop v žetonech (0 = bez stropu). */
  capChips: number;
  noFlopNoDrop: boolean;
  /** Žetonů na jednotku měny: rake je vždy celý násobek, aby šel zapsat do knihy. */
  rate: number;
}

export interface RakeResult {
  /** Celkem strženo v žetonech (násobek kurzu). */
  total: number;
  /** Kolik rake který hráč „zaplatil“ do potu: poměrně podle toho, kolik do potu vložil (základ rakebacku). */
  contrib: Map<string, number>;
  /** Kolik se komu strhává z výhry (podle id hráče). */
  byUser: Map<string, number>;
}

const NONE: RakeResult = { total: 0, byUser: new Map(), contrib: new Map() };

/**
 * Rake z právě skončené handy. Základem je pot bez nevyrovnané sázky, která se vrací. „No flop, no drop“:
 * handa bez flopu se nezpoplatňuje. Strhává se z výher poměrně podle výše výhry.
 */
export function computeRake(h: HandState, rules: RakeRules): RakeResult {
  if (!rules.enabled || rules.percent <= 0 || !h.finished || !h.winners || h.winners.length === 0) return NONE;
  if (rules.noFlopNoDrop && h.board.length < 3) return NONE;
  const invested = h.players.map((p) => p.invested + p.dead);
  const total = invested.reduce((a, b) => a + b, 0);
  const sorted = [...invested].sort((a, b) => b - a);
  const uncalled = Math.max(0, (sorted[0] ?? 0) - (sorted[1] ?? 0));
  const pot = total - uncalled;
  const winnings = new Map<string, number>();
  for (const w of h.winners) {
    const p = h.players.find((x) => x.seat === w.seat);
    if (p) winnings.set(p.playerId, (winnings.get(p.playerId) ?? 0) + w.amount);
  }
  // Vracená nevyrovnaná sázka se nezpoplatňuje.
  if (uncalled > 0) {
    const topIdx = invested.indexOf(sorted[0]!);
    const top = h.players[topIdx];
    if (top && winnings.has(top.playerId)) winnings.set(top.playerId, Math.max(0, winnings.get(top.playerId)! - uncalled));
  }
  const rakeable = [...winnings.values()].reduce((a, b) => a + b, 0);
  let rake = Math.floor((Math.min(pot, rakeable) * rules.percent) / 100);
  if (rules.capChips > 0) rake = Math.min(rake, rules.capChips);
  rake = Math.floor(rake / rules.rate) * rules.rate;
  if (rake <= 0 || rakeable <= 0) return NONE;

  const byUser = new Map<string, number>();
  let given = 0;
  const entries = [...winnings.entries()].filter(([, w]) => w > 0);
  for (const [id, w] of entries) {
    const share = Math.floor((rake * w) / rakeable);
    byUser.set(id, share);
    given += share;
  }
  // Zbytek po zaokrouhlení nese největší výherce.
  const biggest = entries.sort((a, b) => b[1] - a[1])[0]![0];
  byUser.set(biggest, (byUser.get(biggest) ?? 0) + (rake - given));
  const contrib = new Map<string, number>();
  if (total > 0) for (const p of h.players) contrib.set(p.playerId, Math.floor((rake * (p.invested + p.dead)) / total));
  return { total: rake, byUser, contrib };
}

// ---------- jackpoty ----------

export type HandCategory = 'royalFlush' | 'straightFlush' | 'quads' | 'other';

export interface Showdowner {
  userId: string;
  hole: [Card, Card];
  /** Skóre nejlepší pětice (nižší = lepší). */
  score: number;
  category: HandCategory;
  /** Obě karty z ruky jsou v nejlepší pětici. */
  usesBothHole: boolean;
  /** Překladový klíč kombinace (např. hand.fullHouse). */
  key?: string;
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

/** Vyhodnotí ruku proti stolu: nejlepší pětice, její kategorie a zda v ní hrají obě karty z ruky. */
export function assess(hole: [Card, Card], board: Card[]): Omit<Showdowner, 'userId'> | null {
  if (board.length < 5) return null;
  let best = Infinity;
  let bestBoth = false;
  let bestCards: Card[] = [];
  for (const five of combos5([...hole, ...board])) {
    const score = evaluate(five.map((c) => getCardCode(c)));
    const both = hole.every((c) => five.includes(c));
    if (score < best) {
      best = score;
      bestBoth = both;
      bestCards = five;
    } else if (score === best && both) bestBoth = true;
  }
  const key = describeHand(bestCards)?.key;
  const category: HandCategory = key === 'hand.royalFlush' ? 'royalFlush' : key === 'hand.straightFlush' ? 'straightFlush' : key === 'hand.quads' ? 'quads' : 'other';
  return { hole, score: best, category, usesBothHole: bestBoth, key: key ?? 'hand.highCard' };
}

export interface JackpotRules {
  royalFlush: { enabled: boolean; percent: number };
  badBeat: { enabled: boolean; percent: number; minHand: 'quads' | 'straightFlush'; loserShare: number; winnerShare: number };
}

export interface JackpotAward {
  kind: 'royalFlush' | 'badBeat';
  /** Výplata v měně podle hráče. */
  payouts: Map<string, number>;
}

/**
 * Vyplácení jackpotů po showdownu. `fund` je aktuální stav jackpotového fondu v měně,
 * vrací se pole výplat (každá výplata se počítá z již zmenšeného fondu).
 */
export function jackpotAwards(h: HandState, rules: JackpotRules, fund: number): JackpotAward[] {
  if (fund <= 0 || h.board.length < 5) return [];
  const live = h.players.filter((p) => p.hole && p.status !== 'folded' && p.status !== 'sittingOut');
  if (live.length < 2) return [];
  const shown: Showdowner[] = [];
  for (const p of live) {
    const a = assess(p.hole!, h.board);
    if (a) shown.push({ userId: p.playerId, ...a });
  }
  const wonSeats = new Set((h.winners ?? []).filter((w) => w.amount > 0).map((w) => w.seat));
  const winners = shown.filter((s) => wonSeats.has(h.players.find((p) => p.playerId === s.userId)!.seat));
  const losers = shown.filter((s) => !winners.includes(s));
  const out: JackpotAward[] = [];
  let left = fund;

  if (rules.royalFlush.enabled) {
    const royal = shown.filter((s) => s.category === 'royalFlush' && s.usesBothHole);
    if (royal.length > 0) {
      const total = Math.floor((left * rules.royalFlush.percent) / 100);
      if (total > 0) {
        const payouts = splitEven(total, royal.map((r) => r.userId));
        out.push({ kind: 'royalFlush', payouts });
        left -= total;
      }
    }
  }

  if (rules.badBeat.enabled && winners.length > 0) {
    const min = rules.badBeat.minHand === 'straightFlush' ? ['straightFlush', 'royalFlush'] : ['quads', 'straightFlush', 'royalFlush'];
    const loser = losers.filter((l) => min.includes(l.category) && l.usesBothHole).sort((a, b) => a.score - b.score)[0];
    const winner = loser ? winners.filter((w) => w.usesBothHole && w.score < loser.score).sort((a, b) => a.score - b.score)[0] : undefined;
    if (loser && winner) {
      const total = Math.floor((left * rules.badBeat.percent) / 100);
      if (total > 0) {
        const payouts = new Map<string, number>();
        const loserPart = Math.floor((total * rules.badBeat.loserShare) / 100);
        const winnerPart = Math.floor((total * rules.badBeat.winnerShare) / 100);
        const others = live.map((p) => p.playerId).filter((id) => id !== loser.userId && id !== winner.userId);
        const rest = total - loserPart - winnerPart;
        payouts.set(loser.userId, loserPart);
        payouts.set(winner.userId, (payouts.get(winner.userId) ?? 0) + winnerPart);
        if (others.length > 0) {
          for (const [id, v] of splitEven(rest, others)) payouts.set(id, (payouts.get(id) ?? 0) + v);
        } else payouts.set(loser.userId, payouts.get(loser.userId)! + rest);
        out.push({ kind: 'badBeat', payouts });
        left -= total;
      }
    }
  }
  return out;
}

function splitEven(total: number, ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const share = Math.floor(total / ids.length);
  let rest = total - share * ids.length;
  for (const id of ids) {
    out.set(id, share + (rest > 0 ? 1 : 0));
    if (rest > 0) rest--;
  }
  return out;
}
