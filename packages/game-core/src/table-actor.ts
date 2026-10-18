import { randomUUID } from 'node:crypto';
import { LedgerError, type CashService } from '@kb/ledger';
import type { SettingValues } from '@kb/shared';
import { PokertoolsAdapter, type DealPlan, type PokerEngineAdapter } from './adapter.js';
import type { Clock } from './clock.js';
import { computeOdds } from './odds.js';
import { computeSidePots } from './pots.js';
import { Voting, type VoteState } from './voting.js';
import { bestFive, extraBoards, settleRuns, type RunResult } from './runs.js';
import { describeHand, type HandDescription } from './hand-names.js';
import { assess, computeRake, jackpotAwards, type JackpotRules, type RakeRules } from './rake.js';
import { GameError, type Card, type HandState, type PlayerAction, type SeatView, type TableView } from './types.js';
import { allInRunout, buildView, wentToShowdown, type Reveal } from './view.js';
import { BUILTIN_MODULES, ModulePipeline, type GameModule, type ModuleContext, type ModuleSeat } from './modules/index.js';

export type SeatMode = 'in' | 'out' | 'leaving';

export interface SeatEntry {
  seat: number;
  userId: string;
  name: string;
  /** Žetony k poslednímu předělu handy. Uvnitř handy je pravdou engine. */
  chips: number;
  mode: SeatMode;
  timeouts: number;
  timeBank: number;
  /** Časové žetony (režim „chips“): kolik jich hráči zbývá. */
  timeChips?: number;
  connected: boolean;
  /** Žetony zaplacené mimo handu, které se přičtou při předělu. */
  pendingChips: number;
  outSince: number | null;
  /** Nový hráč: vztahuje se na něj pravidlo pro nové hráče (čekat na BB / dead blind). */
  fresh: boolean;
  /** Dobrovolný straddle na další handy. */
  wantsStraddle: boolean;
  /** Turnaj: vypadnutí už bylo ohlášeno (hráč čeká na rozhodnutí o rebuy nebo na odstranění). */
  bustReported?: boolean;
}

/** Stav, který se ukládá do DB. Rozehraná handa se při obnově vrací na poslední předěl. */
export interface PersistedTable {
  seats: SeatEntry[];
  recentLeaves: { userId: string; chips: number; at: number }[];
}

export interface HandRecordData {
  handNumber: number;
  buttonSeat: number | null;
  runs: number;
  /** Šance na výhru obou hráčů v okamžiku heads-up all-inu (userId → 0 až 1); jinak null. Jen pro server. */
  allInEquity: Record<string, number> | null;
  players: { seat: number; userId: string; name: string; startStack: number; invested: number; won: number; status: string; hole: [string, string] | null; revealed: boolean; /** Síla ruky na showdownu (nižší je lepší) a překladový klíč kombinace. */ handScore: number | null; handKey: string | null; /** Popis kombinace včetně parametrů (pro hlášky v chatu). */ handDesc?: HandDescription | null }[];
}

export type TableEvent =
  | { type: 'handStart'; handId: string; handNumber: number; buttonSeat: number | null; players: { seat: number; userId: string; stack: number }[] }
  | { type: 'action'; handId: string; userId: string; seat: number; street: string; action: PlayerAction['type'] | 'timeout'; amount: number; auto: boolean; /** Nejvyšší sázka na ulici před akcí. */ facing: number }
  | {
      type: 'handEnd';
      handId: string;
      board: string[];
      winners: { seat: number; amount: number; handName: string | null }[];
      showdown: boolean;
      /** Jen pro server (statistiky, historie): skryté karty a výsledek každého hráče. Nikdy se neposílá klientům. */
      record: HandRecordData;
    }
  | { type: 'moduleError'; moduleId: string; hook: string; message: string }
  | { type: 'clockCalled'; by: string; target: string }
  | { type: 'bonus'; kind: 'sevenTwo'; userId: string; amount: number }
  | { type: 'bombPot'; handId: string }
  | { type: 'shown'; userId: string; which: 'both' | 'one' }
  | { type: 'mucked'; userId: string }
  | { type: 'rabbit'; cards: Card[] }
  | { type: 'rake'; handId: string; total: number; jackpot: number }
  | { type: 'jackpot'; handId: string; kind: 'royalFlush' | 'badBeat' | 'highHand'; payouts: { userId: string; amount: number }[] }
  | { type: 'bust'; players: { userId: string; seat: number; startStack: number }[]; hand: { userId: string; invested: number; won: number; equity?: number | null }[] }
  | { type: 'seat'; userId: string; seat: number; change: 'join' | 'leave' | 'sitOut' | 'sitIn' | 'topUp'; chips: number };

export interface TableOptions {
  tableId: string;
  settings: () => SettingValues;
  clock: Clock;
  cash: CashService;
  chipsPerCurrencyUnit?: number;
  onChange?: () => void;
  onEvent?: (e: TableEvent) => void;
  persist?: (s: PersistedTable) => void;
  restore?: PersistedTable;
  adapterFactory?: (cfg: ConstructorParameters<typeof PokertoolsAdapter>[0]) => PokerEngineAdapter;
  randomProvider?: () => number;
  /** Bounty (hlava) hráče u sedadla v turnaji; null/undefined = nezobrazuje se. */
  seatBounty?: (userId: string) => number | null | undefined;
  /** Součet odměn na hlavu hráče (štítek „hledaný“). */
  seatWanted?: (userId: string) => number;
  /** Moduly pravidel; výchozí jsou vestavěné (ante, big blind ante, straddle, noví hráči). */
  modules?: GameModule[];
  /** Turnajový stůl: žetony nejsou měna, hráče usazuje a odstraňuje turnaj, bez cash-outu a top-upu. */
  tournament?: boolean;
  /** Turnaj, ke kterému stůl patří (u turnaje na více stolech se liší od id stolu). */
  tournamentId?: string;
  /** Předěl mezi handami u turnajového stolu: turnaj může přesadit hráče, zrušit stůl nebo stůl zadržet (hand-for-hand). */
  onBoundary?: () => void;
  /** Osobní nastavení hráče (např. jak naložit s kartami na showdownu); undefined = výchozí hodnota. */
  userPref?: (userId: string, key: string) => string | number | boolean | undefined;
}

type Phase = 'idle' | 'hand' | 'runout' | 'pause' | 'stopped';

const num = (v: SettingValues, k: string): number => Number(v[k]);

/**
 * Jeden stůl = jedna izolovaná instance se sériovým zpracováním příkazů (vše je synchronní,
 * takže se dvě akce nikdy nepřekryjí). Chyba uvnitř stolu ho zastaví, ostatní stoly nejsou dotčeny.
 */
export class TableActor {
  private adapter: PokerEngineAdapter;
  private seats = new Map<string, SeatEntry>();
  private recentLeaves: { userId: string; chips: number; at: number }[] = [];
  private phase: Phase = 'idle';
  private seq = 0;
  private reveal: Reveal = { boardCards: 0, holeCards: false, winners: false };
  private oddsCache: TableView['odds'] = null;
  private timers: (() => void)[] = [];
  private turnTimer: (() => void) | null = null;
  private deadline: number | null = null;
  private bankActive = false;
  private bankStartedAt = 0;
  private actingUser: string | null = null;
  private revealedBoard = 0;
  private lastState: HandState | null = null;
  private error: unknown = null;
  private handSettings: SettingValues;
  private pendingStart: (() => void) | null = null;
  private showHand = false;
  private pipeline: ModulePipeline;
  private handsPlayed = 0;
  private held = false;
  private clockCalled = false;
  private lastTimeCharge: number | null = null;
  private voting: Voting;
  private pendingFinish: HandState | null = null;
  private shown = new Map<number, (Card | null)[]>();
  private rabbit: Card[] | null = null;
  private bombPotHand: string | null = null;
  /** Čas navíc pro první tah handy (rozdávání); spotřebuje se při prvním spuštění časovače. */
  private dealGraceMs = 0;
  /** Přepočítaný výsledek handy (run it twice): výherci, které engine nezná, a jednotlivé běhy. */
  private override: { handId: string; winners: NonNullable<HandState['winners']>; engineWinners: HandState['winners']; runs: RunResult[] } | null = null;
  private highHand: { userId: string; score: number } | null = null;
  private highHandTimer = false;
  private startStacks = new Map<string, number>();
  /** Showdown: odhozené karty (muck), čekání na rozhodnutí hráčů a poslední agresor na ulici. */
  private mucked = new Set<number>();
  private choice: { token: number; seats: Set<number>; deadline: number; emitEnd: () => void; afterMs: number } | null = null;
  private choiceSeq = 0;
  private lastAggressor: { street: string; seat: number } | null = null;

  constructor(private opt: TableOptions) {
    this.handSettings = opt.settings();
    this.voting = new Voting({ clock: opt.clock, idPrefix: `${opt.tableId}`, handlers: { runit: (v) => this.onRunItResolved(v) }, onChange: () => this.changed() });
    this.adapter = this.newAdapter();
    this.pipeline = new ModulePipeline(opt.modules ?? BUILTIN_MODULES, (e) =>
      this.opt.onEvent?.({ type: 'moduleError', moduleId: e.moduleId, hook: e.hook, message: e.error instanceof Error ? e.error.message : String(e.error) }),
    );
    if (opt.restore) {
      for (const e of opt.restore.seats) this.seats.set(e.userId, { ...e, fresh: false, wantsStraddle: e.wantsStraddle ?? false, connected: false, timeouts: 0 });
      this.recentLeaves = [...opt.restore.recentLeaves];
      queueMicrotask(() => this.scheduleNextHand());
    }
  }

  // ---------- veřejné příkazy ----------

  join(userId: string, name: string, seatNo: number, currencyAmount: number): void {
    this.guard(() => {
      if (this.opt.tournament) throw new GameError('TOURNAMENT_TABLE');
      const s = this.opt.settings();
      if (this.seats.has(userId)) throw new GameError('ALREADY_SEATED');
      if (!Number.isInteger(seatNo) || seatNo < 0 || seatNo >= num(s, 'table.seats')) throw new GameError('INVALID_SEAT');
      if ([...this.seats.values()].some((e) => e.seat === seatNo)) throw new GameError('SEAT_OCCUPIED');
      const rate = this.rate();
      const bb = num(s, 'table.bigBlind');
      const chips = currencyAmount * rate;
      const min = num(s, 'cash.minBuyInBb') * bb;
      const max = num(s, 'cash.maxBuyInBb') * bb;
      if (!Number.isInteger(currencyAmount) || currencyAmount <= 0) throw new GameError('INVALID_AMOUNT');
      if (chips < min) throw new GameError('BUYIN_TOO_SMALL', undefined, { min });
      if (chips > max) throw new GameError('BUYIN_TOO_LARGE', undefined, { max });
      this.checkHitAndRun(userId, chips, s);
      const got = this.opt.cash.buyIn(userId, this.opt.tableId, currencyAmount, `buyin:${this.opt.tableId}:${userId}:${randomUUID()}`);
      this.seats.set(userId, {
        seat: seatNo,
        userId,
        name,
        chips: got,
        mode: 'in',
        timeouts: 0,
        timeBank: num(s, 'time.timeBankSeconds'),
        timeChips: num(s, 'time.timeChips'),
        connected: true,
        pendingChips: 0,
        outSince: null,
        fresh: this.isEstablished(),
        wantsStraddle: false,
      });
      this.opt.onEvent?.({ type: 'seat', userId, seat: seatNo, change: 'join', chips: got });
      this.persist();
      this.changed();
      if (this.phase === 'idle') this.scheduleNextHand();
    });
  }

  topUp(userId: string, currencyAmount: number): void {
    this.guard(() => {
      if (this.opt.tournament) throw new GameError('TOURNAMENT_TABLE');
      const s = this.opt.settings();
      const e = this.mustSeat(userId);
      const busted = this.currentChips(e) === 0;
      if (busted ? !s['cash.rebuyEnabled'] : !s['cash.topUpEnabled']) throw new GameError('TOPUP_DISABLED');
      if (!Number.isInteger(currencyAmount) || currencyAmount <= 0) throw new GameError('INVALID_AMOUNT');
      const max = num(s, 'cash.maxBuyInBb') * num(s, 'table.bigBlind');
      const add = currencyAmount * this.rate();
      if (this.currentChips(e) + e.pendingChips + add > max) throw new GameError('BUYIN_TOO_LARGE', undefined, { max });
      this.opt.cash.buyIn(userId, this.opt.tableId, currencyAmount, `topup:${this.opt.tableId}:${userId}:${randomUUID()}`, 'cash_topup');
      e.pendingChips += add;
      this.opt.onEvent?.({ type: 'seat', userId, seat: e.seat, change: 'topUp', chips: add });
      if (this.phase === 'idle' || this.phase === 'pause') {
        // mezi handami se žetony přičtou hned
        if (this.phase === 'idle') {
          e.chips += e.pendingChips;
          e.pendingChips = 0;
          if (e.mode === 'out' && e.chips > 0) e.mode = 'in';
          this.scheduleNextHand();
        }
      }
      this.persist();
      this.changed();
    });
  }

  /** Odchod od stolu s cash-outem. Uprostřed handy se provede po jejím skončení (hráč se mezitím složí). */
  leave(userId: string): void {
    this.guard(() => {
      if (this.opt.tournament) throw new GameError('TOURNAMENT_TABLE');
      const e = this.mustSeat(userId);
      if (this.phase === 'hand' || this.phase === 'runout') {
        e.mode = 'leaving';
        this.autoFoldIfNeeded();
        this.changed();
        return;
      }
      this.cashOutAndRemove(e);
      this.changed();
    });
  }

  // ---------- turnajové příkazy (volá je turnaj, ne hráč) ----------

  /** Usadí hráče s turnajovými žetony (žádný pohyb měny). */
  seatTournamentPlayer(userId: string, name: string, seatNo: number, chips: number): void {
    this.guard(() => {
      const s = this.opt.settings();
      if (!this.opt.tournament) throw new GameError('NOT_TOURNAMENT');
      const prev = this.seats.get(userId);
      if (prev && prev.mode !== 'leaving') throw new GameError('ALREADY_SEATED');
      if (!Number.isInteger(chips) || chips <= 0) throw new GameError('INVALID_AMOUNT');
      if (prev) {
        // Vyřazený hráč, který ještě čeká na odstranění po rozehrané handě, vstoupil znovu: dostane nové žetony na stejném místě.
        prev.mode = 'in';
        prev.pendingChips += chips;
        prev.bustReported = false;
        prev.timeouts = 0;
        this.opt.onEvent?.({ type: 'seat', userId, seat: prev.seat, change: 'join', chips });
        this.persist();
        this.changed();
        return;
      }
      if (!Number.isInteger(seatNo) || seatNo < 0 || seatNo >= num(s, 'table.seats')) throw new GameError('INVALID_SEAT');
      if ([...this.seats.values()].some((e) => e.seat === seatNo)) throw new GameError('SEAT_OCCUPIED');
      this.seats.set(userId, { seat: seatNo, userId, name, chips, mode: 'in', timeouts: 0, timeBank: num(s, 'time.timeBankSeconds'), timeChips: num(s, 'time.timeChips'), connected: true, pendingChips: 0, outSince: null, fresh: false, wantsStraddle: false });
      this.opt.onEvent?.({ type: 'seat', userId, seat: seatNo, change: 'join', chips });
      this.persist();
      this.changed();
      if (this.phase === 'idle') this.scheduleNextHand();
    });
  }

  /** Přidá turnajové žetony (rebuy, add-on); uprostřed handy se připíšou až po jejím skončení. */
  addTournamentChips(userId: string, chips: number): void {
    this.guard(() => {
      const e = this.mustSeat(userId);
      if (!Number.isInteger(chips) || chips <= 0) throw new GameError('INVALID_AMOUNT');
      e.pendingChips += chips;
      e.bustReported = false;
      if (this.phase === 'idle') {
        e.chips += e.pendingChips;
        e.pendingChips = 0;
        if (e.mode === 'out' && e.timeouts === 0) e.mode = 'in';
        this.scheduleNextHand();
      } else if (e.mode === 'out' && e.chips === 0 && e.timeouts === 0) e.mode = 'in';
      this.opt.onEvent?.({ type: 'seat', userId, seat: e.seat, change: 'topUp', chips });
      this.persist();
      this.changed();
    });
  }

  /** Odstraní hráče ze stolu bez výplaty (vyřazení, odhlášení před startem). Uprostřed handy až po jejím skončení. */
  removeTournamentPlayer(userId: string): void {
    this.guard(() => {
      const e = this.mustSeat(userId);
      if (this.phase === 'hand' || this.phase === 'runout') {
        e.mode = 'leaving';
        this.autoFoldIfNeeded();
        this.changed();
        return;
      }
      this.cashOutAndRemove(e);
      this.changed();
    });
  }

  /** Počet žetonů hráče (včetně těch v rozehrané handě). */
  chipsOf(userId: string): number | null {
    const e = this.seats.get(userId);
    if (!e) return null;
    const h = this.phase === 'hand' ? this.adapter.state() : null;
    const p = h?.players.find((x) => x.playerId === userId);
    return (p ? p.stack + p.invested + p.dead : this.currentChips(e)) + e.pendingChips;
  }

  /** Pozastaví rozdávání dalších hand (přestávka, pauza). Rozehraná handa se dohraje. */
  hold(): void {
    this.held = true;
    this.changed();
  }

  release(): void {
    this.held = false;
    if (this.phase === 'idle' || this.phase === 'pause') this.scheduleNextHand();
    this.changed();
  }

  isHeld(): boolean {
    return this.held;
  }

  sitOut(userId: string): void {
    this.guard(() => {
      const e = this.mustSeat(userId);
      if (e.mode === 'leaving') return;
      e.mode = 'out';
      e.outSince = this.opt.clock.now();
      this.opt.onEvent?.({ type: 'seat', userId, seat: e.seat, change: 'sitOut', chips: e.chips });
      this.scheduleMaxSitOut(e);
      this.autoFoldIfNeeded();
      this.persist();
      this.changed();
    });
  }

  sitIn(userId: string): void {
    this.guard(() => {
      const e = this.mustSeat(userId);
      if (e.mode !== 'out') return;
      if (this.currentChips(e) + e.pendingChips <= 0) throw new GameError('NO_CHIPS');
      e.mode = 'in';
      e.outSince = null;
      e.timeouts = 0;
      // Návrat ze sit outu: hned od další handy; čekání na big blind (proti obcházení blindů) jen když to stůl vyžaduje.
      e.fresh = this.opt.settings()['cash.sitInWaitsForBb'] ? this.isEstablished(userId) : false;
      this.opt.onEvent?.({ type: 'seat', userId, seat: e.seat, change: 'sitIn', chips: e.chips });
      if (this.phase === 'idle') this.scheduleNextHand();
      this.changed();
    });
  }

  /** Dobrovolný straddle: hráč si ho vyžádá (nebo zruší) pro další handy. */
  setStraddle(userId: string, want: boolean): void {
    this.guard(() => {
      const e = this.mustSeat(userId);
      if (!this.opt.settings()['table.straddleEnabled']) throw new GameError('STRADDLE_DISABLED');
      e.wantsStraddle = want;
      this.persist();
      this.changed();
    });
  }

  setConnected(userId: string, connected: boolean): void {
    const e = this.seats.get(userId);
    if (!e) return;
    e.connected = connected;
    if (!connected && this.actingUser === userId) this.startTurnTimer();
    this.changed();
  }

  /** Akce hráče. Server ji ověří (tah, množství) a teprve pak provede. */
  act(userId: string, action: PlayerAction): void {
    this.guard(() => {
      const e = this.mustSeat(userId);
      if (this.phase !== 'hand') throw new GameError('NO_HAND');
      const h = this.adapter.state();
      if (h.actingSeat !== e.seat) throw new GameError('NOT_YOUR_TURN');
      this.apply(userId, action, false);
    });
  }

  /** Zavolání času: soupeř na tahu má už jen krátký zbytek času, bez dalšího time banku. */
  callClock(userId: string): void {
    this.guard(() => {
      const s = this.opt.settings();
      if (!s['time.callClockEnabled']) throw new GameError('CALL_CLOCK_DISABLED');
      this.mustSeat(userId);
      if (this.phase !== 'hand' || !this.actingUser) throw new GameError('NO_HAND');
      if (this.actingUser === userId) throw new GameError('NOT_ALLOWED');
      if (!this.inEngine(userId)) throw new GameError('NOT_ALLOWED');
      if (this.clockCalled) throw new GameError('CLOCK_ALREADY_CALLED');
      this.clockCalled = true;
      const target = this.actingUser;
      const now = this.opt.clock.now();
      const limit = num(s, 'time.callClockSeconds') * 1000;
      if (this.deadline === null || this.deadline - now > limit) {
        this.turnTimer?.();
        this.deadline = now + limit;
        this.turnTimer = this.opt.clock.setTimeout(() => this.onCalledClockExpired(target), limit);
      }
      this.opt.onEvent?.({ type: 'clockCalled', by: userId, target });
      this.changed();
    });
  }

  viewFor(userId: string | null): TableView {
    const s = this.opt.settings();
    const isPlayer = !!userId && this.seats.has(userId);
    const showOdds = !!s['odds.enabled'] && (isPlayer || !!s['odds.forSpectators']);
    const h = this.showHand && this.hasHand() ? this.handState() : null;
    const activeVote = this.voting.active('runit');
    const legal = h && userId && this.phase === 'hand' ? this.adapter.legalActions(userId) : null;
    const bb = num(s, 'table.bigBlind');
    return buildView(h, {
      seq: this.seq,
      info: {
        seatCount: num(s, 'table.seats'),
        smallBlind: num(s, 'table.smallBlind'),
        bigBlind: bb,
        minBuyIn: num(s, 'cash.minBuyInBb') * bb,
        maxBuyIn: num(s, 'cash.maxBuyInBb') * bb,
        chipsPerCurrencyUnit: this.rate(),
        topUpEnabled: !!s['cash.topUpEnabled'],
        rebuyEnabled: !!s['cash.rebuyEnabled'],
        currencySymbol: String(s['economy.currencySymbol']),
        currencyDecimals: num(s, 'economy.decimals'),
        chipLabel: s['table.showChipLabel'] ? String(s['table.chipLabel'] ?? '').trim() : '',
        straddle: !s['table.straddleEnabled'] ? 'off' : s['table.straddleMandatory'] ? 'mandatory' : 'optional',
        tournament: !!this.opt.tournament,
        ...(this.opt.tournamentId ? { tournamentId: this.opt.tournamentId } : {}),
        bettingLimit: String(s['table.bettingLimit']) as 'noLimit' | 'potLimit' | 'fixedLimit',
        callClock: !!s['time.callClockEnabled'],
        showCards: !!s['special.showCards'],
        rabbitHunt: !!s['special.rabbitHunt'],
        ante: num(s, 'table.ante') * this.rate(),
        bbAnte: !!s['table.bbAnte'],
        runIt: s['special.runItTwice'] ? num(s, 'special.runItTimes') : 0,
        bombPotEvery: s['special.bombPot'] ? num(s, 'special.bombPotEveryHands') : 0,
        sevenTwoBb: s['special.sevenTwoBonus'] ? num(s, 'special.sevenTwoAmountBb') : 0,
        ...(!this.opt.tournament && s['rake.enabled'] && num(s, 'rake.percent') > 0 ? { rake: { percent: num(s, 'rake.percent'), capChips: num(s, 'rake.cap') * this.rate(), noFlopNoDrop: !!s['rake.noFlopNoDrop'] } } : {}),
        ...(!this.opt.tournament && (s['jackpot.royalFlushEnabled'] || s['jackpot.badBeatEnabled']) ? { jackpot: this.opt.cash.fundBalance(String(s['rake.jackpotFundId'] || 'jackpot')) } : {}),
      },
      myStraddle: userId ? (this.seats.get(userId)?.wantsStraddle ?? false) : false,
      viewerId: userId,
      deadline: this.deadline,
      bankActive: this.bankActive,
      clockCalled: this.clockCalled,
      vote: activeVote ? (this.voting.view(activeVote.id, userId) ?? null) : null,
      rabbit: this.rabbit,
      bombPot: !!h && h.handId === this.bombPotHand,
      exposed: this.shown,
      runs: this.override && h?.handId === this.override.handId ? this.override.runs : null,
      engineWinners: this.override && h?.handId === this.override.handId ? this.override.engineWinners : undefined,
      timeBanks: new Map([...this.seats.values()].map((e) => [e.userId, this.reserveSeconds(e)])),
      bounties: this.opt.seatBounty ? new Map([...this.seats.values()].map((e) => [e.userId, this.opt.seatBounty!(e.userId) ?? null])) : undefined,
      wanted: this.opt.seatWanted ? new Map([...this.seats.values()].map((e) => [e.userId, this.opt.seatWanted!(e.userId)])) : undefined,
      reveal: this.reveal,
      mucked: this.mucked,
      deciding: this.choice?.seats,
      choiceDeadline: this.choice?.deadline ?? null,
      legal,
      odds: showOdds ? this.oddsCache : null,
      extraSeats: this.extraSeats(h),
      statusOverride: new Map([...this.seats.values()].filter((e) => e.fresh).map((e) => [e.userId, 'waiting' as const])),
      sitOuts: new Set([...this.seats.values()].filter((e) => e.mode === 'out').map((e) => e.userId)),
      paused: this.held,
    });
  }

  /** Doporučení pro snapshot: stav, který přežije restart serveru. */
  persisted(): PersistedTable {
    return { seats: [...this.seats.values()].map((e) => ({ ...e })), recentLeaves: [...this.recentLeaves] };
  }

  /** Kde jsou žetony: u stolu = součet stacků v enginu a v registru. Pro kontrolu invariantu. */
  totalChips(): number {
    let total = 0;
    const h = this.phase === 'hand' ? this.adapter.state() : null;
    for (const e of this.seats.values()) {
      const p = h?.players.find((x) => x.playerId === e.userId);
      total += (p ? p.stack + p.invested + p.dead : this.currentChips(e)) + e.pendingChips;
    }
    return total;
  }

  playersSeated(): SeatEntry[] {
    return [...this.seats.values()].map((e) => ({ ...e }));
  }

  /** Probíhá handa (včetně dokládání karet). */
  handInProgress(): boolean {
    return this.phase === 'hand' || this.phase === 'runout';
  }
  /** U stolu už se odehrála aspoň jedna handa. */
  hasStarted(): boolean {
    return this.handsPlayed > 0;
  }

  currentPhase(): Phase {
    return this.phase;
  }
  hasError(): unknown {
    return this.error;
  }

  /** Zastaví časovače (vypnutí serveru). Hráči zůstanou usazení, stav je uložený k poslednímu předělu. */
  stop(): void {
    this.voting.stop();
    for (const c of this.timers) c();
    this.timers = [];
    this.turnTimer?.();
    this.pendingStart?.();
    this.phase = 'stopped';
  }

  /** Zastaví stůl a vrátí všem jejich žetony do peněženek (zrušení stolu). */
  close(): void {
    this.voting.stop();
    this.pendingFinish = null;
    for (const c of this.timers) c();
    this.timers = [];
    this.turnTimer?.();
    this.pendingStart?.();
    const midHand = this.phase === 'hand';
    this.phase = 'stopped';
    for (const e of [...this.seats.values()]) this.cashOutAndRemove(e, 'cash_return', midHand);
    this.changed();
  }

  /** Napojení na rozesílání pohledů (server ho nastaví po vytvoření stolu). */
  setOnChange(fn: () => void): void {
    this.opt.onChange = fn;
  }

  // ---------- vnitřní logika ----------

  /** Hra už běží: nový hráč se řídí pravidlem pro nové hráče. */
  private isEstablished(except?: string): boolean {
    const others = [...this.seats.values()].filter((e) => e.userId !== except && e.mode === 'in' && !e.fresh && e.chips + e.pendingChips > 0);
    return this.handsPlayed > 0 && others.length >= 2;
  }

  private moduleCtx(): ModuleContext {
    const seats: ModuleSeat[] = [...this.seats.values()]
      .filter((e) => e.mode === 'in' && e.chips + e.pendingChips > 0)
      .map((e) => ({ userId: e.userId, seat: e.seat, chips: e.chips, fresh: e.fresh, wantsStraddle: e.wantsStraddle }));
    return { settings: this.opt.settings(), handNumber: this.adapter.state().handNumber, seats };
  }

  private rate(): number {
    return this.opt.chipsPerCurrencyUnit ?? 1;
  }

  private newAdapter(): PokerEngineAdapter {
    const s = this.opt.settings();
    const cfg = {
      smallBlind: num(s, 'table.smallBlind'),
      bigBlind: num(s, 'table.bigBlind'),
      ante: num(s, 'table.ante'),
      maxPlayers: num(s, 'table.seats'),
      timeBankSeconds: num(s, 'time.timeBankSeconds'),
      randomProvider: this.opt.randomProvider,
    };
    return this.opt.adapterFactory ? this.opt.adapterFactory(cfg) : new PokertoolsAdapter(cfg);
  }

  /** Stav handy; po přepočtu (run it twice) s výherci podle všech běhů. */
  private handState(): HandState {
    const h = this.adapter.state();
    return this.override && h.finished && h.handId === this.override.handId ? { ...h, winners: this.override.winners } : h;
  }

  private hasHand(): boolean {
    return this.adapter.state().handNumber > 0;
  }

  private mustSeat(userId: string): SeatEntry {
    const e = this.seats.get(userId);
    if (!e) throw new GameError('NOT_SEATED');
    return e;
  }

  private inEngine(userId: string): boolean {
    return this.adapter.stackOf(userId) !== null;
  }

  private currentChips(e: SeatEntry): number {
    if ((this.phase === 'hand' || this.phase === 'runout' || this.phase === 'pause') && this.inEngine(e.userId)) {
      return this.adapter.stackOf(e.userId) ?? e.chips;
    }
    return e.chips;
  }

  private extraSeats(h: HandState | null): SeatView[] {
    const inHand = new Set(h?.players.map((p) => p.playerId) ?? []);
    const out: SeatView[] = [];
    for (const e of this.seats.values()) {
      if (inHand.has(e.userId)) continue;
      out.push({
        seat: e.seat,
        playerId: e.userId,
        name: e.name,
        stack: e.chips + e.pendingChips,
        bet: 0,
        status: e.mode === 'in' ? 'waiting' : 'sittingOut',
        sitOut: e.mode === 'out',
        isDealer: false,
        cards: null,
        hasCards: false,
        timeBank: e.timeBank,
        ...(this.opt.seatBounty?.(e.userId) != null ? { bounty: this.opt.seatBounty(e.userId)! } : {}),
        ...((this.opt.seatWanted?.(e.userId) ?? 0) > 0 ? { wanted: this.opt.seatWanted!(e.userId) } : {}),
      });
    }
    return out;
  }

  private changed(): void {
    this.seq++;
    this.opt.onChange?.();
  }

  private persist(): void {
    this.opt.persist?.(this.persisted());
  }

  /** Chyba uvnitř stolu: GameError se vrací volajícímu, cokoli jiného zastaví jen tento stůl. */
  private guard(fn: () => void): void {
    if (this.phase === 'stopped') throw new GameError('TABLE_STOPPED');
    try {
      fn();
    } catch (e) {
      if (e instanceof GameError) throw e;
      // Hráč nemá v peněžence dost: je to jeho chyba, ne chyba stolu (kniha je při odmítnutí nedotčená), takže stůl hraje dál.
      if (e instanceof LedgerError && e.code === 'INSUFFICIENT_FUNDS') throw new GameError('INSUFFICIENT_FUNDS');
      // Neočekávaná chyba zastaví jen tento stůl, ale nesmí zmizet beze stopy.
      console.error(`[stůl ${this.opt.tableId}] zastaven kvůli chybě:`, e instanceof Error ? e.message : e);
      this.error = e;
      this.stopOnError();
      throw e;
    }
  }

  private stopOnError(): void {
    for (const c of this.timers) c();
    this.timers = [];
    this.turnTimer?.();
    this.phase = 'stopped';
    this.changed();
  }

  private later(ms: number, fn: () => void): void {
    const cancel = this.opt.clock.setTimeout(() => {
      this.timers = this.timers.filter((c) => c !== cancel);
      if (this.phase === 'stopped') return;
      try {
        fn();
      } catch (e) {
        this.error = e;
        this.stopOnError();
      }
    }, ms);
    this.timers.push(cancel);
  }

  private scaled(ms: number): number {
    const pct = Math.max(1, num(this.opt.settings(), 'time.animationSpeedPercent'));
    return Math.round((ms * 100) / pct);
  }

  /** Kdo se může zúčastnit další handy. V turnaji hraje (a platí blindy) i hráč v sit outu. */
  private playable(e: SeatEntry): boolean {
    if (this.opt.tournament) return e.mode !== 'leaving' && e.chips + e.pendingChips > 0;
    return e.mode === 'in' && e.chips + e.pendingChips > 0;
  }

  private eligibleCount(): number {
    return [...this.seats.values()].filter((e) => this.playable(e)).length;
  }

  /** `force`: po skončené handě se vždy provede předěl (zapsání výsledků do registru), i když se nebude hrát dál. */
  private scheduleNextHand(force = false): void {
    if (this.phase !== 'idle' && this.phase !== 'pause') return;
    if (this.pendingStart) return;
    if (this.held && !force) {
      if (this.phase === 'pause') this.phase = 'idle';
      return;
    }
    const hasLeavers = [...this.seats.values()].some((e) => e.mode === 'leaving');
    if (this.eligibleCount() < 2 && !hasLeavers && !force) {
      this.phase = 'idle';
      return;
    }
    const delay = this.scaled(num(this.opt.settings(), 'time.betweenHandsMs'));
    const cancel = this.opt.clock.setTimeout(() => {
      this.pendingStart = null;
      if (this.phase === 'stopped') return;
      try {
        this.boundary();
      } catch (e) {
        this.error = e;
        this.stopOnError();
      }
    }, delay);
    this.pendingStart = cancel;
  }

  /** Předěl mezi handami: odchody, doplnění žetonů, změny blindů, rozsazení do enginu. */
  private boundary(): void {
    const s = this.opt.settings();
    this.handSettings = s;
    const now = this.opt.clock.now();
    const busts: { userId: string; seat: number; startStack: number }[] = [];
    // Výsledek právě skončené handy (kdo kolik vložil a vyhrál): z něj turnaj pozná, kdo koho vyřadil.
    const lastHand = this.hasHand() ? this.handState() : null;
    const contested = lastHand?.finished
      ? lastHand.players.map((p) => ({ userId: p.playerId, invested: p.invested + p.dead, won: (lastHand.winners ?? []).filter((w) => w.seat === p.seat).reduce((n, w) => n + w.amount, 0), equity: this.lastEquity?.[p.playerId] ?? null }))
      : [];
    for (const e of [...this.seats.values()]) {
      const engineStack = this.adapter.stackOf(e.userId);
      if (engineStack !== null) {
        e.chips = engineStack;
        this.adapter.unseat(e.userId);
      }
      if (e.mode === 'leaving') {
        this.cashOutAndRemove(e);
        continue;
      }
      if (e.pendingChips !== 0) {
        e.chips += e.pendingChips;
        e.pendingChips = 0;
      }
      if (this.opt.tournament && e.chips === 0 && !e.bustReported && this.startStacks.has(e.userId)) {
        e.bustReported = true;
        e.mode = 'out';
        busts.push({ userId: e.userId, seat: e.seat, startStack: this.startStacks.get(e.userId)! });
        continue;
      }
      if (e.chips === 0 && e.mode === 'in' && !this.opt.tournament) {
        e.mode = 'out';
        e.outSince = now;
        this.scheduleMaxSitOut(e);
        this.pipeline.run('onPlayerBusted', this.moduleCtx(), { userId: e.userId, seat: e.seat, chips: 0, fresh: e.fresh, wantsStraddle: e.wantsStraddle });
      }
    }
    this.chargeTime();
    this.startStacks = new Map();
    if (busts.length) this.opt.onEvent?.({ type: 'bust', players: busts, hand: contested });
    this.opt.onBoundary?.();
    // Čekání na big blind má smysl jen, když ostatní mají s kým hrát.
    const regulars = [...this.seats.values()].filter((e) => e.mode === 'in' && e.chips > 0 && !e.fresh).length;
    if (regulars < 2) for (const e of this.seats.values()) e.fresh = false;
    // Big blind ante řeší modul jako mrtvé peníze, engine proto dostává ante 0.
    this.adapter.setBlinds(num(s, 'table.smallBlind'), num(s, 'table.bigBlind'), s['table.bbAnte'] ? 0 : num(s, 'table.ante'));
    this.adapter.setLimit(String(s['table.bettingLimit']) as 'noLimit' | 'potLimit' | 'fixedLimit', num(s, 'table.limitMaxBets'));
    const ctx = this.moduleCtx();
    for (const e of this.seats.values()) {
      if (!this.playable(e) || e.chips <= 0) continue;
      const info: ModuleSeat = { userId: e.userId, seat: e.seat, chips: e.chips, fresh: e.fresh, wantsStraddle: e.wantsStraddle };
      const opts = this.pipeline.run('seatOptions', ctx, info).find((o) => o) ?? {};
      this.adapter.seat(e.seat, e.userId, e.name, e.chips, opts);
    }
    this.persist();
    if (this.adapter.canStartHand() && !this.held) this.startHand();
    else {
      // Bez handy je pravdou registr: kopie hráčů v enginu by zastarala (top-up, odchod).
      for (const e of this.seats.values()) if (this.adapter.stackOf(e.userId) !== null) this.adapter.unseat(e.userId);
      this.phase = 'idle';
      this.showHand = false;
      this.changed();
    }
  }

  private startHand(): void {
    const plan: DealPlan = {};
    this.pipeline.run('beforeDeal', this.moduleCtx(), plan);
    this.adapter.startHand(plan);
    this.handsPlayed++;
    const h = this.adapter.state();
    // Kdo dostal karty, už není „nový“.
    for (const p of h.players) if (p.hole) {
      const e = this.seats.get(p.playerId);
      if (e) e.fresh = false;
    }
    this.shown = new Map();
    this.mucked = new Set();
    this.choice = null;
    this.lastAggressor = null;
    this.rabbit = null;
    this.refillBanks();
    this.startStacks = new Map(h.players.map((p) => [p.playerId, p.stack + p.invested + p.dead]));
    this.pipeline.run('onHandStart', this.moduleCtx(), h);
    if (plan.bombPot) this.bombPotHand = h.handId;
    // Rozdávání karet u stolu chvíli trvá: první hráč na tahu dostane čas o tolik delší, aby ho animace nepřipravila o vteřiny.
    this.dealGraceMs = num(this.opt.settings(), 'time.dealMs');
    this.phase = 'hand';
    this.showHand = true;
    this.oddsCache = null;
    this.revealedBoard = 0;
    this.lastState = h;
    this.reveal = { boardCards: h.board.length, holeCards: false, winners: false };
    this.opt.onEvent?.({
      type: 'handStart',
      handId: h.handId,
      handNumber: h.handNumber,
      buttonSeat: h.buttonSeat,
      players: h.players.map((p) => ({ seat: p.seat, userId: p.playerId, stack: p.stack + p.invested })),
    });
    if (plan.bombPot) {
      this.opt.onEvent?.({ type: 'bombPot', handId: h.handId });
      this.autoPreflop();
    }
    this.afterEngineChange();
  }

  /** Bomb pot: preflop se bez čekání dorovná (call/check), takže se hraje od flopu. */
  private autoPreflop(): void {
    for (let i = 0; i < 40; i++) {
      const h = this.adapter.state();
      if (h.finished || h.street !== 'PREFLOP' || h.actingSeat === null) return;
      const acting = h.players.find((p) => p.seat === h.actingSeat);
      if (!acting) return;
      const legal = this.adapter.legalActions(acting.playerId);
      if (!legal) return;
      this.adapter.act(acting.playerId, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' });
    }
  }

  /** Společné místo po každé změně enginu: konec handy, nebo další hráč na tahu. */
  private afterEngineChange(): void {
    const h = this.adapter.state();
    if (h.finished) {
      this.turnTimer?.();
      this.turnTimer = null;
      this.deadline = null;
      this.bankActive = false;
      this.actingUser = null;
      this.onHandFinished(h);
      return;
    }
    this.revealedBoard = h.board.length;
    this.lastState = h;
    this.reveal = { boardCards: h.board.length, holeCards: false, winners: false };
    const acting = h.players.find((p) => p.seat === h.actingSeat);
    this.actingUser = acting?.playerId ?? null;
    this.changed();
    if (this.autoFoldIfNeeded()) return;
    this.startTurnTimer();
  }

  /** Hráč, který odchází nebo je v sit outu, na tahu automaticky složí (nebo checkne). */
  private autoFoldIfNeeded(): boolean {
    if (this.phase !== 'hand') return false;
    const h = this.adapter.state();
    const acting = h.players.find((p) => p.seat === h.actingSeat);
    if (!acting) return false;
    const e = this.seats.get(acting.playerId);
    if (e && (e.mode === 'leaving' || e.mode === 'out')) {
      this.apply(acting.playerId, this.defaultAction(acting.playerId), true);
      return true;
    }
    return false;
  }

  private defaultAction(userId: string): PlayerAction {
    const legal = this.adapter.legalActions(userId);
    const fold = this.opt.settings()['time.expiryAction'] === 'fold';
    return legal?.canCheck && !fold ? { type: 'check' } : { type: 'fold' };
  }

  private apply(userId: string, action: PlayerAction, auto: boolean): void {
    const before = this.adapter.state();
    const legal = this.adapter.legalActions(userId);
    const e = this.seats.get(userId);
    this.turnTimer?.();
    this.turnTimer = null;
    if (!auto && e) {
      this.settleBank(e);
      e.timeouts = 0;
    }
    this.adapter.act(userId, action);
    if (action.type === 'bet' || action.type === 'raise' || (action.type === 'allIn' && (legal?.maxRaiseTo ?? 0) > before.currentBet)) this.lastAggressor = { street: before.street, seat: before.actingSeat ?? -1 };
    this.opt.onEvent?.({
      type: 'action',
      handId: before.handId,
      userId,
      seat: before.actingSeat ?? -1,
      street: before.street,
      action: action.type,
      amount: action.type === 'bet' || action.type === 'raise' ? action.amount : action.type === 'call' ? (legal?.callAmount ?? 0) : action.type === 'allIn' ? (legal?.maxRaiseTo ?? 0) : 0,
      auto,
      facing: before.currentBet,
    });
    this.pipeline.run('afterAction', this.moduleCtx(), this.adapter.state(), { userId, action: action.type, auto });
    this.afterEngineChange();
  }

  // ---------- časovač tahu a time bank ----------

  private bankMode(): 'pool' | 'none' | 'chips' | 'chess' | 'fischer' | 'bronstein' {
    return String(this.opt.settings()['time.bankMode']) as ReturnType<TableActor['bankMode']>;
  }

  /** Šachové hodiny: hráč má jednu zásobu času, která běží jen na jeho tahu. */
  private isClockMode(): boolean {
    return ['chess', 'fischer', 'bronstein'].includes(this.bankMode());
  }

  /** Zbývající rezerva v sekundách (u časových žetonů přepočtená na sekundy). */
  private reserveSeconds(e: SeatEntry): number {
    if (this.bankMode() === 'none') return 0;
    if (this.bankMode() === 'chips') return (e.timeChips ?? 0) * num(this.opt.settings(), 'time.timeChipSeconds');
    return e.timeBank;
  }

  private startTurnTimer(): void {
    this.turnTimer?.();
    this.turnTimer = null;
    if (this.phase !== 'hand' || !this.actingUser) return;
    const s = this.opt.settings();
    const userId = this.actingUser;
    const e = this.seats.get(userId);
    this.clockCalled = false;
    const dealGrace = this.dealGraceMs;
    this.dealGraceMs = 0;
    const grace = num(s, 'time.disconnectGraceSeconds') * 1000;
    if (this.isClockMode() && e) {
      const reserve = Math.max(num(s, 'time.minTurnSeconds'), e.timeBank) * 1000;
      const wait = (e.connected ? reserve : Math.min(reserve, grace)) + dealGrace;
      const now = this.opt.clock.now();
      this.bankActive = true;
      this.bankStartedAt = now;
      this.deadline = now + wait;
      this.changed();
      this.turnTimer = this.opt.clock.setTimeout(() => this.onBankExpired(userId), wait);
      return;
    }
    const base = num(s, 'time.turnSeconds') * 1000;
    const wait = (e && !e.connected ? Math.min(base, grace) : base) + dealGrace;
    this.bankActive = false;
    this.deadline = this.opt.clock.now() + wait;
    this.changed();
    this.turnTimer = this.opt.clock.setTimeout(() => this.onBaseExpired(userId), wait);
  }

  private onBaseExpired(userId: string): void {
    if (this.phase !== 'hand' || this.actingUser !== userId) return;
    try {
      const e = this.seats.get(userId);
      if (this.bankMode() === 'none' || this.clockCalled) {
        this.timeoutAction(userId);
        return;
      }
      if (this.bankMode() === 'chips') {
        // Každý časový žeton prodlouží tah o pevný čas; žetony se spotřebují celé.
        if (e && e.connected && (e.timeChips ?? 0) > 0) {
          e.timeChips = (e.timeChips ?? 0) - 1;
          const ms = num(this.opt.settings(), 'time.timeChipSeconds') * 1000;
          this.bankActive = true;
          this.deadline = this.opt.clock.now() + ms;
          this.changed();
          this.turnTimer = this.opt.clock.setTimeout(() => this.onBaseExpired(userId), ms);
          return;
        }
        this.timeoutAction(userId);
        return;
      }
      if (e && e.connected && e.timeBank > 0) {
        this.bankActive = true;
        this.bankStartedAt = this.opt.clock.now();
        this.deadline = this.bankStartedAt + e.timeBank * 1000;
        this.changed();
        this.turnTimer = this.opt.clock.setTimeout(() => this.onBankExpired(userId), e.timeBank * 1000);
        return;
      }
      this.timeoutAction(userId);
    } catch (err) {
      this.error = err;
      this.stopOnError();
    }
  }

  private onBankExpired(userId: string): void {
    if (this.phase !== 'hand' || this.actingUser !== userId) return;
    try {
      const e = this.seats.get(userId);
      if (e) e.timeBank = 0;
      this.timeoutAction(userId);
    } catch (err) {
      this.error = err;
      this.stopOnError();
    }
  }

  private onCalledClockExpired(userId: string): void {
    if (this.phase !== 'hand' || this.actingUser !== userId) return;
    try {
      this.timeoutAction(userId);
    } catch (err) {
      this.error = err;
      this.stopOnError();
    }
  }

  private timeoutAction(userId: string): void {
    const e = this.seats.get(userId);
    const limit = num(this.opt.settings(), 'time.timeoutsToSitOut');
    if (e) {
      e.timeouts++;
      if (e.timeouts >= limit) {
        e.mode = 'out';
        e.outSince = this.opt.clock.now();
        this.scheduleMaxSitOut(e);
        this.opt.onEvent?.({ type: 'seat', userId, seat: e.seat, change: 'sitOut', chips: e.chips });
      }
    }
    const action = this.defaultAction(userId);
    this.bankActive = false;
    this.apply(userId, action, true);
  }

  /** Při jednání v time banku se odečte spotřebovaný čas. */
  private settleBank(e: SeatEntry): void {
    if (!this.bankActive) return;
    this.bankActive = false;
    const mode = this.bankMode();
    if (mode === 'chips') return;
    const s = this.opt.settings();
    const used = Math.ceil((this.opt.clock.now() - this.bankStartedAt) / 1000);
    let next = Math.max(0, e.timeBank - used);
    const inc = num(s, 'time.incrementSeconds');
    // Fischer přičte pevný přírůstek po každém tahu, Bronstein vrátí nejvýš tolik, kolik hráč spotřeboval.
    if (mode === 'fischer') next += inc;
    else if (mode === 'bronstein') next += Math.min(used, inc);
    const cap = num(s, 'time.bankMaxSeconds');
    if (cap > 0 && (mode === 'fischer' || mode === 'bronstein')) next = Math.min(next, cap);
    e.timeBank = next;
  }

  /** Doplnění rezervy času po zadaném počtu hand (nastavení). */
  private refillBanks(): void {
    const s = this.opt.settings();
    const every = num(s, 'time.bankRefillEveryHands');
    if (every <= 0 || this.handsPlayed % every !== 0) return;
    const cap = num(s, 'time.bankMaxSeconds');
    for (const e of this.seats.values()) {
      if (this.bankMode() === 'chips') e.timeChips = Math.min(num(s, 'time.timeChips'), (e.timeChips ?? 0) + 1);
      else if (this.bankMode() !== 'none') e.timeBank = cap > 0 ? Math.min(cap, e.timeBank + num(s, 'time.bankRefillSeconds')) : e.timeBank + num(s, 'time.bankRefillSeconds');
    }
  }

  // ---------- konec handy a dokládání karet ----------

  /** Hlasování o run it twice/třikrát: nabídne se, když jsou všichni all-in a zbývá rozdat aspoň jednu kartu. */
  private canOfferRunIt(h: HandState, s: SettingValues): boolean {
    if (!s['special.runItTwice']) return false;
    const contenders = h.players.filter((p) => p.hole && p.status !== 'folded' && p.status !== 'sittingOut');
    const need = 5 - this.revealedBoard;
    return contenders.length >= 2 && need > 0 && h.board.length >= 5 && this.adapter.remainingDeck().length >= need * (num(s, 'special.runItTimes') - 1);
  }

  private startRunItVote(h: HandState, s: SettingValues): void {
    this.pendingFinish = h;
    this.phase = 'runout';
    this.reveal = { boardCards: this.revealedBoard, holeCards: true, winners: false };
    this.computeOddsNow(h, this.revealedBoard);
    const times = num(s, 'special.runItTimes');
    const vote = this.voting.propose({
      kind: 'runit',
      voters: h.players.filter((p) => p.hole && p.status !== 'folded' && p.status !== 'sittingOut').map((p) => p.playerId),
      timeoutMs: num(s, 'special.runItVoteSeconds') * 1000,
      payload: { times },
    });
    this.deadline = vote.deadline;
    this.changed();
  }

  private onRunItResolved(vote: VoteState): void {
    const h = this.pendingFinish;
    if (!h) return;
    this.pendingFinish = null;
    this.deadline = null;
    try {
      const times = (vote.payload as { times: number }).times;
      this.onHandFinished(h, vote.status === 'passed' ? times : 1);
    } catch (e) {
      this.error = e;
      this.stopOnError();
    }
  }

  /** Po skončené handě bez showdownu smí hráč z handy dobrovolně ukázat karty (obě, nebo jednu). */
  showCards(userId: string, which: 'both' | 0 | 1): void {
    this.guard(() => {
      const s = this.opt.settings();
      if (!s['special.showCards']) throw new GameError('NOT_ALLOWED');
      const h = this.finishedHandForExtras();
      const p = h.players.find((x) => x.playerId === userId);
      if (!p?.hole || wentToShowdown(h)) throw new GameError('NOT_ALLOWED');
      const cur = this.shown.get(p.seat) ?? [null, null];
      const next: (Card | null)[] = [which === 'both' || which === 0 ? p.hole[0] : cur[0]!, which === 'both' || which === 1 ? p.hole[1] : cur[1]!];
      this.shown.set(p.seat, next);
      this.opt.onEvent?.({ type: 'shown', userId, which: next[0] && next[1] ? 'both' : 'one' });
      this.changed();
    });
  }

  /** Rabbit hunt: po skončené handě bez celého boardu ukáže karty, které by přišly. */
  rabbitHunt(userId: string): void {
    this.guard(() => {
      const s = this.opt.settings();
      if (!s['special.rabbitHunt']) throw new GameError('NOT_ALLOWED');
      const h = this.finishedHandForExtras();
      const inHand = h.players.some((x) => x.playerId === userId && x.hole);
      if (s['special.rabbitHuntWho'] === 'participants' ? !inHand : !this.seats.has(userId)) throw new GameError('NOT_ALLOWED');
      if (this.rabbit || h.board.length >= 5) throw new GameError('NOT_ALLOWED');
      const cards = this.adapter.remainingDeck().slice(0, 5 - h.board.length);
      if (cards.length < 5 - h.board.length) throw new GameError('NOT_ALLOWED');
      this.rabbit = cards;
      this.opt.onEvent?.({ type: 'rabbit', cards });
      this.changed();
    });
  }

  /** Skončená handa, ke které se ještě smí něco ukázat (mezi koncem handy a rozdáním další). */
  private finishedHandForExtras(): HandState {
    if (this.phase !== 'pause' && this.phase !== 'idle') throw new GameError('NOT_ALLOWED');
    if (!this.hasHand()) throw new GameError('NOT_ALLOWED');
    const h = this.adapter.state();
    if (!h.finished) throw new GameError('NOT_ALLOWED');
    return h;
  }

  /** Hráč ve hře hlasuje o run it twice/třikrát. */
  voteRunIt(userId: string, yes: boolean): void {
    this.guard(() => {
      this.mustSeat(userId);
      const v = this.voting.active('runit');
      if (!v) throw new GameError('NO_VOTE');
      try {
        this.voting.vote(v.id, userId, yes);
      } catch {
        throw new GameError('NOT_ALLOWED');
      }
    });
  }

  /** Přepočet výsledku handy pro více běhů; vrací běhy, nebo null, když se přepočítat nedá. */
  private applyRuns(h: HandState, runs: number): RunResult[] | null {
    const boards = extraBoards(h.board, this.revealedBoard, this.adapter.remainingDeck(), runs);
    if (!boards) return null;
    const out = settleRuns(h, boards);
    const winners: NonNullable<HandState['winners']> = [...out.winnings.entries()].filter(([, amount]) => amount > 0).map(([seat, amount]) => ({ seat, amount, handName: null, cards: null }));
    const engineWon = new Map<number, number>();
    for (const w of h.winners ?? []) engineWon.set(w.seat, (engineWon.get(w.seat) ?? 0) + w.amount);
    // Rozdíl proti výsledku enginu se promítne do žetonů při předělu (součet rozdílů je nulový).
    for (const p of h.players) {
      const delta = (out.winnings.get(p.seat) ?? 0) - (engineWon.get(p.seat) ?? 0);
      const e = this.seats.get(p.playerId);
      if (e && delta !== 0) e.pendingChips += delta;
    }
    this.override = { handId: h.handId, winners, engineWinners: h.winners, runs: out.runs };
    return out.runs;
  }

  private lastEquity: Record<string, number> | null = null;

  /**
   * Šance obou hráčů v okamžiku heads-up all-inu (dokládá se board). Používá se pro EV korekci ratingu
   * a úspěch „vyhraný all-in s malou šancí“. Vícenásobné all-iny se neočekávají (null).
   */
  private allInEquity(h: HandState, showdown: boolean, runout: boolean): Record<string, number> | null {
    if (!showdown || !runout) return null;
    const live = h.players.filter((p) => p.status !== 'folded' && p.status !== 'sittingOut' && p.hole);
    if (live.length !== 2) return null;
    const s = this.opt.settings();
    const board = h.board.slice(0, this.revealedBoard);
    const pots = computeSidePots(h);
    const seats = live.map((p) => p.seat);
    const [r] = computeOdds(
      live.map((p) => ({ seat: p.seat, hole: p.hole! })),
      board,
      [{ seats: pots[0] ? pots[0].eligibleSeats.filter((x) => seats.includes(x)) : seats }],
      { maxExactCombos: num(s, 'rating.equityExactCombos'), simulations: num(s, 'rating.equitySimulations') },
    );
    if (!r) return null;
    const out: Record<string, number> = {};
    for (const p of live) {
      const e = r.entries.find((x) => x.seat === p.seat);
      if (e) out[p.playerId] = Math.round((e.win + e.tie / 2) * 10_000) / 10_000;
    }
    return Object.keys(out).length === 2 ? out : null;
  }

  private strength(p: HandState['players'][number], h: HandState, showdown: boolean): { handScore: number | null; handKey: string | null; handDesc: HandDescription | null } {
    const live = showdown && p.hole && p.status !== 'folded' && p.status !== 'sittingOut';
    const a = live ? assess(p.hole!, h.board) : null;
    const handDesc = live && h.board.length >= 5 ? describeHand(bestFive(p.hole!, h.board).cards) : null;
    return { handScore: a ? a.score : null, handKey: a ? a.key ?? null : null, handDesc };
  }

  private onHandFinished(rawHand: HandState, runs?: number): void {
    const s = this.opt.settings();
    const showdownRaw = wentToShowdown(rawHand);
    const remainingRaw = rawHand.board.length - this.revealedBoard;
    const preState = this.lastState;
    const wouldRunout = showdownRaw && remainingRaw > 0 && preState !== null && this.wasRunout(preState);
    if (runs === undefined && wouldRunout && this.canOfferRunIt(rawHand, s)) {
      this.startRunItVote(rawHand, s);
      return;
    }
    const multi = runs !== undefined && runs > 1 && wouldRunout ? this.applyRuns(rawHand, runs) : null;
    const h = multi ? this.handState() : rawHand;
    const showdown = wentToShowdown(h);
    const remaining = h.board.length - this.revealedBoard;
    const step = (ms: number) => this.scaled(ms);
    this.lastEquity = this.allInEquity(h, showdown, showdown && remaining > 0 && this.lastState !== null && this.wasRunout(this.lastState));
    // Showdown podle pravidel: výherci a první, kdo ukazuje, ukázat musí; ostatní smějí odhodit karty (muck) podle svého nastavení.
    const runoutEarly = showdown && remaining > 0 && this.lastState !== null && this.wasRunout(this.lastState);
    this.mucked = new Set();
    this.choice = null;
    const plan = showdown && !runoutEarly ? this.planShowdown(h, s) : null;
    if (plan) this.mucked = plan.mucked;
    const emitEnd = (): void => {
      this.opt.onEvent?.({
        type: 'handEnd',
        handId: h.handId,
        board: h.board,
        winners: (h.winners ?? []).map(({ seat, amount, handName }) => ({ seat, amount, handName })),
        showdown,
        record: {
          handNumber: h.handNumber,
          buttonSeat: h.buttonSeat,
          runs: multi ? multi.length : 1,
          allInEquity: this.lastEquity,
          players: h.players.map((p) => ({
            seat: p.seat,
            userId: p.playerId,
            name: p.name,
            startStack: this.startStacks.get(p.playerId) ?? p.stack + p.invested + p.dead,
            invested: p.invested + p.dead,
            won: (h.winners ?? []).filter((w) => w.seat === p.seat).reduce((n, w) => n + w.amount, 0),
            status: p.status,
            hole: p.hole,
            revealed: showdown && p.status !== 'folded' && p.status !== 'sittingOut' && !!p.hole && !this.mucked.has(p.seat),
            ...this.strength(p, h, showdown),
          })),
        },
      });
    };
    if (!plan || plan.deciding.size === 0) {
      emitEnd();
      this.announceMucks(h);
    }
    if (showdown) this.pipeline.run('onShowdown', this.moduleCtx(), h);
    this.pipeline.run('afterPotAwarded', this.moduleCtx(), h);
    const pre = this.lastState;
    const runout = showdown && remaining > 0 && pre !== null && this.wasRunout(pre);
    this.phase = runout ? 'runout' : 'pause';

    let t = 0;
    const at = (delay: number, fn: () => void) => {
      t += delay;
      if (t === 0) fn();
      else this.later(t, fn);
    };

    if (runout) {
      // všichni zbývající jsou all-in: karty se otočí a dokládá se po ulicích
      this.reveal = { boardCards: this.revealedBoard, holeCards: true, winners: false };
      this.computeOddsNow(h, this.revealedBoard);
      this.changed();
      const streets: number[] = [];
      let shown = this.revealedBoard;
      if (shown < 3) streets.push(3);
      if (shown < 4) streets.push(4);
      if (shown < 5) streets.push(5);
      for (const n of streets) {
        const delay = n === 5 ? num(s, 'time.allInRiverDramaMs') || num(s, 'time.allInRunoutDelayMs') : num(s, 'time.allInRunoutDelayMs');
        at(step(delay), () => {
          this.reveal = { ...this.reveal, boardCards: n };
          this.computeOddsNow(h, n);
          this.changed();
        });
      }
      shown = 5;
      if (multi) {
        // Run it twice/třikrát: po prvním běhu se jeden po druhém ukážou další běhy, nakonec se přesune pot.
        at(step(num(s, 'time.showdownMs')), () => {
          this.reveal = { boardCards: h.board.length, holeCards: true, winners: false, runs: 1 };
          this.oddsCache = null;
          this.changed();
        });
        for (let r = 2; r <= multi.length; r++) {
          at(step(num(s, 'time.runItDelayMs')), () => {
            this.reveal = { ...this.reveal, runs: r };
            this.changed();
          });
        }
        at(step(num(s, 'time.showdownMs')), () => {
          this.reveal = { boardCards: h.board.length, holeCards: true, winners: true, runs: multi.length };
          this.phase = 'pause';
          this.changed();
        });
      } else {
        at(step(num(s, 'time.showdownMs')), () => {
          this.reveal = { boardCards: h.board.length, holeCards: true, winners: true };
          this.oddsCache = null;
          this.phase = 'pause';
          this.changed();
        });
      }
      at(step(num(s, 'time.potToWinnerMs')), () => this.finishHand());
    } else {
      this.reveal = { boardCards: h.board.length, holeCards: showdown, winners: true };
      this.oddsCache = null;
      if (plan && plan.deciding.size > 0) {
        this.startChoice(plan.deciding, emitEnd, h, step(num(s, 'time.showdownMs')), num(s, 'time.showdownChoiceMs'));
        return;
      }
      if (!showdown) this.autoShowWinners(h, s);
      this.changed();
      at(showdown ? step(num(s, 'time.showdownMs')) : 0, () => this.finishHand());
    }
  }

  /** Kdo na showdownu musí ukázat a kdo smí odhodit karty; podle osobního nastavení se hned odhodí, nebo se hráč bude ptát. */
  private planShowdown(h: HandState, s: SettingValues): { mucked: Set<number>; deciding: Set<number> } {
    const mucked = new Set<number>();
    const deciding = new Set<number>();
    if (!s['special.muckAllowed']) return { mucked, deciding };
    const live = h.players.filter((p) => p.status !== 'folded' && p.status !== 'sittingOut' && !!p.hole);
    const winners = new Set((h.winners ?? []).filter((w) => w.amount > 0).map((w) => w.seat));
    const first = this.firstToShow(h, live.map((p) => p.seat));
    for (const p of live) {
      if (winners.has(p.seat) || p.seat === first || p.status === 'allIn') continue;
      const pref = String(this.opt.userPref?.(p.playerId, 'ui.showdownLosing') ?? 'show');
      if (pref === 'muck') mucked.add(p.seat);
      else if (pref === 'ask') deciding.add(p.seat);
    }
    return { mucked, deciding };
  }

  /** První na showdownu: poslední agresor na riveru, jinak první živý hráč po buttonu. */
  private firstToShow(h: HandState, liveSeats: number[]): number | null {
    const a = this.lastAggressor;
    if (a && a.street === 'RIVER' && liveSeats.includes(a.seat)) return a.seat;
    const sorted = [...liveSeats].sort((x, y) => x - y);
    const b = h.buttonSeat ?? -1;
    return sorted.find((x) => x > b) ?? sorted[0] ?? null;
  }

  private announceMucks(h: HandState): void {
    for (const p of h.players) if (this.mucked.has(p.seat)) this.opt.onEvent?.({ type: 'mucked', userId: p.playerId });
  }

  /** Čekání na rozhodnutí hráčů (ukázat / muck); po čase nebo po posledním rozhodnutí se handa dokončí. */
  private startChoice(seats: Set<number>, emitEnd: () => void, h: HandState, afterMs: number, ms: number): void {
    const token = ++this.choiceSeq;
    this.choice = { token, seats: new Set(seats), deadline: this.opt.clock.now() + ms, emitEnd: () => { emitEnd(); this.announceMucks(this.handState()); }, afterMs };
    this.changed();
    this.later(ms, () => {
      if (this.choice?.token === token) this.resolveChoice();
    });
  }

  private resolveChoice(): void {
    const c = this.choice;
    if (!c) return;
    this.choice = null;
    for (const seat of c.seats) this.mucked.add(seat);
    c.emitEnd();
    this.changed();
    this.later(c.afterMs, () => this.finishHand());
  }

  /** Hráč na showdownu rozhodne, zda ukáže karty, nebo je odhodí (muck). */
  showdownChoice(userId: string, choice: 'show' | 'muck'): void {
    this.guard(() => {
      const c = this.choice;
      if (!c) throw new GameError('NOT_ALLOWED');
      const p = this.handState().players.find((x) => x.playerId === userId);
      if (!p || !c.seats.has(p.seat)) throw new GameError('NOT_ALLOWED');
      c.seats.delete(p.seat);
      if (choice === 'muck') this.mucked.add(p.seat);
      if (c.seats.size === 0) this.resolveChoice();
      else this.changed();
    });
  }

  /** Výherce bez showdownu: kdo má v nastavení „ukazovat výherní karty vždy“, ukáže je sám. */
  private autoShowWinners(h: HandState, s: SettingValues): void {
    if (!s['special.showCards']) return;
    for (const p of h.players) {
      if (p.status === 'folded' || p.status === 'sittingOut' || !p.hole) continue;
      if (!(h.winners ?? []).some((w) => w.seat === p.seat && w.amount > 0)) continue;
      if (String(this.opt.userPref?.(p.playerId, 'ui.showdownWinning') ?? 'never') !== 'always') continue;
      this.shown.set(p.seat, [p.hole[0], p.hole[1]]);
      this.opt.onEvent?.({ type: 'shown', userId: p.playerId, which: 'both' });
    }
  }

  /** Dokládání po all-inu: před koncem handy už nikdo nemohl ovlivnit výsledek. */
  private wasRunout(pre: HandState): boolean {
    return allInRunout(pre) || pre.players.filter((p) => p.status === 'allIn').length >= 1;
  }

  private rakeRules(s: SettingValues): RakeRules {
    return { enabled: !!s['rake.enabled'], percent: num(s, 'rake.percent'), capChips: num(s, 'rake.cap') * this.rate(), noFlopNoDrop: !!s['rake.noFlopNoDrop'], rate: this.rate() };
  }

  private jackpotRules(s: SettingValues): JackpotRules {
    return {
      royalFlush: { enabled: !!s['jackpot.royalFlushEnabled'], percent: num(s, 'jackpot.royalFlushPercent') },
      badBeat: {
        enabled: !!s['jackpot.badBeatEnabled'],
        percent: num(s, 'jackpot.badBeatPercent'),
        minHand: s['jackpot.badBeatMinHand'] === 'straightFlush' ? 'straightFlush' : 'quads',
        loserShare: num(s, 'jackpot.badBeatLoserShare'),
        winnerShare: num(s, 'jackpot.badBeatWinnerShare'),
      },
    };
  }

  /**
   * Rake a jackpoty po skončené handě. Žetony se strhávají z výher (jako záporné „čekající žetony“, které se
   * připíšou při předělu) a stejnou částku hned přesune účetní kniha ze stolu domu a do jackpotového fondu.
   */
  private settleRakeAndJackpots(): void {
    if (this.opt.tournament) return;
    const s = this.opt.settings();
    const h = this.handState();
    const rate = this.rate();
    const fundId = String(s['rake.jackpotFundId'] || 'jackpot');
    const key = (what: string) => `${what}:${this.opt.tableId}:${h.handId}`;
    const rake = computeRake(h, this.rakeRules(s));
    if (rake.total > 0) {
      const jackpotChips = Math.floor((rake.total * num(s, 'rake.jackpotPercent')) / 100 / rate) * rate;
      this.opt.cash.rake(this.opt.tableId, (rake.total - jackpotChips) / rate, jackpotChips / rate, fundId, key('rake'));
      for (const [id, cut] of rake.byUser) {
        const e = this.seats.get(id);
        if (e) e.pendingChips -= cut;
      }
      this.opt.onEvent?.({ type: 'rake', handId: h.handId, total: rake.total / rate, jackpot: jackpotChips / rate });
      // Rakeback: část rake se vrací těm, kdo ho zaplatili (podle vkladu do potu), nejvýš z podílu herny.
      const backPct = num(s, 'rake.rakebackPercent');
      if (backPct > 0) {
        let budget = rake.total - jackpotChips;
        for (const [id, c] of rake.contrib) {
          const e = this.seats.get(id);
          const back = Math.min(budget, Math.floor((c * backPct) / 100 / rate) * rate);
          if (!e || back <= 0) continue;
          this.opt.cash.rakeback(this.opt.tableId, back / rate, key(`rakeback:${id}`));
          e.pendingChips += back;
          budget -= back;
        }
      }
    }
    if (s['jackpot.highHandEnabled'] && wentToShowdown(h)) this.trackHighHand(h, s);
    const rules = this.jackpotRules(s);
    if (!rules.royalFlush.enabled && !rules.badBeat.enabled) return;
    if (!wentToShowdown(h)) return;
    for (const award of jackpotAwards(h, rules, this.opt.cash.fundBalance(fundId))) {
      const list: { userId: string; amount: number }[] = [];
      for (const [id, currency] of award.payouts) {
        const e = this.seats.get(id);
        if (!e || currency <= 0) continue;
        this.opt.cash.jackpotPay(this.opt.tableId, fundId, currency, key(`jackpot:${award.kind}:${id}`), award.kind);
        e.pendingChips += currency * rate;
        list.push({ userId: id, amount: currency });
      }
      if (list.length) this.opt.onEvent?.({ type: 'jackpot', handId: h.handId, kind: award.kind, payouts: list });
    }
  }

  /** High hand: nejlepší ruka na showdownu (obě karty z ruky) za období; na konci období ji stůl odmění z jackpotu. */
  private trackHighHand(h: HandState, s: SettingValues): void {
    if (h.board.length < 5) return;
    for (const p of h.players) {
      if (!p.hole || p.status === 'folded' || p.status === 'sittingOut') continue;
      const a = assess(p.hole, h.board);
      if (!a || !a.usesBothHole) continue;
      if (!this.highHand || a.score < this.highHand.score) this.highHand = { userId: p.playerId, score: a.score };
    }
    if (this.highHand && !this.highHandTimer) {
      this.highHandTimer = true;
      this.later(num(s, 'jackpot.highHandMinutes') * 60_000, () => this.payHighHand());
    }
  }

  private payHighHand(): void {
    this.highHandTimer = false;
    const winner = this.highHand;
    this.highHand = null;
    if (!winner) return;
    const s = this.opt.settings();
    const fundId = String(s['rake.jackpotFundId'] || 'jackpot');
    const amount = Math.floor((this.opt.cash.fundBalance(fundId) * num(s, 'jackpot.highHandPercent')) / 100);
    if (amount <= 0) return;
    const key = `highhand:${this.opt.tableId}:${this.opt.clock.now()}:${winner.userId}`;
    const e = this.seats.get(winner.userId);
    if (e) {
      this.opt.cash.jackpotPay(this.opt.tableId, fundId, amount, key, 'highHand');
      e.pendingChips += amount * this.rate();
      this.persist();
    } else {
      this.opt.cash.jackpotToWallet(winner.userId, fundId, amount, key, this.opt.tableId);
    }
    this.opt.onEvent?.({ type: 'jackpot', handId: '', kind: 'highHand', payouts: [{ userId: winner.userId, amount }] });
    this.changed();
  }

  /** Poplatek za čas u stolu: po uplynutí intervalu se každému sedícímu hráči strhne pevná částka. */
  private chargeTime(): void {
    const s = this.opt.settings();
    if (this.opt.tournament || !s['rake.timeChargeEnabled']) return;
    const now = this.opt.clock.now();
    if (this.lastTimeCharge === null) {
      this.lastTimeCharge = now;
      return;
    }
    const interval = num(s, 'rake.timeChargeMinutes') * 60_000;
    if (now - this.lastTimeCharge < interval) return;
    this.lastTimeCharge = now;
    const rate = this.rate();
    for (const e of this.seats.values()) {
      if (e.mode !== 'in') continue;
      const take = Math.min(num(s, 'rake.timeChargeAmount') * rate, Math.floor(e.chips / rate) * rate);
      if (take <= 0) continue;
      this.opt.cash.timeCharge(this.opt.tableId, take / rate, `timecharge:${this.opt.tableId}:${now}:${e.userId}`);
      e.chips -= take;
    }
  }

  /** 7-2 bonus: kdo vyhraje handu s ruční sedmou a dvojkou (různé barvy), dostane od ostatních hráčů v handě bonus. */
  private settleSevenTwo(): void {
    const s = this.opt.settings();
    if (this.opt.tournament || !s['special.sevenTwoBonus']) return;
    const h = this.handState();
    if (s['special.sevenTwoNeedsShowdown'] && !wentToShowdown(h)) return;
    const bonus = num(s, 'special.sevenTwoAmountBb') * num(s, 'table.bigBlind');
    const winSeats = new Set((h.winners ?? []).filter((w) => w.amount > 0).map((w) => w.seat));
    for (const w of h.players.filter((p) => winSeats.has(p.seat) && p.hole)) {
      const [a, b] = w.hole!;
      const ranks = [a[0], b[0]].sort().join('');
      if (ranks !== '27' || a[1] === b[1]) continue;
      const winner = this.seats.get(w.playerId);
      if (!winner) continue;
      let total = 0;
      for (const p of h.players) {
        if (p.playerId === w.playerId || !p.hole) continue;
        const payer = this.seats.get(p.playerId);
        if (!payer) continue;
        const available = (this.adapter.stackOf(p.playerId) ?? payer.chips) + payer.pendingChips;
        const pay = Math.max(0, Math.min(bonus, available));
        payer.pendingChips -= pay;
        total += pay;
      }
      if (total > 0) {
        winner.pendingChips += total;
        this.opt.onEvent?.({ type: 'bonus', kind: 'sevenTwo', userId: w.playerId, amount: total });
      }
    }
  }

  private finishHand(): void {
    this.settleSevenTwo();
    this.settleRakeAndJackpots();
    this.pipeline.run('onHandEnd', this.moduleCtx(), this.handState());
    this.phase = 'pause';
    this.persistBoundaryState();
    this.scheduleNextHand(true);
    this.changed();
  }

  private persistBoundaryState(): void {
    // chips v registru se aktualizují v boundary(); zde jen uložíme poslední známý stav
    this.persist();
  }

  private computeOddsNow(h: HandState, boardCards: number): void {
    const s = this.opt.settings();
    if (!s['odds.enabled']) {
      this.oddsCache = null;
      return;
    }
    const live = h.players.filter((p) => (p.status === 'active' || p.status === 'allIn') && p.hole);
    if (live.length < 2) {
      this.oddsCache = null;
      return;
    }
    const pots = computeSidePots(h);
    if (pots[0]) pots[0] = { ...pots[0], amount: pots[0].amount + h.deadMoney };
    if (pots.length === 0) {
      this.oddsCache = null;
      return;
    }
    const board = h.board.slice(0, boardCards);
    const result = computeOdds(
      live.map((p) => ({ seat: p.seat, hole: p.hole! })),
      board,
      pots.map((p) => ({ seats: p.eligibleSeats })),
      { maxExactCombos: num(s, 'odds.maxExactCombos'), simulations: num(s, 'odds.simulations') },
    );
    this.oddsCache = result.map((r) => ({ pot: r.pot, amount: pots[r.pot]!.amount, entries: r.entries }));
  }

  // ---------- peníze ----------

  private cashOutAndRemove(e: SeatEntry, kind: 'cash_cashout' | 'cash_return' = 'cash_cashout', midHand = this.phase === 'hand'): void {
    // Uprostřed handy se vrací stav z posledního předělu (žetony v potu nejsou nikde ztracené).
    const engineStack = this.adapter.stackOf(e.userId);
    const useEngine = engineStack !== null && !midHand;
    const chips = (useEngine ? engineStack : e.chips) + e.pendingChips;
    if (engineStack !== null) {
      try {
        this.adapter.unseat(e.userId);
      } catch (err) {
        // Zrušení stolu uprostřed handy: engine hráče s all-inem nepustí, ale celá handa se stejně zahazuje a žetony se vrací z posledního předělu.
        if (!(midHand && this.phase === 'stopped')) throw err;
      }
    }
    if (this.opt.tournament) {
      this.seats.delete(e.userId);
      this.opt.onEvent?.({ type: 'seat', userId: e.userId, seat: e.seat, change: 'leave', chips: 0 });
      this.persist();
      return;
    }
    this.opt.cash.cashOut(e.userId, this.opt.tableId, chips, `cashout:${this.opt.tableId}:${e.userId}:${randomUUID()}`, kind);
    this.recentLeaves.push({ userId: e.userId, chips, at: this.opt.clock.now() });
    if (this.recentLeaves.length > 200) this.recentLeaves.shift();
    this.seats.delete(e.userId);
    this.opt.onEvent?.({ type: 'seat', userId: e.userId, seat: e.seat, change: 'leave', chips });
    this.persist();
  }

  private checkHitAndRun(userId: string, chips: number, s: SettingValues): void {
    if (!s['cash.hitAndRunProtection']) return;
    const windowMs = num(s, 'cash.hitAndRunMinutes') * 60_000;
    const now = this.opt.clock.now();
    const last = [...this.recentLeaves].reverse().find((l) => l.userId === userId && now - l.at < windowMs);
    if (last && chips < last.chips) throw new GameError('HIT_AND_RUN', undefined, { min: last.chips });
  }

  private scheduleMaxSitOut(e: SeatEntry): void {
    if (this.opt.tournament) return;
    const ms = num(this.opt.settings(), 'cash.maxSitOutMinutes') * 60_000;
    const since = e.outSince;
    this.later(ms, () => {
      const cur = this.seats.get(e.userId);
      if (!cur || cur.mode !== 'out' || cur.outSince !== since) return;
      if (this.phase === 'hand' || this.phase === 'runout') {
        cur.mode = 'leaving';
        return;
      }
      this.cashOutAndRemove(cur);
      this.changed();
    });
  }
}
