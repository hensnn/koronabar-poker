/**
 * Statistiky z jedné odehrané handy (čisté funkce, bez závislostí na enginu).
 * Počítají se z posloupnosti akcí a výsledku; ukládají se u každého hráče a sčítají se do osobních statistik.
 */
export interface RecordedAction {
  userId: string;
  street: string;
  action: string;
  amount: number;
  /** Nejvyšší sázka na ulici před akcí. */
  facing: number;
}

export interface HandPlayerInput {
  userId: string;
  invested: number;
  won: number;
  status: string;
  /** Hráč došel na showdown (jeho karty se ukázaly). */
  revealed: boolean;
}

export interface PlayerHandFlags {
  vpip: boolean;
  pfr: boolean;
  /** Hráč stál proti přesně jednomu zvýšení před sebou. */
  threeBetChance: boolean;
  threeBet: boolean;
  sawFlop: boolean;
  showdown: boolean;
  wonShowdown: boolean;
  /** Počet agresivních akcí (bet/raise) a pasivních (call) po flopu, pro faktor agrese. */
  aggressive: number;
  calls: number;
}

const isAggressive = (a: RecordedAction): boolean => a.action === 'bet' || a.action === 'raise' || (a.action === 'allIn' && a.amount > a.facing);

export function analyzeHand(actions: RecordedAction[], players: HandPlayerInput[], boardCards: number): Map<string, PlayerHandFlags> {
  const out = new Map<string, PlayerHandFlags>();
  for (const p of players) out.set(p.userId, { vpip: false, pfr: false, threeBetChance: false, threeBet: false, sawFlop: false, showdown: p.revealed, wonShowdown: p.revealed && p.won > 0, aggressive: 0, calls: 0 });
  const foldedPre = new Set<string>();
  let raisesBefore = 0;
  for (const a of actions) {
    const f = out.get(a.userId);
    if (!f) continue;
    const aggressive = isAggressive(a);
    if (a.street === 'PREFLOP') {
      if (a.action === 'fold') foldedPre.add(a.userId);
      if (raisesBefore === 1 && !f.threeBetChance) {
        f.threeBetChance = true;
        if (aggressive) f.threeBet = true;
      }
      if (aggressive || (a.action === 'call' && a.amount > 0) || (a.action === 'allIn' && a.amount > 0)) f.vpip = true;
      if (aggressive) {
        f.pfr = true;
        raisesBefore++;
      }
    } else if (a.street !== 'SHOWDOWN') {
      if (aggressive) f.aggressive++;
      else if (a.action === 'call') f.calls++;
    }
  }
  for (const p of players) {
    const f = out.get(p.userId)!;
    f.sawFlop = boardCards >= 3 && !foldedPre.has(p.userId) && p.status !== 'sittingOut' && p.invested > 0;
  }
  return out;
}
