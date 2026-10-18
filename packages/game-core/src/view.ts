import { describeHand } from './hand-names.js';
import { bestFive } from './runs.js';
import type { VoteView } from './voting.js';
import type { HandDescription } from './hand-names.js';
import type { Card, HandState, LegalActions, SeatView, TableInfo, TableView } from './types.js';

/** Co už se smí hráčům ukázat (řídí tempo dokládání karet a showdownu). */
export interface Reveal {
  /** Kolik karet boardu je už odhaleno. */
  boardCards: number;
  /** Karty hráčů, kteří jsou ve hře, se otočily (showdown, nebo all-in). */
  holeCards: boolean;
  /** Výherci a přesun potu. */
  winners: boolean;
  /** Run it twice: kolik běhů je už ukázáno (včetně jejich výherců). */
  runs?: number;
}

export const FULL_REVEAL = (h: HandState): Reveal => ({ boardCards: h.board.length, holeCards: true, winners: true });

export interface ViewContext {
  seq: number;
  info: TableInfo;
  /** Id hráče, pro kterého se pohled staví; null = divák. */
  viewerId: string | null;
  deadline: number | null;
  reveal: Reveal;
  legal: LegalActions | null;
  odds: TableView['odds'];
  bankActive?: boolean;
  clockCalled?: boolean;
  vote?: VoteView | null;
  rabbit?: Card[] | null;
  bombPot?: boolean;
  /** Dobrovolně ukázané karty po handě podle sedadla. */
  exposed?: Map<number, (Card | null)[]>;
  /** Výsledky běhů run it twice (celé; viditelné se oříznou podle reveal.runs). */
  runs?: { board: Card[]; winners: { seat: number; amount: number; hand: HandDescription | null }[] }[] | null;
  /** Výherci tak, jak je spočítal engine (základ stacků před odhalením, pokud se výsledek přepočítal). */
  engineWinners?: HandState['winners'];
  /** Skutečná rezerva času podle registru stolu (v sekundách); engine má jen počáteční hodnotu. */
  timeBanks?: Map<string, number>;
  /** Bounty (hlava) hráčů v turnaji. */
  bounties?: Map<string, number | null>;
  wanted?: Map<string, number>;
  /** Sedadla mimo aktuální handu (čekají na další handu, sit out). */
  extraSeats?: SeatView[];
  /** Nový hráč čekající na big blind se zobrazí jako „čeká“, ne jako sit out. */
  myStraddle?: boolean;
  statusOverride?: Map<string, SeatView['status']>;
  /** Hráči v sit outu podle registru (příznak `sitOut` u sedadla). */
  sitOuts?: Set<string>;
  paused?: boolean;
  /** Showdown: sedadla, která odhodila karty (muck), a ta, která se ještě rozhodují (jejich karty zatím nikdo nevidí). */
  mucked?: Set<number>;
  deciding?: Set<number>;
  choiceDeadline?: number | null;
}

/** Zda handa skončila showdownem (ne tím, že všichni ostatní složili). */
export function wentToShowdown(h: HandState): boolean {
  return h.finished && h.players.filter((p) => p.status !== 'folded' && p.status !== 'sittingOut' && p.hole).length >= 2;
}

/**
 * Sestaví pohled na stůl. Pole se přenáší výhradně whitelistem: engine-specifické ani skryté
 * údaje (balíček, cizí karty, historie) se do výstupu nikdy nedostanou.
 */
export function buildView(h: HandState | null, ctx: ViewContext): TableView {
  if (!h) {
    return {
      seq: ctx.seq,
      info: ctx.info,
      handId: null,
      handNumber: 0,
      street: null,
      board: [],
      buttonSeat: null,
      straddleSeat: null,
      actingSeat: null,
      deadline: null,
      bankActive: false,
      clockCalled: false,
      vote: ctx.vote ?? null,
      rabbit: null,
      bombPot: false,
      runs: null,
      paused: ctx.paused ?? false,
      seats: (ctx.extraSeats ?? []).map((x) => ({ ...x, cards: ctx.viewerId === x.playerId ? x.cards : null })),
      pots: [],
      totalPot: 0,
      winners: null,
      legal: null,
      viewerSeat: (ctx.extraSeats ?? []).find((x) => x.playerId === ctx.viewerId)?.seat ?? null,
      myStraddle: ctx.myStraddle ?? false,
      odds: null,
    };
  }
  const viewer = ctx.viewerId ? h.players.find((p) => p.playerId === ctx.viewerId) : undefined;
  const showdown = wentToShowdown(h);
  const winnersVisible = h.finished ? ctx.reveal.winners : false;
  const won = new Map<number, number>();
  for (const w of h.winners ?? []) won.set(w.seat, (won.get(w.seat) ?? 0) + w.amount);
  const engineWon = new Map<number, number>();
  for (const w of ctx.engineWinners ?? h.winners ?? []) engineWon.set(w.seat, (engineWon.get(w.seat) ?? 0) + w.amount);

  const seats: SeatView[] = h.players.map((p) => {
    const own = viewer?.seat === p.seat;
    const inHand = p.status !== 'folded' && p.status !== 'sittingOut';
    const hidden = !!ctx.mucked?.has(p.seat) || !!ctx.deciding?.has(p.seat);
    const revealedToAll = ctx.reveal.holeCards && inHand && (showdown || allInRunout(h)) && !!p.hole && !hidden;
    const showCards = (own || revealedToAll) && p.hole ? p.hole : null;
    // Před odhalením výherců se stack zobrazuje bez právě vyhraného potu.
    const stack = h.finished ? p.stack - (engineWon.get(p.seat) ?? 0) + (winnersVisible ? (won.get(p.seat) ?? 0) : 0) : p.stack;
    return {
      seat: p.seat,
      playerId: p.playerId,
      name: p.name,
      stack,
      bet: h.finished ? 0 : p.bet,
      status: p.status === 'sittingOut' && ctx.statusOverride?.has(p.playerId) ? (ctx.statusOverride.get(p.playerId) as SeatView['status']) : p.status,
      isDealer: h.buttonSeat === p.seat,
      cards: showCards ? ([showCards[0], showCards[1]] as [Card, Card]) : null,
      hasCards: !!p.hole && p.status !== 'sittingOut',
      timeBank: ctx.timeBanks?.get(p.playerId) ?? p.timeBank,
      ...(ctx.bounties?.get(p.playerId) != null ? { bounty: ctx.bounties.get(p.playerId)! } : {}),
      ...((ctx.wanted?.get(p.playerId) ?? 0) > 0 ? { wanted: ctx.wanted!.get(p.playerId)! } : {}),
      ...(h.finished && ctx.exposed?.has(p.seat) ? { exposed: ctx.exposed.get(p.seat)! } : {}),
      ...(ctx.sitOuts?.has(p.playerId) ? { sitOut: true } : {}),
      ...(h.finished && showdown && ctx.mucked?.has(p.seat) ? { reveal: 'muck' as const } : h.finished && showdown && ctx.deciding?.has(p.seat) ? { reveal: 'deciding' as const } : {}),
    };
  });
  for (const x of ctx.extraSeats ?? []) if (!seats.some((s) => s.seat === x.seat)) seats.push(x);
  seats.sort((a, b) => a.seat - b.seat);

  const potFromWinners = (h.winners ?? []).reduce((n, w) => n + w.amount, 0);
  const pots =
    h.finished && !winnersVisible ? [{ amount: potFromWinners, eligibleSeats: h.players.map((p) => p.seat) }] : h.finished ? [] : h.pots;
  const totalPot = h.finished && !winnersVisible ? potFromWinners : pots.reduce((n, p) => n + p.amount, 0) + h.players.reduce((n, p) => n + p.bet, 0);

  return {
    seq: ctx.seq,
    info: ctx.info,
    handId: h.handId,
    handNumber: h.handNumber,
    street: h.street,
    board: h.board.slice(0, ctx.reveal.boardCards),
    buttonSeat: h.buttonSeat,
    straddleSeat: h.straddleSeat,
    actingSeat: h.finished ? null : h.actingSeat,
    deadline: h.finished ? null : ctx.deadline,
    bankActive: h.finished ? false : (ctx.bankActive ?? false),
    clockCalled: h.finished ? false : (ctx.clockCalled ?? false),
    vote: ctx.vote ?? null,
    rabbit: h.finished ? (ctx.rabbit ?? null) : null,
    bombPot: ctx.bombPot ?? false,
    paused: ctx.paused ?? false,
    runs: ctx.runs && ctx.runs.length > 1 && (ctx.reveal.runs ?? 0) > 0 ? ctx.runs.slice(0, ctx.reveal.runs) : null,
    seats,
    pots,
    totalPot,
    winners: winnersVisible && h.winners
        ? h.winners.map(({ seat, amount, cards }) => ({ seat, amount, hand: showdown && cards ? describeHand(cards) : null }))
        : null,
    legal: viewer && ctx.legal ? ctx.legal : null,
    showdownChoice: viewer && ctx.deciding?.has(viewer.seat) && ctx.choiceDeadline ? { deadline: ctx.choiceDeadline } : null,
    viewerSeat: viewer?.seat ?? (ctx.extraSeats ?? []).find((x) => x.playerId === ctx.viewerId)?.seat ?? null,
    myStraddle: ctx.myStraddle ?? false,
    odds: ctx.odds,
    myBest: myBestHand(viewer, h.board.slice(0, ctx.reveal.boardCards)),
  };
}

/** Nejlepší kombinace, kterou má hráč právě teď (jen jeho vlastní karty a odhalený board; od flopu). */
function myBestHand(viewer: HandState['players'][number] | undefined, board: Card[]): HandDescription | null {
  if (!viewer?.hole || viewer.status === 'folded' || viewer.status === 'sittingOut' || board.length < 3) return null;
  return describeHand(bestFive(viewer.hole, board).cards);
}

/**
 * Nikdo už nemůže hru ovlivnit: nanejvýš jeden hráč s žetony, ostatní jsou all-in,
 * a handa ještě nemá všech pět karet (nebo je dohrávána).
 */
export function allInRunout(h: HandState): boolean {
  const live = h.players.filter((p) => p.status === 'active' || p.status === 'allIn');
  const canAct = live.filter((p) => p.status === 'active');
  const facesBet = canAct.some((p) => p.bet < h.currentBet);
  return live.length >= 2 && canAct.length <= 1 && !facesBet && live.some((p) => p.status === 'allIn');
}
