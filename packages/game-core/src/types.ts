import type { VoteView } from './voting.js';
import type { HandDescription } from './hand-names.js';

/** Karta ve tvaru "As", "Td", "2c" (hodnota + barva). */
export type Card = string;

export type Street = 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN';

export type SeatStatus = 'active' | 'folded' | 'allIn' | 'sittingOut' | 'waiting';

/** Akce hráče. `amount` u bet/raise je celková sázka na tuto ulici (raise-to), ne přírůstek. */
export type PlayerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'bet'; amount: number }
  | { type: 'raise'; amount: number }
  | { type: 'allIn' };

/** Kód chyby pro klienta (překládá se v UI). */
export class GameError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

/** Neutrální (na enginu nezávislý) serverový stav handy. Obsahuje tajná data, nikdy ho neposílat klientovi. */
export interface HandState {
  handId: string;
  handNumber: number;
  street: Street;
  board: Card[];
  buttonSeat: number | null;
  actingSeat: number | null;
  players: HandPlayer[];
  pots: { amount: number; eligibleSeats: number[] }[];
  /** Po skončení handy: kolik kdo vyhrál (podle sedadla). */
  winners: { seat: number; amount: number; handName: string | null; cards: Card[] | null }[] | null;
  finished: boolean;
  minRaiseTo: number;
  currentBet: number;
  /** Mrtvé peníze v potu (big blind ante, dead blind), které připadnou vítězi hlavního potu. */
  deadMoney: number;
  /** Sedadlo, které zaplatilo straddle. */
  straddleSeat: number | null;
}

export interface HandPlayer {
  seat: number;
  playerId: string;
  name: string;
  stack: number;
  /** Sázka na aktuální ulici. */
  bet: number;
  /** Celkem vloženo do handy. */
  invested: number;
  status: SeatStatus;
  /** Skryté karty (jen server). null = nerozdané. */
  hole: [Card, Card] | null;
  timeBank: number;
  /** Mrtvé peníze, které hráč do potu zaplatil (mimo sázky). */
  dead: number;
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  callAmount: number;
  canBet: boolean;
  canRaise: boolean;
  /** Minimální a maximální celková sázka (raise-to / bet-to). */
  minRaiseTo: number;
  maxRaiseTo: number;
}

/** Co se klientovi posílá o jednom sedadle. */
export interface SeatView {
  seat: number;
  playerId: string;
  name: string;
  stack: number;
  bet: number;
  status: SeatStatus;
  isDealer: boolean;
  /** Karty: vlastní, nebo odhalené při showdownu; jinak null. */
  cards: [Card, Card] | null;
  /** Hráč má karty (rub se vykreslí), i když je nevidíme. */
  hasCards: boolean;
  /** Zbývající time bank v sekundách. */
  timeBank: number;
  /** Bounty (hlava) hráče v turnaji s fixní nebo progresivní bounty. */
  bounty?: number;
  /** Součet odměn na hlavu, které vypsali jiní hráči (štítek „hledaný“). */
  wanted?: number;
  /** Karty, které hráč dobrovolně ukázal po handě (nezobrazené jsou null). */
  exposed?: (Card | null)[];
  /** Hráč je v sit outu podle registru stolu (platí i během rozehrané handy, kde `status` ještě ukazuje stav v handě). */
  sitOut?: boolean;
  /** Showdown: hráč odhodil karty (muck), nebo se ještě rozhoduje, zda je ukáže. */
  reveal?: 'muck' | 'deciding';
}

/** Pohled na stůl pro konkrétního hráče nebo diváka. Sestavuje se výhradně whitelistem polí. */
export interface TableInfo {
  /** Turnaj, ke kterému stůl patří (u turnajových stolů). */
  tournamentId?: string;
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  /** Hranice buy-inu v žetonech a kurz žetonů vůči měně. */
  minBuyIn: number;
  maxBuyIn: number;
  chipsPerCurrencyUnit: number;
  topUpEnabled: boolean;
  rebuyEnabled: boolean;
  currencySymbol: string;
  /** Tvary názvu měny (1 / 2 až 4 / 5 a více), např. Korona, Korony, Koron. */
  currencyForms: [string, string, string];
  currencyDecimals: number;
  /** Vlastní označení žetonů u stolu (prázdné = nezobrazovat). */
  chipLabel?: string;
  /** Straddle u tohoto stolu: vypnutý, povinný, nebo dobrovolný (hráč si ho vyžádá). */
  straddle: 'off' | 'mandatory' | 'optional';
  /** Turnajový stůl: žetony nejsou měna. */
  tournament?: boolean;
  /** Sázkový limit u stolu. */
  bettingLimit?: 'noLimit' | 'potLimit' | 'fixedLimit';
  /** Hráči smějí zavolat čas na pomalého soupeře. */
  callClock?: boolean;
  /** Režim rezervy času (pool, chips, chess…, none); podle něj klient ukáže zbývající time bank. */
  timeBankMode?: string;
  /** Po handě lze ukázat karty / vyžádat rabbit hunt. */
  showCards?: boolean;
  rabbitHunt?: boolean;
  /** Rake u tohoto stolu (průhlednost pro hráče); chybí, když se nevybírá. */
  rake?: { percent: number; capChips: number; noFlopNoDrop: boolean };
  /** Stav jackpotového fondu v měně, pokud je u stolu nějaký jackpot zapnutý. */
  jackpot?: number;
  /** Ante (v žetonech; 0 = bez ante) a zda ho platí jen big blind. */
  ante?: number;
  bbAnte?: boolean;
  /** Speciální varianty: kolikrát se dokládá board při run it (0 = vypnuto), bomb pot každou N-tou handu (0 = vypnuto), 7-2 bonus v bb (0 = vypnuto). */
  runIt?: number;
  bombPotEvery?: number;
  sevenTwoBb?: number;
}

export interface TableView {
  seq: number;
  info: TableInfo;
  handId: string | null;
  handNumber: number;
  street: Street | null;
  board: Card[];
  buttonSeat: number | null;
  straddleSeat: number | null;
  actingSeat: number | null;
  /** Čas (epoch ms), do kdy musí hráč na tahu jednat. */
  deadline: number | null;
  /** Běží time bank (základní čas vypršel). */
  bankActive: boolean;
  /** Někdo zavolal čas: aktuální tah má zkrácený limit. */
  clockCalled: boolean;
  seats: SeatView[];
  pots: { amount: number; eligibleSeats: number[] }[];
  totalPot: number;
  winners: { seat: number; amount: number; hand: HandDescription | null }[] | null;
  /** Karty, které by přišly (rabbit hunt), po skončené handě. */
  rabbit: Card[] | null;
  /** Právě se hraje bomb pot. */
  bombPot: boolean;
  /** Stůl je pozastavený (pauza, přestávka): po dohrání handy se nerozdává. */
  paused?: boolean;
  /** Kdy začne další handa (epoch ms) po skončené handě; null, když se žádná nechystá (málo hráčů, pauza). */
  nextHandAt?: number | null;
  /** Showdown: kolik hráčů se ještě rozhoduje, zda ukáže karty, a dokdy (vidí všichni u stolu). */
  choice?: { deadline: number; count: number } | null;
  /** Běží hlasování (run it twice…), v němž může viewer hlasovat. */
  vote: VoteView | null;
  /** Run it twice/třikrát: boardy jednotlivých běhů a jejich výherci (jen odhalené běhy). */
  runs: { board: Card[]; winners: { seat: number; amount: number; hand: HandDescription | null }[] }[] | null;
  /** Akce pro sedadlo viewera, pokud je na tahu. */
  legal: LegalActions | null;
  /** Showdown: viewer smí rozhodnout, zda ukáže karty, nebo je odhodí (do `deadline`, jinak muck). */
  showdownChoice?: { deadline: number } | null;
  viewerSeat: number | null;
  /** Diváka/hráče: má vyžádaný dobrovolný straddle. */
  myStraddle: boolean;
  /** Hráč, který nesedí, ale nedávno od stolu odešel s větším stackem: s kolika žetony se musí vrátit (ochrana „hit and run“), jinak 0. Smí přesáhnout maximální buy-in. */
  returnStack: number;
  /** Šance na výhru (jen když to nastavení dovolí a nikdo už nemůže ovlivnit hru). */
  odds: { pot: number; amount: number; entries: { seat: number; win: number; tie: number }[] }[] | null;
  /** Nejlepší kombinace vlastních karet a odhaleného boardu (jen pro viewera, od flopu), jinak null. */
  myBest?: HandDescription | null;
}
