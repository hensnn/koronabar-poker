// Deep fuzz of a cash table: random combinations of settings (special features above all), bots that do everything a
// player can do, and after every step a set of rules that must hold. Unlike the basic harness it does not stop at
// "chips are neither created nor lost": it also watches that nobody sees cards they must not see, that the table never
// gets stuck, that the offered actions make sense and that the record of every hand adds up.
import { accounts, CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, resolveSettings, validateValues, type SettingValues } from '@kb/shared';
import { randomLegalAction, seededRandom } from './bot.js';
import { assess } from './rake.js';
import { FakeClock } from './clock.js';
import { TableActor, type HandRecordData, type TableEvent } from './table-actor.js';
import { GameError, type TableView } from './types.js';

const reg = createDefaultRegistry();
const USERS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'];
type Over = Record<string, number | boolean | string>;

export interface Finding {
  seed: number;
  step: number;
  rule: string;
  detail: string;
}

const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

/** A broad random combination of table settings; combinations the settings validation refuses are re-drawn. */
export function deepCombo(seed: number): Over {
  for (let attempt = 0; ; attempt++) {
    const rnd = seededRandom(seed * 104729 + attempt * 31 + 7);
    const bb = pick(rnd, [2, 4, 10, 20, 50, 100]);
    const rate = pick(rnd, [1, 1, 1, 2, 10]);
    const minBuy = pick(rnd, [5, 10, 20, 40]);
    const o: Over = {
      'table.seats': pick(rnd, [2, 3, 4, 6, 9, 10]),
      'table.bigBlind': bb,
      'table.smallBlind': pick(rnd, [Math.max(1, Math.floor(bb / 2)), Math.max(1, Math.floor(bb / 2)), bb]),
      'table.bettingLimit': pick(rnd, ['noLimit', 'noLimit', 'potLimit', 'fixedLimit'] as const),
      'table.limitMaxBets': pick(rnd, [1, 3, 4]),
      'table.ante': pick(rnd, [0, 0, 0, 1, bb]),
      'table.bbAnte': rnd() < 0.3,
      'table.deadButton': rnd() < 0.5,
      'table.straddleEnabled': rnd() < 0.45,
      'table.straddleType': pick(rnd, ['utg', 'mississippi'] as const),
      'table.straddleMandatory': rnd() < 0.25,
      'table.straddleMultiplier': pick(rnd, [2, 3, 5]),
      'cash.chipsPerCurrencyUnit': rate,
      'cash.minBuyInBb': minBuy,
      'cash.maxBuyInBb': minBuy * pick(rnd, [1, 2, 5, 10]),
      'cash.topUpEnabled': rnd() < 0.8,
      'cash.sitInWaitsForBb': rnd() < 0.3,
      'cash.hitAndRunProtection': rnd() < 0.3,
      'cash.hitAndRunMinutes': pick(rnd, [1, 30]),
      'time.turnSeconds': pick(rnd, [3, 5, 15]),
      'time.timeBankSeconds': pick(rnd, [0, 5, 30]),
      'time.timeoutsToSitOut': pick(rnd, [1, 2, 3]),
      'time.callClockEnabled': rnd() < 0.4,
      'time.callClockSeconds': pick(rnd, [1, 5]),
      'time.showCardsMs': pick(rnd, [0, 500, 3000]),
      'special.runItTwice': rnd() < 0.55,
      'special.runItTimes': pick(rnd, [2, 3]),
      'special.runItVoteSeconds': pick(rnd, [5, 8]),
      'special.rabbitHunt': rnd() < 0.5,
      'special.rabbitHuntSeconds': pick(rnd, [0, 2, 8]),
      'special.rabbitHuntWho': pick(rnd, ['participants', 'anyone'] as const),
      'special.muckAllowed': rnd() < 0.7,
      'special.showCards': rnd() < 0.6,
      'special.showCardsFolded': rnd() < 0.5,
      'special.sevenTwoBonus': rnd() < 0.35,
      'special.sevenTwoAmountBb': pick(rnd, [1, 5, 50]),
      'special.sevenTwoNeedsShowdown': rnd() < 0.5,
      'special.bombPot': rnd() < 0.35,
      'special.bombPotEveryHands': pick(rnd, [1, 2, 5]),
      'special.bombPotAnteBb': pick(rnd, [1, 2, 20]),
      'rake.enabled': rnd() < 0.6,
      'rake.percent': pick(rnd, [1, 5, 10]),
      'rake.cap': pick(rnd, [0, 1, 3, 100]),
      'rake.jackpotPercent': pick(rnd, [0, 30, 100]),
      'rake.rakebackPercent': pick(rnd, [0, 20, 100]),
      'rake.timeChargeEnabled': rnd() < 0.25,
      'rake.timeChargeMinutes': 1,
      'rake.timeChargeAmount': pick(rnd, [1, 3]),
      'jackpot.royalFlushEnabled': rnd() < 0.4,
      'jackpot.badBeatEnabled': rnd() < 0.4,
      'jackpot.badBeatMinHand': 'quads',
      'jackpot.highHandEnabled': rnd() < 0.4,
      'jackpot.highHandMinutes': 1,
      'odds.enabled': rnd() < 0.4,
    };
    const known = Object.fromEntries(Object.entries(o).filter(([k]) => reg.get(k)));
    if (validateValues(reg, known).length === 0 || attempt > 40) return known;
  }
}

const TIMING: Over = { 'time.betweenHandsMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'time.showdownMs': 50, 'time.potToWinnerMs': 50 };

interface HandBook {
  record: HandRecordData | null;
  rake: number;
  bonus: Map<string, number>;
  shown: Set<string>;
  winners: number;
  start: Map<string, number>;
}

/** What the watcher of one table needs from outside: how to report a broken rule. */
export type Report = (rule: string, detail: string) => void;

/**
 * Rules of one table that hold whatever game it is (cash or tournament): nobody sees cards they must not see, a hand in
 * progress never stands still, the offered actions make sense, the record of every hand adds up. Feed it the table's
 * events and call `check` after every step of the simulation.
 */
export function watchTable(table: () => TableActor, clock: FakeClock, report: Report, seats: () => number, trace?: (e: TableEvent) => void, deadMoney: () => boolean = () => false): { onEvent: (e: TableEvent) => void; check: () => void } {
  const books = new Map<string, HandBook>();
  const book = (id: string): HandBook => {
    let b = books.get(id);
    if (!b) books.set(id, (b = { record: null, rake: 0, bonus: new Map(), shown: new Set(), winners: 0, start: new Map() }));
    return b;
  };
  let currentHand: string | null = null;
  let lastFinished: string | null = null;
  const onEvent = (e: TableEvent) => {
    trace?.(e);
    if (e.type === 'moduleError') report('moduleError', `${e.moduleId}.${e.hook}: ${e.message}`);
    else if (e.type === 'handStart') {
      currentHand = e.handId;
      const b = book(e.handId);
      for (const p of e.players) b.start.set(p.userId, p.stack);
    } else if (e.type === 'handEnd') {
      const b = book(e.handId);
      b.record = e.record;
      b.winners = e.winners.reduce((n, w) => n + w.amount, 0);
      checkRecord(e.handId, e.board, b, e.showdown);
    } else if (e.type === 'rake') book(e.handId).rake += e.total;
    else if (e.type === 'bonus' && currentHand) book(currentHand).bonus.set(e.userId, (book(currentHand).bonus.get(e.userId) ?? 0) + e.amount);
    else if (e.type === 'shown' && currentHand) book(currentHand).shown.add(e.userId);
    else if (e.type === 'handFinished') lastFinished = e.handId;
  };

  /** The record of a finished hand must add up and must not hold the same card twice. */
  const checkRecord = (handId: string, board: string[], b: HandBook, showdown: boolean) => {
    const r = b.record!;
    const invested = r.players.reduce((n, p) => n + p.invested, 0);
    const won = r.players.reduce((n, p) => n + p.won, 0);
    for (const p of r.players) {
      if (p.invested < 0 || p.won < 0) report('record.negative', `${handId} ${p.userId} invested ${p.invested} won ${p.won}`);
      if (p.invested > p.startStack) report('record.investedOverStack', `${handId} ${p.userId} invested ${p.invested} of ${p.startStack}`);
    }
    // What the players won is exactly what they put in (the rake is taken separately, after the hand): the results in
    // the statistics are built from these numbers and must add up to zero.
    if (won !== invested) report('record.notZeroSum', `${handId} won ${won}, invested ${invested}: ${JSON.stringify(r.players.map((p) => [p.userId, p.invested, p.won, p.status]))}`);
    const holes = r.players.flatMap((p) => p.hole ?? []);
    const boards = r.runBoards?.length ? r.runBoards.map((x) => x.board) : [board];
    if (new Set(holes).size !== holes.length) report('cards.duplicateHole', `${handId} ${holes.join(' ')}`);
    for (const bd of boards) {
      if (bd.length > 5) report('cards.longBoard', `${handId} ${bd.join(' ')}`);
      if (new Set(bd).size !== bd.length) report('cards.duplicateOnBoard', `${handId} ${bd.join(' ')}`);
      const clash = bd.filter((c) => holes.includes(c));
      if (clash.length) report('cards.holeOnBoard', `${handId} ${clash.join(' ')}`);
    }
    if (r.runBoards && r.runBoards.length !== r.runs) report('record.runsMismatch', `${handId} runs ${r.runs} boards ${r.runBoards.length}`);

    // --- the showdown, judged by an evaluation of our own: the best hand never leaves empty-handed, and a hand beaten
    // on every board by somebody who put in at least as much never wins anything
    const contenders = r.players.filter((p) => p.hole && p.status !== 'folded' && p.status !== 'sittingOut');
    if (showdown && contenders.length >= 2 && boards.every((bd) => bd.length === 5)) {
      const score = (p: (typeof contenders)[number], bd: string[]) => assess(p.hole as never, bd as never)!.score;
      for (const p of contenders) {
        const best = boards.some((bd) => contenders.every((q) => score(p, bd) <= score(q, bd)));
        // (A pot smaller than the number of runs cannot give every run a chip: the odd chips go to the first board,
        // which is the usual rule. The check therefore needs a pot where every run is worth something to everybody.)
        const worthIt = Math.min(...contenders.map((q) => q.invested)) >= boards.length;
        if (best && worthIt && p.won === 0) report('showdown.bestHandWonNothing', `${handId} ${p.userId} ${p.hole!.join('')} on ${boards.map((x) => x.join('')).join(' | ')}: ${JSON.stringify(r.players.map((x) => [x.userId, x.hole?.join(''), x.invested, x.won, x.status]))}`);
        // Only where everything a player put in is a bet. With a big blind ante or a bomb pot a part of it is dead money,
        // which does not count towards the side pots: a short stack that paid the ante can lose a side pot it is not in.
        const beaten = !deadMoney() && contenders.some((q) => q !== p && q.invested >= p.invested && boards.every((bd) => score(q, bd) < score(p, bd)));
        if (beaten && p.won > 0) report('showdown.beatenHandWon', `${handId} ${p.userId} ${p.hole!.join('')} won ${p.won} on ${boards.map((x) => x.join('')).join(' | ')}: ${JSON.stringify(r.players.map((x) => [x.userId, x.hole?.join(''), x.invested, x.won, x.status]))}`);
      }
    }
    // --- nobody else in the hand: the last player standing takes everything
    if (contenders.length === 1 && contenders[0]!.won !== invested) report('record.loneWinner', `${handId} ${contenders[0]!.userId} won ${contenders[0]!.won} of ${invested}`);
  };

  let lastSeq = -1;
  let lastSeqAt = clock.now();
  const check = () => {
    const actor = table();
    const seatCount = seats;
    const spectator = actor.viewFor(null);
    const phase = actor.currentPhase();
    // --- the table moves on: a hand in progress never stands still far past the deadline of the player on turn
    if (spectator.seq !== lastSeq) {
      lastSeq = spectator.seq;
      lastSeqAt = clock.now();
    } else if ((phase === 'hand' || phase === 'runout') && clock.now() - lastSeqAt > 10 * 60_000) report('stuck', `phase ${phase}, hand ${spectator.handId}, acting ${spectator.actingSeat}, no change for ${Math.round((clock.now() - lastSeqAt) / 1000)} s`);

    // --- numbers in the view
    for (const s of spectator.seats) {
      if (s.stack < 0 || s.bet < 0) report('view.negative', `seat ${s.seat} stack ${s.stack} bet ${s.bet}`);
      if (s.seat < 0 || s.seat >= seatCount()) report('view.seatOutOfRange', `seat ${s.seat} of ${seatCount()}`);
    }
    if (new Set(spectator.seats.map((s) => s.seat)).size !== spectator.seats.length) report('view.duplicateSeat', spectator.seats.map((s) => s.seat).join(','));
    if (spectator.totalPot < 0 || spectator.pots.some((p) => p.amount < 0)) report('view.negativePot', JSON.stringify(spectator.pots));
    if (spectator.winners && new Set(spectator.winners.map((w) => w.seat)).size !== spectator.winners.length) report('view.duplicateWinner', JSON.stringify(spectator.winners));

    // --- what each viewer sees
    const betting = spectator.actingSeat !== null;
    const done = phase === 'pause' || phase === 'idle' ? books.get(spectator.handId ?? '') : undefined;
    // everybody at the table, one player who is not, and a spectator
    const sitting = actor.playersSeated().map((s) => s.userId);
    const outsider = USERS.find((u) => !sitting.includes(u));
    const viewers: (string | null)[] = [null, ...sitting, ...(outsider ? [outsider] : [])];
    for (const viewer of viewers) {
      const v: TableView = viewer === null ? spectator : actor.viewFor(viewer);
      const mine = v.seats.find((s) => s.playerId === viewer);
      if (viewer === null || !mine) {
        if (v.legal) report('privacy.legalForOutsider', `viewer ${viewer}`);
        if (v.showdownChoice) report('privacy.choiceForOutsider', `viewer ${viewer}`);
        if (v.myBest) report('privacy.bestForOutsider', `viewer ${viewer}`);
        if (v.seats.some((s) => s.playerId !== viewer && s.cards && betting)) report('privacy.cardsDuringBetting', `outsider ${viewer} sees cards while seat ${v.actingSeat} is to act`);
      }
      if (v.legal && mine && v.actingSeat !== mine.seat) report('view.legalNotOnTurn', `viewer ${viewer} seat ${mine.seat}, acting ${v.actingSeat}`);
      for (const s of v.seats) {
        if (s.playerId === viewer) continue;
        // while somebody can still act, nobody sees anybody else's cards, and no extra cards or chances are shown
        if (betting && s.cards) report('privacy.cardsDuringBetting', `viewer ${viewer} sees seat ${s.seat} while seat ${v.actingSeat} is to act (street ${v.street})`);
        // after the hand: cards of a player who neither had to show them nor showed them by choice stay hidden
        if (done?.record && s.cards) {
          const p = done.record.players.find((x) => x.userId === s.playerId);
          if (p && !p.revealed && !done.shown.has(s.playerId)) report('privacy.muckedCardsVisible', `viewer ${viewer} sees mucked cards of ${s.playerId} (hand ${v.handId})`);
        }
      }
      if (betting && v.rabbit) report('privacy.rabbitDuringBetting', `viewer ${viewer}`);
      if (betting && v.odds) report('privacy.oddsDuringBetting', `viewer ${viewer}`);
      // --- the offered actions make sense
      if (v.legal && mine) {
        const l = v.legal;
        if (l.callAmount < 0 || l.callAmount > mine.stack) report('legal.callAmount', `call ${l.callAmount}, stack ${mine.stack}`);
        if (l.canCheck && l.callAmount > 0) report('legal.checkWithCall', `call ${l.callAmount}`);
        if ((l.canBet || l.canRaise) && l.minRaiseTo > l.maxRaiseTo) report('legal.minOverMax', `min ${l.minRaiseTo} max ${l.maxRaiseTo}`);
        if ((l.canBet || l.canRaise) && l.maxRaiseTo > mine.stack + mine.bet) report('legal.maxOverStack', `max ${l.maxRaiseTo}, stack ${mine.stack} bet ${mine.bet}`);
        if (l.canBet && l.canRaise) report('legal.betAndRaise', 'both offered');
        if (!l.canCheck && l.callAmount === 0 && !l.canFold) report('legal.nothingToDo', JSON.stringify(l));
      }
    }
  };
  return { onEvent, check };
}

/**
 * One simulated session. Returns what broke (an empty list = everything held). `steps` is the number of rounds of the
 * loop; every round one random player does something, everybody on turn acts and the clock moves.
 */
export function deepRun(seed: number, over: Over = {}, steps = 1200, trace?: (step: number, e: TableEvent) => void): Finding[] {
  const findings: Finding[] = [];
  let step = 0;
  const report = (rule: string, detail: string) => {
    // one finding per rule is enough to see the problem; the rest of the same run would only repeat it
    if (!findings.some((f) => f.rule === rule)) findings.push({ seed, step, rule, detail });
  };
  const rnd = seededRandom(seed);
  const clock = new FakeClock();
  const ledger = new Ledger();
  const cash = new CashService(ledger);
  const values: Record<string, unknown> = { ...resolveSettings(reg, [{ scope: 'global', values: { ...TIMING, ...over } }]).values };
  const settings = values as SettingValues;
  const num = (k: string) => Number(settings[k]);
  const rate = num('cash.chipsPerCurrencyUnit') || 1;
  for (const u of USERS) cash.mint(u, 1_000_000, `mint-${u}`);

  // the table is created below; the watcher reaches it through this holder
  const held: { actor: TableActor | null } = { actor: null };
  const watch = watchTable(() => held.actor!, clock, report, () => num('table.seats'), (e) => trace?.(step, e), () => !!settings['table.bbAnte'] || !!settings['special.bombPot']);
  // between "the hand is completely over" and the next deal nothing of a hand is in flight
  let betweenHands = true;
  const onEvent = (e: TableEvent) => {
    if (e.type === 'handStart') betweenHands = false;
    else if (e.type === 'handFinished') betweenHands = true;
    watch.onEvent(e);
  };
  // the last state the table saved: what a restart at this very moment would bring back
  let saved: { seats: { userId: string; chips: number; pendingChips: number }[] } | null = null;
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: seededRandom(seed + 1), onEvent, persist: (snap) => (saved = JSON.parse(JSON.stringify(snap))) });
  held.actor = actor;
  const seatCount = () => num('table.seats');
  const bbChips = () => num('table.bigBlind');
  const seatedOf = (u: string) => actor.playersSeated().find((s) => s.userId === u);

  const checkStep = () => {
    // --- chips: nothing is created or lost
    const ids = [accounts.mint(), accounts.house(), accounts.fund('jackpot'), ...USERS.map(accounts.wallet), accounts.table('t')];
    if (!ledger.totalIsZero(ids)) report('ledger.notZero', 'the accounts do not add up to zero');
    if (actor.currentPhase() !== 'stopped' && ledger.balance(accounts.table('t')) !== actor.totalChips()) report('chips.tableMismatch', `ledger ${ledger.balance(accounts.table('t'))} table ${actor.totalChips()}`);
    for (const u of USERS) if (ledger.balance(accounts.wallet(u)) < 0) report('wallet.negative', u);
    if (actor.hasError()) report('actor.error', String(actor.hasError()));
    // --- a restart right now: the saved state holds exactly the chips the ledger says are at the table, and between
    // hands it gives every player what they have (a finished hand is not taken back, nor are its side effects kept alone)
    if (saved && actor.currentPhase() !== 'stopped') {
      const snap = saved as { seats: { userId: string; chips: number; pendingChips: number }[] };
      const total = snap.seats.reduce((n, e) => n + e.chips + e.pendingChips, 0);
      if (total !== ledger.balance(accounts.table('t'))) report('restore.totalMismatch', `saved ${total}, ledger ${ledger.balance(accounts.table('t'))}, phase ${actor.currentPhase()}`);
      // (while the result of a hand is still being shown the hand counts as in progress: it would return whole)
      if (betweenHands && !actor.handInProgress()) {
        for (const e of snap.seats) {
          const live = actor.chipsOf(e.userId);
          if (live !== null && live !== e.chips + e.pendingChips) report('restore.playerMismatch', `${e.userId}: saved ${e.chips}+${e.pendingChips}, has ${live}, phase ${actor.currentPhase()}`);
        }
      }
    }

    watch.check();
  };

  /** Between hands the owner changes a setting that may change between hands. */
  const BETWEEN_HANDS: [string, readonly (number | boolean | string)[]][] = [
    ['special.runItTwice', [true, false]],
    ['special.runItTimes', [2, 3]],
    ['special.rabbitHunt', [true, false]],
    ['special.muckAllowed', [true, false]],
    ['special.showCards', [true, false]],
    ['special.showCardsFolded', [true, false]],
    ['special.sevenTwoBonus', [true, false]],
    ['special.bombPot', [true, false]],
    ['special.bombPotEveryHands', [1, 2, 5]],
    ['table.bbAnte', [true, false]],
    ['table.ante', [0, 1]],
    ['table.straddleEnabled', [true, false]],
    ['table.straddleMandatory', [true, false]],
    ['table.deadButton', [true, false]],
    ['rake.enabled', [true, false]],
    ['rake.percent', [1, 5, 10]],
    ['odds.enabled', [true, false]],
  ];

  for (step = 0; step < steps; step++) {
    const user = pick(rnd, USERS);
    const seated = seatedOf(user);
    const r = rnd();
    const attempt = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        if (!(e instanceof GameError)) report('throw', `${(e as Error).message}\n${(e as Error).stack?.split('\n').slice(1, 4).join('\n')}`);
      }
    };
    if (!seated && r < 0.5) {
      const free = [...Array(seatCount()).keys()].filter((n) => !actor.playersSeated().some((s) => s.seat === n));
      if (free.length) {
        const minCur = Math.ceil((num('cash.minBuyInBb') * bbChips()) / rate);
        const maxCur = Math.max(minCur, Math.floor((num('cash.maxBuyInBb') * bbChips()) / rate));
        attempt(() => actor.join(user, user, pick(rnd, free), minCur + Math.floor(rnd() * (maxCur - minCur + 1))));
      }
    } else if (seated) {
      if (r < 0.04) attempt(() => actor.leave(user));
      else if (r < 0.07) attempt(() => actor.sitOut(user));
      else if (r < 0.12) attempt(() => actor.sitIn(user));
      else if (r < 0.16) attempt(() => actor.topUp(user, Math.max(1, Math.ceil((bbChips() * (1 + Math.floor(rnd() * 20))) / rate))));
      else if (r < 0.19) attempt(() => actor.setConnected(user, rnd() < 0.5));
      else if (r < 0.24) attempt(() => actor.setStraddle(user, rnd() < 0.7));
      else if (r < 0.27) attempt(() => actor.callClock(user));
      // acting out of turn, or with the id of another hand, must be refused and change nothing
      else if (r < 0.3) attempt(() => actor.act(user, pick(rnd, [{ type: 'fold' }, { type: 'check' }, { type: 'call' }, { type: 'allIn' }] as const), rnd() < 0.5 ? 'wrong-hand' : undefined));
    }
    // a setting changes between hands
    const phase = actor.currentPhase();
    if ((phase === 'pause' || phase === 'idle') && rnd() < 0.03) {
      const [key, options] = pick(rnd, BETWEEN_HANDS);
      const before = values[key];
      values[key] = pick(rnd, options);
      if (validateValues(reg, Object.fromEntries(Object.entries(values).filter(([k]) => reg.get(k))) as Over).length > 0) values[key] = before;
    }
    // everybody on turn plays
    const v = actor.viewFor(null);
    if (phase === 'hand' && v.actingSeat !== null) {
      const p = v.seats.find((s) => s.seat === v.actingSeat);
      if (!p) report('view.actingSeatEmpty', `seat ${v.actingSeat}`);
      else {
        const legal = actor.viewFor(p.playerId).legal;
        if (!legal) report('view.noLegalForActing', `seat ${p.seat} ${p.playerId} status ${p.status}`);
        else if (rnd() < 0.8) attempt(() => actor.act(p.playerId, randomLegalAction(legal, rnd), rnd() < 0.5 ? (v.handId ?? undefined) : undefined));
      }
    }
    // votes, showing or mucking at showdown, showing by choice, rabbit hunt
    if (v.vote?.status === 'open') for (const voter of v.vote.voters) if (rnd() < 0.5) attempt(() => actor.voteRunIt(voter.userId, rnd() < 0.7));
    for (const s of actor.playersSeated()) {
      if (actor.viewFor(s.userId).showdownChoice && rnd() < 0.6) attempt(() => actor.showdownChoice(s.userId, rnd() < 0.5 ? 'show' : 'muck'));
    }
    if ((phase === 'pause' || phase === 'runout') && rnd() < 0.35) {
      const who = pick(rnd, USERS);
      attempt(() => actor.showCards(who, pick(rnd, ['both', 0, 1] as const)));
      attempt(() => actor.rabbitHunt(who));
    }
    clock.advance(Math.floor(rnd() * 2000));
    checkStep();
  }
  return findings;
}
