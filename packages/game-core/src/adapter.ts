import { ActionType, IllegalActionError, PokerEngine } from '@pokertools/engine';
import { evaluate, getCardCode } from '@pokertools/evaluator';
import {
  GameError,
  type Card,
  type HandPlayer,
  type HandState,
  type LegalActions,
  type PlayerAction,
  type SeatStatus,
  type Street,
} from './types.js';

/** Co se má při rozdání navíc zaplatit (zadávají moduly). */
export interface DealPlan {
  /** Bomb pot: po rozdání se preflop automaticky dorovná a hraje se od flopu. */
  bombPot?: boolean;
  /** Straddle: UTG nebo Mississippi. Bez `optInPlayerIds` je povinný. */
  straddle?: { type: 'utg' | 'mississippi'; amount: number; optInPlayerIds?: string[] };
  /** Mrtvé peníze do potu (big blind ante, dead blind). Získá je vítěz hlavního potu. */
  deadMoney?: { payer: 'bb' | { playerId: string }; amount: number }[];
}

export interface SeatOptions {
  /** Hráč smí hrát až od big blindu. */
  waitForBb?: boolean;
}

export interface EngineConfig {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  maxPlayers: number;
  timeBankSeconds: number;
  /** Dodavatel náhody v rozsahu [0,1). Výchozí je kryptografický RNG enginu. */
  randomProvider?: () => number;
}

/**
 * Rozhraní enginu. Za ním je dnes `@pokertools/engine`; výměna enginu = nová implementace
 * a stejná sada kontrolních testů (adapter.contract.test.ts).
 */
export interface PokerEngineAdapter {
  seat(seat: number, playerId: string, name: string, chips: number, opts?: SeatOptions): void;
  unseat(playerId: string): void;
  /** Žetony hráče u stolu (mimo handu, nebo po handě). */
  stackOf(playerId: string): number | null;
  seatedCount(): number;
  canStartHand(): boolean;
  startHand(plan?: DealPlan): void;
  act(playerId: string, action: PlayerAction): void;
  legalActions(playerId: string): LegalActions | null;
  /** Serverový stav (včetně skrytých karet). */
  state(): HandState;
  /** Zbývající karty balíčku (jen server; pro šance na výhru a run it twice). */
  remainingDeck(): Card[];
  setBlinds(smallBlind: number, bigBlind: number, ante: number): void;
  /** Sázkový limit: no-limit (výchozí), pot-limit nebo fixed-limit s nejvýš `maxBets` sázkami na kolo. */
  setLimit(mode: 'noLimit' | 'potLimit' | 'fixedLimit', maxBets: number): void;
  snapshot(): unknown;
}

const STATUS: Record<string, SeatStatus> = {
  ACTIVE: 'active',
  FOLDED: 'folded',
  ALL_IN: 'allIn',
  SITTING_OUT: 'sittingOut',
};

const mapMapOrObject = (m: unknown): Record<number, number> => {
  if (m instanceof Map) return Object.fromEntries(m) as Record<number, number>;
  return (m ?? {}) as Record<number, number>;
};

/** Karty enginu jsou v balíčku jako číselné kódy; převod na text řeší knihovna. */
export class PokertoolsAdapter implements PokerEngineAdapter {
  private engine: PokerEngine;
  private cfg: EngineConfig;
  private waiting = new Map<string, boolean>();
  /** Mrtvé peníze aktuální handy: kdo kolik zaplatil. */
  private dead = new Map<string, number>();
  private deadAward: Map<string, number> | null = null;
  private straddleSeat: number | null = null;
  private limit: { mode: 'noLimit' | 'potLimit' | 'fixedLimit'; maxBets: number } = { mode: 'noLimit', maxBets: 4 };
  /** Kolik sázek a zvýšení už v aktuálním kole proběhlo (mimo blindy). */
  private aggressions = 0;

  constructor(cfg: EngineConfig, restore?: unknown) {
    this.cfg = cfg;
    this.engine = restore
      ? PokerEngine.restore(restore as never)
      : new PokerEngine({
          smallBlind: cfg.smallBlind,
          bigBlind: cfg.bigBlind,
          ante: cfg.ante,
          maxPlayers: cfg.maxPlayers,
          timeBankSeconds: cfg.timeBankSeconds,
          validateIntegrity: true,
          ...(cfg.randomProvider ? { randomProvider: cfg.randomProvider } : {}),
        } as never);
  }

  private get raw(): any {
    return this.engine.state;
  }

  seat(seat: number, playerId: string, name: string, chips: number, opts: SeatOptions = {}): void {
    this.waiting.set(playerId, !!opts.waitForBb);
    this.sitRaw(seat, playerId, name, chips, !!opts.waitForBb);
  }
  private sitRaw(seat: number, playerId: string, name: string, chips: number, waitForBb: boolean): void {
    this.wrap(() =>
      this.dispatch({
        type: ActionType.SIT,
        playerId,
        playerName: name,
        seat,
        stack: chips,
        ...(waitForBb ? { sitInOption: 'WAIT_FOR_BB' } : {}),
        timestamp: this.now(),
      } as never),
    );
  }
  private dispatch(action: unknown): void {
    (this.engine as unknown as { dispatch(a: unknown): void }).dispatch(action);
  }
  private now(): number {
    return (this.engine as unknown as { timeProvider: () => number }).timeProvider();
  }
  unseat(playerId: string): void {
    this.wrap(() => this.engine.stand(playerId));
    this.waiting.delete(playerId);
    // Podíl na mrtvých penězích je vyplacen odchodem hráče; `dead` zůstává do další handy (ostatní ho ještě čtou).
    this.deadAward?.delete(playerId);
  }
  stackOf(playerId: string): number | null {
    const p = (this.raw.players as any[]).find((x) => x?.id === playerId);
    if (!p) return null;
    return p.stack + (this.awardFor(playerId) ?? 0);
  }
  seatedCount(): number {
    return (this.raw.players as any[]).filter(Boolean).length;
  }
  canStartHand(): boolean {
    const s = this.raw;
    const inProgress = s.street !== 'SHOWDOWN' && s.handNumber > 0 && !s.winners;
    if (inProgress) return false;
    const funded = (s.players as any[]).filter((p) => p && p.stack > 0 && !p.isSittingOut);
    return funded.length >= 2;
  }
  startHand(plan: DealPlan = {}): void {
    this.dead = new Map();
    this.deadAward = null;
    // Mrtvé peníze se strhnou hráči před rozdáním (znovu usazen na stejné místo, pozice se nemění).
    const bbPlayer = (plan.deadMoney ?? []).some((d) => d.payer === 'bb') ? this.peekBigBlindPlayer() : null;
    for (const d of plan.deadMoney ?? []) {
      const id = d.payer === 'bb' ? bbPlayer : d.payer.playerId;
      if (!id || d.amount <= 0) continue;
      const p = (this.raw.players as any[]).find((x) => x?.id === id);
      if (!p) continue;
      const pay = Math.min(d.amount, Math.max(0, p.stack - 1));
      if (pay <= 0) continue;
      this.wrap(() => this.engine.stand(id));
      this.sitRaw(p.seat, id, p.name, p.stack - pay, !!this.waiting.get(id));
      this.dead.set(id, (this.dead.get(id) ?? 0) + pay);
    }
    this.wrap(() =>
      this.dispatch({
        type: ActionType.DEAL,
        timestamp: this.now(),
        ...(plan.straddle ? { straddle: plan.straddle } : {}),
      } as never),
    );
    this.aggressions = 0;
    this.straddleSeat = null;
    for (const p of this.raw.players as any[]) if (p && p.betThisStreet > this.raw.bigBlind) this.straddleSeat = p.seat;
    // Hráči, kteří čekají na big blind a nebyli dealt, zůstanou v čekání; ostatním se příznak smaže.
    for (const p of this.raw.players as any[]) if (p?.hand && p.hand.length === 2) this.waiting.set(p.id, false);
  }

  /** Kdo bude na big blindu: zkušební rozdání na kopii enginu (pozice nezávisí na zamíchání). */
  private peekBigBlindPlayer(): string | null {
    try {
      const clone = PokerEngine.restore(JSON.parse(JSON.stringify(this.engine.snapshot)) as never);
      clone.deal();
      const st: any = clone.state;
      return st.bigBlindSeat != null ? (st.players[st.bigBlindSeat]?.id ?? null) : null;
    } catch {
      return null;
    }
  }

  private awardFor(playerId: string): number | undefined {
    const s = this.raw;
    if (!(s.winners || s.street === 'SHOWDOWN') || this.dead.size === 0) return undefined;
    if (!this.deadAward) this.deadAward = this.computeDeadAward();
    return this.deadAward.get(playerId);
  }

  /** Mrtvé peníze získá vítěz (vítězové) hlavního potu: nejlepší ruka z nesložených hráčů. */
  private computeDeadAward(): Map<string, number> {
    const s = this.raw;
    const total = [...this.dead.values()].reduce((a, b) => a + b, 0);
    const live = (s.players as any[]).filter((p) => p && p.hand && p.hand.length === 2 && p.status !== 'FOLDED');
    const award = new Map<string, number>();
    if (live.length === 0 || total === 0) return award;
    let winners = live;
    if (live.length > 1 && s.board.length === 5) {
      const score = (p: any) => evaluate([...p.hand, ...s.board].map(getCardCode));
      const best = Math.min(...live.map(score));
      winners = live.filter((p) => score(p) === best);
    }
    const share = Math.floor(total / winners.length);
    let rest = total - share * winners.length;
    for (const p of winners) {
      award.set(p.id, share + (rest > 0 ? 1 : 0));
      if (rest > 0) rest--;
    }
    return award;
  }

  setLimit(mode: 'noLimit' | 'potLimit' | 'fixedLimit', maxBets: number): void {
    this.limit = { mode, maxBets };
  }

  private highestBet(): number {
    return Math.max(0, ...Object.values(mapMapOrObject(this.raw.currentBets)));
  }

  act(playerId: string, a: PlayerAction): void {
    const legal = this.legalActions(playerId);
    // V limitové hře smí sázka a zvýšení mít jen povolenou výši; „all-in“ znamená největší povolenou sázku.
    if (this.limit.mode !== 'noLimit' && legal && (a.type === 'bet' || a.type === 'raise')) {
      if (!(legal.canBet || legal.canRaise) || a.amount < legal.minRaiseTo || a.amount > legal.maxRaiseTo) throw new GameError('INVALID_AMOUNT', undefined, { min: legal.minRaiseTo, max: legal.maxRaiseTo });
    }
    const streetBefore = this.raw.street as string;
    const betBefore = this.highestBet();
    this.actRaw(playerId, a, legal);
    if (this.raw.street !== streetBefore) this.aggressions = 0;
    else if (this.highestBet() > betBefore) this.aggressions++;
  }

  private actRaw(playerId: string, a: PlayerAction, legal: LegalActions | null): void {
    this.wrap(() => {
      switch (a.type) {
        case 'fold':
          return this.engine.act({ type: ActionType.FOLD, playerId } as never);
        case 'check':
          return this.engine.act({ type: ActionType.CHECK, playerId } as never);
        case 'call':
          return this.engine.act({ type: ActionType.CALL, playerId } as never);
        case 'bet':
          return this.engine.act({ type: ActionType.BET, playerId, amount: a.amount } as never);
        case 'raise':
          return this.engine.act({ type: ActionType.RAISE, playerId, amount: a.amount } as never);
        case 'allIn': {
          if (!legal) throw new GameError('NOT_YOUR_TURN');
          if (!legal.canBet && !legal.canRaise) return this.engine.act({ type: ActionType.CALL, playerId } as never);
          const type = legal.canBet ? ActionType.BET : ActionType.RAISE;
          return this.engine.act({ type, playerId, amount: legal.maxRaiseTo } as never);
        }
      }
    });
  }

  legalActions(playerId: string): LegalActions | null {
    const s = this.raw;
    if (s.winners || s.street === 'SHOWDOWN' || s.actionTo == null) return null;
    const p = s.players[s.actionTo];
    if (!p || p.id !== playerId) return null;
    const bets = mapMapOrObject(s.currentBets);
    // Krátký all-in blind nesnižuje povinnost dorovnat plný big blind před flopem.
    const currentBet = Math.max(s.street === 'PREFLOP' ? s.bigBlind : 0, ...Object.values(bets));
    const myBet = p.betThisStreet as number;
    const toCall = Math.max(0, currentBet - myBet);
    const maxRaiseTo = p.stack + myBet;
    const callAmount = Math.min(toCall, p.stack);
    const opened = currentBet > 0;
    const maxType = opened ? ActionType.RAISE : ActionType.BET;
    // Zda smí hráč zvyšovat, rozhoduje engine (např. sázky nejsou znovu otevřeny po neúplném raise).
    const canAggress =
      p.stack > toCall && (this.engine.validate({ type: maxType, playerId, amount: maxRaiseTo } as never) as { valid: boolean }).valid;
    // Minimální sázka: u betu big blind, u raise podle enginu; vždy nejvýš všechny žetony.
    let minTo = Math.min(opened ? s.minRaise : Math.max(s.bigBlind, 0), maxRaiseTo);
    let maxTo = maxRaiseTo;
    let allowed = canAggress;
    if (this.limit.mode === 'fixedLimit') {
      // Fixed-limit: jedna povolená výše (small bet před flopem a na flopu, big bet na turnu a riveru).
      const size = s.street === 'PREFLOP' || s.street === 'FLOP' ? s.bigBlind : 2 * s.bigBlind;
      const target = Math.min(opened ? currentBet + size : size, maxRaiseTo);
      minTo = target;
      maxTo = target;
      const cap = s.street === 'PREFLOP' ? this.limit.maxBets - 1 : this.limit.maxBets;
      if (this.aggressions >= cap) allowed = false;
    } else if (this.limit.mode === 'potLimit') {
      // Pot-limit: nejvíc o velikost potu po dorovnání.
      const pot = (s.players as any[]).reduce((n, x) => n + (x?.totalInvestedThisHand ?? 0), 0) + [...this.dead.values()].reduce((a, b) => a + b, 0);
      maxTo = Math.min(maxRaiseTo, currentBet + pot + toCall);
      minTo = Math.min(minTo, maxTo);
    }
    return {
      canFold: true,
      canCheck: toCall === 0 && (this.engine.validate({ type: ActionType.CHECK, playerId } as never) as { valid: boolean }).valid,
      callAmount,
      canBet: allowed && !opened,
      canRaise: allowed && opened,
      minRaiseTo: minTo,
      maxRaiseTo: maxTo,
    };
  }

  setBlinds(smallBlind: number, bigBlind: number, ante: number): void {
    // Engine drží blindy ve stavu; mění se jen mezi handami (změna se projeví od další handy).
    const s = this.raw as { smallBlind: number; bigBlind: number; ante: number };
    s.smallBlind = smallBlind;
    s.bigBlind = bigBlind;
    s.ante = ante;
    this.cfg = { ...this.cfg, smallBlind, bigBlind, ante };
  }

  state(): HandState {
    const s = this.raw;
    const bets = mapMapOrObject(s.currentBets);
    const players: HandPlayer[] = [];
    (s.players as any[]).forEach((p, seat) => {
      if (!p) return;
      const hole = p.hand && p.hand.length === 2 ? ([p.hand[0], p.hand[1]] as [Card, Card]) : null;
      players.push({
        seat,
        playerId: p.id,
        name: p.name,
        stack: p.stack + (this.awardFor(p.id) ?? 0),
        bet: p.betThisStreet ?? 0,
        invested: p.totalInvestedThisHand ?? 0,
        status: p.isSittingOut ? 'sittingOut' : (STATUS[p.status] ?? 'sittingOut'),
        hole,
        timeBank: p.timeBank ?? 0,
        dead: this.dead.get(p.id) ?? 0,
      });
    });
    const deadTotal = [...this.dead.values()].reduce((a, b) => a + b, 0);
    const finished = !!s.winners || s.street === 'SHOWDOWN';
    const winners = s.winners
      ? (s.winners as any[]).map((w) => {
          const pl = (s.players as any[])[w.seat];
          return {
            seat: w.seat as number,
            amount: w.amount as number,
            handName: (w.handRank as string) ?? null,
            cards: (w.hand as Card[]) ?? null,
            _p: pl,
          };
        })
      : null;
    const winnersOut: NonNullable<HandState['winners']> | null = winners?.map(({ _p, ...w }) => w) ?? null;
    if (winnersOut && this.deadAward) {
      for (const [id, amount] of this.deadAward) {
        const seat = (s.players as any[]).findIndex((x) => x?.id === id);
        const entry = winnersOut.find((w) => w.seat === seat);
        if (entry) entry.amount += amount;
        else if (seat >= 0) winnersOut.push({ seat, amount, handName: null, cards: null });
      }
    }
    const pots = (s.pots as any[]).map((p) => ({ amount: p.amount, eligibleSeats: [...p.eligibleSeats] }));
    if (!finished && deadTotal > 0) {
      if (pots[0]) pots[0] = { ...pots[0], amount: pots[0].amount + deadTotal };
      else pots.push({ amount: deadTotal, eligibleSeats: players.filter((p) => p.hole).map((p) => p.seat) });
    }
    return {
      handId: s.handId,
      handNumber: s.handNumber,
      street: s.street as Street,
      board: [...s.board],
      buttonSeat: s.buttonSeat,
      actingSeat: finished ? null : s.actionTo,
      players,
      pots,
      winners: winnersOut,
      finished,
      minRaiseTo: s.minRaise,
      currentBet: Math.max(s.street === 'PREFLOP' ? s.bigBlind : 0, ...Object.values(bets)),
      deadMoney: deadTotal,
      straddleSeat: this.straddleSeat,
    };
  }

  remainingDeck(): Card[] {
    const deck = this.raw.deck as number[];
    // Převod číselných kódů na text: knihovna enginu používá stejné kódování jako evaluátor.
    return deck.map(codeToCard);
  }

  snapshot(): unknown {
    return JSON.parse(JSON.stringify(this.engine.snapshot));
  }

  private wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof IllegalActionError) {
        throw new GameError(String((e as any).code ?? 'ILLEGAL_ACTION'), e.message, (e as any).context);
      }
      throw e;
    }
  }

  static restore(cfg: EngineConfig, snapshot: unknown): PokertoolsAdapter {
    return new PokertoolsAdapter(cfg, snapshot);
  }
}

import { stringifyCardCode } from '@pokertools/evaluator';
const codeToCard = (c: number): Card => stringifyCardCode(c);
