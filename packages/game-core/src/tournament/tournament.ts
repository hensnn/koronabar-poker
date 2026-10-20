import { randomInt } from 'node:crypto';
import { LedgerError, type TournamentMoney } from '@kb/ledger';
import type { SettingValues } from '@kb/shared';
import type { Clock } from '../clock.js';
import { Voting, VoteError, type VoteState, type VoteView } from '../voting.js';
import type { TableEvent } from '../table-actor.js';
import { dealAmounts, DealError, type DealMethod, computePayouts, distribute, generateStructure, mysteryValues, parseLadder, parseStructure, percentsFor, pickEliminators, PayoutError, StructureError, type ContestedPlayer, type Level, type PayoutPreset, type RemainderRule } from '@kb/shared';

export type TournamentErrorCode =
  | 'INVALID'
  | 'STATE'
  | 'ALREADY_REGISTERED'
  | 'NOT_REGISTERED'
  | 'FULL'
  | 'REGISTRATION_CLOSED'
  | 'NOT_ENOUGH_PLAYERS'
  | 'REBUY_NOT_ALLOWED'
  | 'ADDON_NOT_ALLOWED'
  | 'REENTRY_NOT_ALLOWED'
  | 'INSUFFICIENT_FUNDS'
  | 'BAD_STRUCTURE'
  | 'BAD_PAYOUT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'LIMIT_EXCEEDED'
  | 'DEAL_DISABLED'
  | 'DEAL_PLAYERS'
  | 'DEAL_WINDOWS_OPEN'
  | 'DEAL_ACTIVE'
  | 'DEAL_COOLDOWN'
  | 'DEAL_DONE'
  | 'DEAL_INVALID'
  | 'NOT_VOTER'
  | 'NO_VOTE';

export class TournamentError extends Error {
  constructor(
    public readonly code: TournamentErrorCode,
    public readonly context?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export type TournamentStatus = 'registering' | 'running' | 'finished' | 'cancelled';
export type PlayerStatus = 'registered' | 'playing' | 'deciding' | 'out';

export interface PlayerRecord {
  userId: string;
  name: string;
  status: PlayerStatus;
  /** Počet vstupů (1 + re-entry). */
  entries: number;
  rebuys: number;
  addon: boolean;
  /** Konec času na rozhodnutí o rebuy (ms hodin), když je status „deciding“. */
  decideUntil: number | null;
  /** Zbývající čas na rozhodnutí, když je odpočet zastavený pauzou nebo přestávkou. */
  decideLeftMs?: number;
  /** Odpočet stojí, protože je hráč odpojený (volba správce); pokračuje po jeho připojení. */
  decideOffline?: boolean;
  /** Hlava: bounty, kterou získá ten, kdo hráče vyřadí (fixní a progresivní bounty). */
  head?: number;
  /** Kolik bounty hráč celkem získal. */
  bountyEarned?: number;
  /** Získaná bounty, která se vyplatí až na konci (režim „na konci“). */
  bountyUnpaid?: number;
  /** Místo u stolu (pro živou hru, kde seznam míst neuchovává stůl). */
  seat?: number;
  /** Stůl hráče (u turnaje na více stolech). */
  tableId?: string;
  /** Kdo hráče naposledy vyřadil z handy (pro rating a XP); nezávisí na bounty. */
  lastKillers?: { userId: string; weight: number; equity?: number | null }[];
}

export interface Payment {
  userId: string;
  kind: 'turnaj_buyin' | 'turnaj_rebuy' | 'turnaj_addon';
  /** Částka vstupu (bez poplatku). Z ní šel `house` domu a `fund` do fondu, zbytek do prize poolu. */
  cost: number;
  fee: number;
  house?: number;
  fund?: number;
  fundId?: string;
  /** Část vstupu, která šla do bounty. */
  bounty?: number;
  key: string;
  refunded?: boolean;
}

export interface TournamentState {
  status: TournamentStatus;
  paused: boolean;
  onBreak: boolean;
  levelIndex: number;
  levels: Level[] | null;
  handsInLevel: number;
  /** Zbývající čas levelu (kind „level“) nebo přestávky (kind „break“); u levelů po handách jen přestávka. */
  clock: { kind: 'level' | 'break' | null; remainingMs: number };
  players: PlayerRecord[];
  /** Vyřazení v pořadí, v jakém vypadávali (poslední je nejlépe umístěný z vyřazených). */
  eliminations: string[];
  payments: Payment[];
  startedAt: number | null;
  finishedAt: number | null;
  results: { userId: string; name: string; place: number; payout: number; bounty?: number }[] | null;
  /** Uzavřená dohoda (deal): částky pro zbývající hráče a část ponechaná na hru. */
  deal?: { method: DealMethod; amounts: Record<string, number>; keep: number; participants: string[]; at: number };
  /** Hlasování (dohoda…) včetně uzavřených; ukládá se kvůli obnově po restartu. */
  votes?: VoteState[];
  /** Kdy byla naposledy zamítnuta dohoda (pauza mezi návrhy). */
  lastDealRejectedAt?: number;
  /** Mystery bounty: hodnoty, které ještě nebyly vylosovány (součet = zůstatek bounty bez hlav). */
  bag?: number[];
  /** Počítadlo vyřazení s bounty (klíče pro účetní knihu). */
  knockouts?: number;
  /** Stoly turnaje (u turnaje na více stolech; chybí = jeden stůl s id turnaje). */
  tableIds?: string[];
  /** Kolik doplnila garance (rozdíl mezi garancí a vybraným prize poolem). */
  overlay?: number;
  /** Jednorázová nabídka add-onu po skončení posledního levelu s add-onem: do kdy platí a kdo ji odmítl. */
  addonOffer?: { until: number; declined: string[] };
}

export type TournamentEvent =
  | { type: 'started' }
  | { type: 'level'; level: number; smallBlind: number; bigBlind: number; ante: number }
  | { type: 'break'; minutes: number }
  | { type: 'breakEnd' }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'knockout'; victim: string; victimId: string; by: string[]; byIds: string[]; amount: number; secret: boolean }
  /** Rebuy, add-on a nový vstup: `chips` a `cost` jsou hodnoty z nastavení této hry (pro animaci u stolu). */
  | { type: 'rebuy'; userId: string; name: string; chips: number; cost: number }
  | { type: 'addon'; userId: string; name: string; chips: number; cost: number }
  | { type: 'reentry'; userId: string; name: string; chips: number; cost: number }
  | { type: 'eliminated'; userId: string; name: string; remaining: number; by: { userId: string; weight: number; equity?: number | null }[] }
  | { type: 'bubble' }
  | { type: 'dealProposed'; method: DealMethod }
  | { type: 'dealAccepted'; method: DealMethod; keep: number }
  | { type: 'dealRejected' }
  | { type: 'finished'; results: NonNullable<TournamentState['results']> }
  | { type: 'cancelled' };

/** Co turnaj potřebuje od svého stolu (implementuje ho `TableActor` v turnajovém režimu). */
export interface TournamentTable {
  seatTournamentPlayer(userId: string, name: string, seat: number, chips: number): void;
  addTournamentChips(userId: string, chips: number): void;
  removeTournamentPlayer(userId: string): void;
  chipsOf(userId: string): number | null;
  /** Je hráč připojený? (null = neznámo) */
  isConnected?(userId: string): boolean | null;
  hold(): void;
  release(): void;
  playersSeated(): { userId: string; seat: number }[];
  close(): void;
  /** Turnaj na více stolech: před startem připraví potřebný počet stolů pro daný počet hráčů. */
  prepareStart?(players: number): void;
  /** Počet stolů turnaje (výchozí 1). */
  tableCount?(): number;
  /** Stůl, u kterého hráč sedí. */
  tableOf?(userId: string): string | null;
  /** Skutečné místo hráče u jeho stolu. */
  seatOf?(userId: string): number | null;
}

export interface DealPayload {
  method: DealMethod;
  amounts: Record<string, number>;
  keep: number;
  total: number;
  chips: Record<string, number>;
}

export interface DealOptions {
  /** Důvod, proč teď dohodu navrhnout nejde (null = lze). */
  blocked: TournamentErrorCode | null;
  enabled: boolean;
  maxPlayers: number;
  allowed: DealMethod[];
  participants: { userId: string; name: string; chips: number }[];
  /** Dělená částka (součet výplat za první k míst). */
  total: number;
  keepMax: number;
  /** Výsledek každé povolené metody (kromě vlastních částek) pro srovnání vedle sebe. */
  methods: Partial<Record<DealMethod, Record<string, number>>>;
  vote: VoteView | null;
  deal: TournamentState['deal'] | null;
}

export interface TournamentDeps {
  id: string;
  settings: () => SettingValues;
  clock: Clock;
  money: TournamentMoney;
  onChange?: () => void;
  onEvent?: (e: TournamentEvent) => void;
  persist?: (s: TournamentState) => void;
  restore?: TournamentState;
}

const num = (s: SettingValues, k: string): number => Number(s[k]);

/** Část platby, která skončila v prize poolu. */
export const poolPart = (p: Pick<Payment, 'cost' | 'house' | 'fund' | 'bounty'>): number => p.cost - (p.house ?? 0) - (p.fund ?? 0) - (p.bounty ?? 0);

const emptyState = (): TournamentState => ({
  status: 'registering',
  paused: false,
  onBreak: false,
  levelIndex: 0,
  levels: null,
  handsInLevel: 0,
  clock: { kind: null, remainingMs: 0 },
  players: [],
  eliminations: [],
  payments: [],
  startedAt: null,
  finishedAt: null,
  results: null,
});

/**
 * Jednostolový turnaj: registrace, hodiny levelů, přestávky, rebuy/add-on/re-entry, pozdní registrace,
 * vyřazování a výplaty z prize poolu. Peníze jdou jen přes účetní knihu, žetony turnaje existují jen tady a u stolu.
 */
export class Tournament {
  private st: TournamentState;
  private table: TournamentTable | null = null;
  private clockTimer: (() => void) | null = null;
  private clockStartedAt = 0;
  private decideTimers = new Map<string, () => void>();
  private previewCache: { key: string; levels: Level[] } | null = null;
  private voting: Voting;

  constructor(private deps: TournamentDeps) {
    this.st = deps.restore ? structuredClone(deps.restore) : emptyState();
    this.voting = new Voting({
      clock: deps.clock,
      idPrefix: 'deal',
      handlers: { deal: (s) => this.onDealResolved(s) },
      onChange: () => this.save(),
    });
  }

  // ---------- napojení ----------

  /** Připojí stůl; po obnově ze snapshotu znovu rozběhne hodiny a časovače rozhodnutí. */
  attachTable(table: TournamentTable): void {
    this.table = table;
    this.voting.restore(this.st.votes ?? []);
    if (this.st.status === 'running') {
      if (this.st.paused || this.st.onBreak) table.hold();
      else table.release();
      if (!this.st.paused) this.resumeClock();
      for (const p of this.st.players) if (p.status === 'deciding') this.armDecision(p);
    } else if (this.st.status === 'registering') table.hold();
  }

  state(): Readonly<TournamentState> {
    return this.st;
  }

  /** Údaje pro herní rating: zda je turnaj hodnocený a jak dlouhý má být. */
  ratingInfo(): { rated: boolean; targetMinutes: number } {
    const s = this.deps.settings();
    return { rated: s['tournament.rated'] !== false, targetMinutes: Number(s['tournament.targetMinutes'] ?? 0) };
  }

  /** Nastavení stolu s aktuálním levelem (čte ho stůl před každou handou). */
  tableSettings(): SettingValues {
    const s = this.deps.settings();
    const level = this.currentLevel();
    if (!level) return s;
    return { ...s, 'table.smallBlind': level.smallBlind, 'table.bigBlind': level.bigBlind, 'table.ante': level.ante, 'table.bbAnte': false, 'table.straddleEnabled': false };
  }

  // ---------- struktura ----------

  /** Levely: po startu pevné, před startem odhad podle počtu přihlášených. */
  levels(): Level[] {
    if (this.st.levels) return this.st.levels;
    return this.computeLevels(Math.max(num(this.deps.settings(), 'tournament.minPlayers'), this.registeredCount()));
  }

  private computeLevels(players: number): Level[] {
    const s = this.deps.settings();
    const custom = String(s['tournament.structure'] ?? '').trim();
    const key = `${custom}|${players}|${num(s, 'tournament.startingStack')}|${num(s, 'tournament.targetMinutes')}|${num(s, 'tournament.levelMinutes')}|${s['tournament.levelMode']}|${num(s, 'tournament.levelHands')}`;
    if (this.previewCache?.key === key) return this.previewCache.levels;
    let levels: Level[];
    if (custom) {
      try {
        levels = parseStructure(custom);
      } catch (e) {
        if (e instanceof StructureError) throw new TournamentError('BAD_STRUCTURE', { code: e.code, line: e.line });
        throw e;
      }
    } else {
      // U levelů po handách se délka levelu odhadne (jedna handa ≈ 1 minuta).
      const minutes = s['tournament.levelMode'] === 'hands' ? Math.max(1, num(s, 'tournament.levelHands')) : num(s, 'tournament.levelMinutes');
      levels = generateStructure({ startingStack: num(s, 'tournament.startingStack'), targetMinutes: num(s, 'tournament.targetMinutes'), levelMinutes: minutes, players });
    }
    this.previewCache = { key, levels };
    return levels;
  }

  /** Kontrola nastavení při zakládání turnaje (struktura i výplatní procenta musí jít rozebrat). */
  validate(): void {
    this.computeLevels(num(this.deps.settings(), 'tournament.minPlayers'));
    const s = this.deps.settings();
    try {
      percentsFor(s['tournament.payoutPreset'] as PayoutPreset, String(s['tournament.payoutCustom']), 10);
    } catch (e) {
      if (e instanceof PayoutError) throw new TournamentError('BAD_PAYOUT', { code: e.code });
      throw e;
    }
  }

  /** Aktuální level; za posledním zadaným levelem se blindy i ante dál zdvojnásobují (turnaj se vždy dohraje). */
  currentLevel(): Level | null {
    const lv = this.st.levels;
    if (!lv || lv.length === 0) return null;
    const last = lv[lv.length - 1]!;
    const beyond = this.st.levelIndex - (lv.length - 1);
    if (beyond <= 0) return lv[this.st.levelIndex] ?? null;
    const k = 2 ** beyond;
    return { smallBlind: last.smallBlind * k, bigBlind: last.bigBlind * k, ante: last.ante * k };
  }

  /** Číslo levelu od 1. */
  levelNumber(): number {
    return this.st.levelIndex + 1;
  }

  // ---------- přehled ----------

  registeredCount(): number {
    return this.st.players.length;
  }

  private alive(): PlayerRecord[] {
    return this.st.players.filter((p) => p.status === 'playing' || p.status === 'deciding');
  }

  private rec(userId: string): PlayerRecord | undefined {
    return this.st.players.find((p) => p.userId === userId);
  }

  lateRegOpen(): boolean {
    const s = this.deps.settings();
    return this.st.status === 'running' && num(s, 'tournament.lateRegLevels') >= this.levelNumber();
  }

  private maxPlayers(): number {
    const s = this.deps.settings();
    return num(s, 'table.seats') * Math.max(1, num(s, 'tournament.maxTables') || 1);
  }

  /** Zapíše hráči stůl a místo (po přesazení), ať přežije restart. */
  noteSeat(userId: string, tableId: string, seat: number): void {
    const p = this.rec(userId);
    if (!p) return;
    p.tableId = tableId;
    p.seat = seat;
    if (this.table) this.save();
  }

  /** Uloží seznam stolů turnaje (u turnaje na více stolech) do stavu, ať přežije restart. */
  recordTables(ids: string[]): void {
    this.st.tableIds = ids.length === 1 && ids[0] === this.deps.id ? undefined : ids;
    // Před napojením stolů se nic neukládá (hlasování se obnovují až při napojení).
    if (this.table) this.save();
  }

  /**
   * Hand-for-hand: u turnaje na více stolech se na bublině čeká, až dohrají všechny stoly. Platí, dokud zbývá
   * o nejvýš tolik hráčů víc, než je placených míst, kolik je stolů.
   */
  handForHandActive(): boolean {
    if (this.st.status !== 'running') return false;
    const tables = this.table?.tableCount?.() ?? 1;
    if (tables < 2) return false;
    const paid = this.payoutPreview().filter((x) => x.amount > 0).length;
    const alive = this.alive().length;
    return paid > 0 && alive > paid && alive - paid <= tables;
  }

  prizePool(): number {
    return this.deps.money.pool(this.deps.id);
  }

  /** Pořadí od vítěze: po skončení konečné, za běhu odhad (podle žetonů a pořadí vypadnutí). */
  standings(): { userId: string; name: string; chips: number | null; place: number; status: PlayerStatus }[] {
    const alive = this.alive()
      .map((p) => ({ p, chips: this.table?.chipsOf(p.userId) ?? 0 }))
      .sort((a, b) => b.chips - a.chips);
    const out: { userId: string; name: string; chips: number | null; place: number; status: PlayerStatus }[] = alive.map((a, i) => ({ userId: a.p.userId, name: a.p.name, chips: a.chips, place: i + 1, status: a.p.status }));
    const gone = [...this.st.eliminations].reverse();
    gone.forEach((id, i) => {
      const p = this.rec(id);
      if (p && p.status === 'out') out.push({ userId: id, name: p.name, chips: null, place: alive.length + i + 1, status: 'out' });
    });
    if (this.st.status === 'registering') {
      return this.st.players.map((p, i) => ({ userId: p.userId, name: p.name, chips: null, place: i + 1, status: p.status }));
    }
    return out;
  }

  /** Náhled výplat pro aktuální počet hráčů. */
  payoutPreview(): { place: number; amount: number }[] {
    const s = this.deps.settings();
    const players = Math.max(1, this.st.players.length);
    const pool = this.expectedPool();
    try {
      const pct = percentsFor(s['tournament.payoutPreset'] as PayoutPreset, String(s['tournament.payoutCustom']), players);
      const r = computePayouts(pool, pct, { roundTo: num(s, 'tournament.payoutRoundTo'), remainder: s['tournament.payoutRemainder'] as RemainderRule });
      return r.amounts.map((amount, i) => ({ place: i + 1, amount }));
    } catch {
      return [];
    }
  }

  /** Bublina: zbývá o jednoho hráče víc, než je placených míst (příští vyřazený odchází bez výhry). */
  isBubble(): boolean {
    if (this.st.status !== 'running') return false;
    const paid = this.payoutPreview().filter((x) => x.amount > 0).length;
    return paid > 0 && this.alive().length === paid + 1;
  }

  /** Prize pool podle přihlášených (před startem ještě nemusí být v knize vše). */
  private expectedPool(): number {
    return this.st.payments.filter((p) => !p.refunded).reduce((a, p) => a + poolPart(p), 0);
  }

  // ---------- registrace ----------

  register(userId: string, name: string): void {
    const s = this.deps.settings();
    if (this.st.status !== 'registering' && !(this.st.status === 'running' && this.lateRegOpen())) throw new TournamentError(this.st.status === 'running' ? 'REGISTRATION_CLOSED' : 'STATE');
    if (this.rec(userId)) throw new TournamentError('ALREADY_REGISTERED');
    const seatedOrRegistered = this.st.players.filter((p) => p.status !== 'out').length;
    if (seatedOrRegistered >= this.maxPlayers()) throw new TournamentError('FULL');
    const cost = num(s, 'tournament.buyIn');
    const fee = num(s, 'tournament.fee');
    const key = `trn:${this.deps.id}:reg:${userId}:${this.entryNo(userId)}`;
    const part = cost + fee > 0 ? this.pay(userId, 'turnaj_buyin', cost, fee, key) : 0;
    const rec: PlayerRecord = { userId, name, status: 'registered', entries: 1, rebuys: 0, addon: false, decideUntil: null, head: 0, bountyEarned: 0, bountyUnpaid: 0 };
    this.st.players.push(rec);
    // Při pozdní registraci už běží turnaj, hlava se přičte hned; před startem se u mystery sestaví pytlík až při startu.
    if (this.st.status === 'running' || this.bountyType() !== 'mystery') this.addBounty(rec, part);
    if (this.st.status === 'running') this.seat(rec, num(s, 'tournament.startingStack'));
    this.save();
    if (this.st.status === 'registering' && s['tournament.autoStartWhenFull'] && this.st.players.length >= this.maxPlayers()) this.start();
  }

  /** Odhlášení před startem: vrací buy-in i poplatek. */
  unregister(userId: string): void {
    if (this.st.status !== 'registering') throw new TournamentError('STATE');
    const rec = this.rec(userId);
    if (!rec) throw new TournamentError('NOT_REGISTERED');
    for (const p of this.st.payments) if (p.userId === userId && !p.refunded) this.refund(p);
    this.st.players = this.st.players.filter((p) => p !== rec);
    this.save();
  }

  private pay(userId: string, kind: Payment['kind'], cost: number, fee: number, key: string): number {
    const s = this.deps.settings();
    const house = Math.floor((cost * num(s, 'tournament.houseCutPercent')) / 100);
    const fund = Math.floor((cost * num(s, 'tournament.fundPercent')) / 100);
    const fundId = String(s['tournament.fundId'] || 'sezona');
    // Bounty nesou vstup a rebuy (ne add-on).
    const bounty = kind !== 'turnaj_addon' && this.bountyType() !== 'none' ? Math.floor((cost * num(s, 'tournament.bountyPercent')) / 100) : 0;
    try {
      this.deps.money.pay(this.deps.id, userId, kind, { cost, fee, house, fund, fundId, bounty }, key, userId);
    } catch (e) {
      if (e instanceof LedgerError && e.code === 'INSUFFICIENT_FUNDS') throw new TournamentError('INSUFFICIENT_FUNDS');
      throw e;
    }
    this.st.payments.push({ userId, kind, cost, fee, house, fund, fundId, bounty, key });
    return bounty;
  }

  /** Pořadové číslo další platby vstupu hráče (i odhlášené se počítají, aby se klíč v knize nikdy neopakoval). */
  private entryNo(userId: string): number {
    return this.st.payments.filter((x) => x.userId === userId && x.kind === 'turnaj_buyin').length + 1;
  }

  private refund(p: Payment, bountyRefund?: number): void {
    this.deps.money.refund(this.deps.id, p.userId, { ...p, bountyRefund }, `refund:${p.key}`);
    p.refunded = true;
  }

  // ---------- bounty ----------

  private bountyType(): 'none' | 'fixed' | 'pko' | 'mystery' {
    return String(this.deps.settings()['tournament.bountyType'] ?? 'none') as 'none' | 'fixed' | 'pko' | 'mystery';
  }

  /** Hlava hráče pro zobrazení: u mystery bounty je tajná (null). */
  headOf(userId: string): number | null {
    const t = this.bountyType();
    if (t === 'none' || t === 'mystery') return null;
    const p = this.rec(userId);
    return p && p.status !== 'out' ? (p.head ?? 0) : null;
  }

  /** Hlava a bounty se po zaplacení vstupu nebo rebuy přičtou hráči (u mystery do společného pytlíku hodnot). */
  private addBounty(p: PlayerRecord, part: number): void {
    if (part <= 0) return;
    if (this.bountyType() === 'mystery') this.st.bag = [...(this.st.bag ?? []), part];
    else p.head = (p.head ?? 0) + part;
  }

  /** Mystery hodnoty se při startu přeškálují tak, aby jejich součet přesně odpovídal vybrané bounty. */
  private initMysteryBag(): void {
    if (this.bountyType() !== 'mystery') return;
    const live = this.st.payments.filter((p) => !p.refunded && (p.bounty ?? 0) > 0);
    const total = live.reduce((a, p) => a + (p.bounty ?? 0), 0);
    this.st.bag = mysteryValues(live.length, total, parseLadder(String(this.deps.settings()['tournament.mysteryLadder'])), (n) => randomInt(n));
  }

  /** Vyřazení hráče (bust): jeho hlava, nebo vylosovaná mystery hodnota, připadne tomu, kdo ho porazil. */
  private knockout(victimId: string, hand: ContestedPlayer[]): void {
    const type = this.bountyType();
    if (type === 'none') return;
    const s = this.deps.settings();
    const victim = this.rec(victimId);
    if (!victim) return;
    let value = 0;
    if (type === 'mystery') {
      const bag = this.st.bag ?? [];
      if (bag.length) value = bag.splice(randomInt(bag.length), 1)[0]!;
      this.st.bag = bag;
    } else {
      value = victim.head ?? 0;
      victim.head = 0;
    }
    if (value <= 0) return;
    const me = hand.find((h) => h.userId === victimId);
    const eliminators = me ? pickEliminators(me, hand, s['tournament.bountySplit'] === 'byWinnings' ? 'byWinnings' : 'equal').filter((x) => !!this.rec(x.userId)) : [];
    if (eliminators.length === 0) {
      // Nikdo ho prokazatelně nevyřadil: hodnota zůstává na účtu bounty a vyplatí se vítězi na konci.
      if (type === 'mystery') (this.st.bag ??= []).push(value);
      return;
    }
    const shares = distribute(value, eliminators.map((x) => x.weight));
    const names: string[] = [];
    const killerIds: string[] = [];
    eliminators.forEach((x, i) => {
      const amount = shares[i]!;
      const killer = this.rec(x.userId)!;
      names.push(killer.name);
      killerIds.push(killer.userId);
      if (amount <= 0) return;
      let cash = amount;
      if (type === 'pko') {
        cash = Math.floor((amount * num(s, 'tournament.pkoCashPercent')) / 100);
        killer.head = (killer.head ?? 0) + (amount - cash);
      }
      this.awardBounty(killer, cash);
    });
    this.deps.onEvent?.({ type: 'knockout', victim: victim.name, victimId, by: names, byIds: killerIds, amount: value, secret: type === 'mystery' });
  }

  private awardBounty(killer: PlayerRecord, cash: number): void {
    if (cash <= 0) return;
    killer.bountyEarned = (killer.bountyEarned ?? 0) + cash;
    if (this.deps.settings()['tournament.bountyPayout'] === 'end') {
      killer.bountyUnpaid = (killer.bountyUnpaid ?? 0) + cash;
      return;
    }
    this.st.knockouts = (this.st.knockouts ?? 0) + 1;
    this.deps.money.bountyPay(this.deps.id, killer.userId, cash, `trn:${this.deps.id}:bounty:${this.st.knockouts}`, 'bounty za vyřazení');
  }

  // ---------- start a hodiny ----------

  /** Start turnaje. `force`: začít i pod nastaveným minimem (aspoň 2 hráči), např. podle nastavení plánovaného turnaje. */
  start(opts: { force?: boolean } = {}): void {
    if (this.st.status !== 'registering') throw new TournamentError('STATE');
    const s = this.deps.settings();
    if (this.st.players.length < (opts.force ? 2 : num(s, 'tournament.minPlayers'))) throw new TournamentError('NOT_ENOUGH_PLAYERS', { min: num(s, 'tournament.minPlayers') });
    this.st.levels = this.computeLevels(this.st.players.length);
    this.table?.prepareStart?.(this.st.players.length);
    this.initMysteryBag();
    this.st.status = 'running';
    this.st.startedAt = this.deps.clock.now();
    this.st.levelIndex = 0;
    this.st.handsInLevel = 0;
    // Náhodné rozsazení kryptografickým generátorem.
    const free = Array.from({ length: this.maxPlayers() }, (_, i) => i);
    for (const p of this.st.players) {
      const seat = free.splice(randomInt(free.length), 1)[0]!;
      this.seat(p, num(s, 'tournament.startingStack'), seat);
    }
    this.deps.onEvent?.({ type: 'started' });
    this.emitLevel();
    this.beginLevelClock();
    this.table?.release();
    this.save();
  }

  private seat(p: PlayerRecord, chips: number, seat?: number): void {
    const taken = new Set(this.table?.playersSeated().map((x) => x.seat) ?? []);
    const free = Array.from({ length: this.maxPlayers() }, (_, i) => i).filter((i) => !taken.has(i));
    const target = seat ?? free[randomInt(free.length)];
    if (target === undefined) throw new TournamentError('FULL');
    this.table?.seatTournamentPlayer(p.userId, p.name, target, chips);
    p.seat = this.table?.seatOf?.(p.userId) ?? target;
    const tableId = this.table?.tableOf?.(p.userId);
    if (tableId) p.tableId = tableId;
    p.status = 'playing';
    p.decideUntil = null;
  }

  private emitLevel(): void {
    const l = this.currentLevel();
    if (l) this.deps.onEvent?.({ type: 'level', level: this.levelNumber(), smallBlind: l.smallBlind, bigBlind: l.bigBlind, ante: l.ante });
  }

  private levelMs(): number {
    return num(this.deps.settings(), 'tournament.levelMinutes') * 60_000;
  }

  private beginLevelClock(): void {
    this.cancelClock();
    const s = this.deps.settings();
    if (s['tournament.levelMode'] === 'hands') {
      this.st.clock = { kind: null, remainingMs: 0 };
      return;
    }
    this.st.clock = { kind: 'level', remainingMs: this.levelMs() };
    this.runClock();
  }

  private runClock(): void {
    this.cancelClock();
    if (!this.st.clock.kind || this.st.paused) return;
    this.clockStartedAt = this.deps.clock.now();
    this.clockTimer = this.deps.clock.setTimeout(() => {
      this.clockTimer = null;
      this.st.clock.remainingMs = 0;
      this.onClockEnd();
    }, Math.max(0, this.st.clock.remainingMs));
  }

  private resumeClock(): void {
    this.runClock();
  }

  private cancelClock(): void {
    this.clockTimer?.();
    this.clockTimer = null;
  }

  /** Zastaví hodiny a uloží zbývající čas. */
  private freezeClock(): void {
    if (this.clockTimer) {
      this.st.clock.remainingMs = Math.max(0, this.st.clock.remainingMs - (this.deps.clock.now() - this.clockStartedAt));
      this.cancelClock();
    }
  }

  /** Zbývající čas levelu/přestávky v ms (pro zobrazení). */
  clockRemainingMs(): number | null {
    if (!this.st.clock.kind) return null;
    if (this.clockTimer) return Math.max(0, this.st.clock.remainingMs - (this.deps.clock.now() - this.clockStartedAt));
    return this.st.clock.remainingMs;
  }

  private onClockEnd(): void {
    if (this.st.status !== 'running') return;
    if (this.st.clock.kind === 'break') {
      this.st.onBreak = false;
      this.deps.onEvent?.({ type: 'breakEnd' });
      this.advanceLevel();
      this.thawDecisions();
      if (!this.st.paused) this.releaseTable();
    } else {
      this.levelDone();
    }
    this.save();
    this.deps.onChange?.();
  }

  /** Level skončil: přestávka (pokud je na řadě), jinak další level od příští handy. */
  private levelDone(): void {
    const s = this.deps.settings();
    this.openAddonOffer();
    const every = num(s, 'tournament.breakEveryLevels');
    // Přestávka po každých N levelech, nebo jen jednou (po N-tém levelu), když je opakování vypnuté.
    const due = every > 0 && (s['tournament.breakRepeat'] === false ? this.levelNumber() === every : this.levelNumber() % every === 0);
    if (due) {
      this.st.onBreak = true;
      const minutes = num(s, 'tournament.breakMinutes');
      this.st.clock = { kind: 'break', remainingMs: minutes * 60_000 };
      this.table?.hold();
      this.freezeDecisions();
      this.deps.onEvent?.({ type: 'break', minutes });
      this.runClock();
      return;
    }
    this.advanceLevel();
  }

  private advanceLevel(): void {
    this.st.levelIndex++;
    this.st.handsInLevel = 0;
    this.emitLevel();
    this.beginLevelClock();
  }

  // ---------- události stolu ----------

  /** `lead`: událost z hlavního stolu; u turnaje na více stolech se level po handách počítá jen podle něj. */
  onTableEvent(e: TableEvent, opts: { lead?: boolean } = {}): void {
    if (this.st.status !== 'running') return;
    if (e.type === 'connection') {
      const p = this.rec(e.userId);
      if (p?.status === 'deciding' && this.deps.settings()['tournament.rebuyWaitsForOffline']) {
        if (!e.connected && p.decideLeftMs === undefined) this.freezeOffline(p);
        else if (e.connected) this.resumeOffline(p);
        this.save();
      }
      return;
    }
    if (e.type === 'handEnd') {
      const s = this.deps.settings();
      if (s['tournament.levelMode'] === 'hands' && !this.st.onBreak && opts.lead !== false) {
        this.st.handsInLevel++;
        if (this.st.handsInLevel >= num(s, 'tournament.levelHands')) this.levelDone();
      }
      this.save();
    } else if (e.type === 'bust') {
      // Souběžná vypadnutí: kdo měl na začátku handy méně žetonů, skončil hůř.
      const ordered = [...e.players].sort((a, b) => a.startStack - b.startStack);
      for (const b of ordered) {
        this.noteKillers(b.userId, e.hand ?? []);
        this.knockout(b.userId, e.hand ?? []);
        this.onBust(b.userId);
      }
      this.checkFinish();
      this.save();
    }
  }

  /** Zapamatuje, kdo vyřadil hráče v této handě (poměrně podle dělení potu). */
  /**
   * Živá hra: ředitel zapíše vyřazení hráče a kdo ho vyřadil (nepovinně, více hráčů dělí bounty rovným dílem).
   * Bez stolu, který by vyřazení poznal sám, je to jediná cesta, jak hráč vypadne.
   */
  eliminateManually(victimId: string, killerIds: string[] = []): void {
    if (this.st.status !== 'running') throw new TournamentError('STATE');
    const victim = this.rec(victimId);
    if (!victim || (victim.status !== 'playing' && victim.status !== 'deciding')) throw new TournamentError('NOT_REGISTERED');
    const killers = [...new Set(killerIds)].filter((id) => id !== victimId && this.rec(id)?.status === 'playing');
    if (killers.length !== new Set(killerIds).size) throw new TournamentError('INVALID');
    const hand: ContestedPlayer[] = [{ userId: victimId, invested: 1, won: 0 }, ...killers.map((userId) => ({ userId, invested: 1, won: 1 }))];
    this.noteKillers(victimId, hand);
    this.knockout(victimId, hand);
    this.eliminate(victim);
    this.checkFinish();
    this.save();
  }

  private noteKillers(victimId: string, hand: ContestedPlayer[]): void {
    const victim = this.rec(victimId);
    const me = hand.find((h) => h.userId === victimId);
    if (!victim) return;
    victim.lastKillers = me ? pickEliminators(me, hand, 'equal').filter((x) => !!this.rec(x.userId)) : [];
  }

  private onBust(userId: string): void {
    const p = this.rec(userId);
    if (!p || p.status !== 'playing') return;
    if (this.canRebuyNow(p, true) || this.canReenterNow(p, true)) {
      p.status = 'deciding';
      this.armDecision(p);
    } else {
      this.eliminate(p);
    }
  }

  /** Má hra u stolu čekat, než se hráči po vypadnutí vyjádří o rebuy (volba správce)? */
  private holdForDecision(): boolean {
    return !!this.deps.settings()['tournament.rebuyHoldsGame'] && this.st.players.some((p) => p.status === 'deciding');
  }

  /** Uvolní stůl, ale jen když nic jiného (pauza, přestávka, čekající rozhodnutí) hru stále drží. */
  private releaseTable(): void {
    if (this.st.paused || this.st.onBreak || this.holdForDecision()) return;
    this.table?.release();
  }

  /** Pauza nebo přestávka zastaví odpočet rozhodování (volba správce); zbývající čas se uloží. */
  private freezeDecisions(): void {
    if (!this.deps.settings()['tournament.rebuyTimerStops']) return;
    const now = this.deps.clock.now();
    for (const p of this.st.players) {
      if (p.status !== 'deciding' || p.decideUntil === null || p.decideLeftMs !== undefined) continue;
      p.decideLeftMs = Math.max(0, p.decideUntil - now);
      this.decideTimers.get(p.userId)?.();
      this.decideTimers.delete(p.userId);
    }
  }

  private thawDecisions(): void {
    if (this.st.paused || this.st.onBreak) return;
    const now = this.deps.clock.now();
    for (const p of this.st.players) {
      if (p.status !== 'deciding' || p.decideLeftMs === undefined || p.decideOffline) continue;
      p.decideUntil = now + p.decideLeftMs;
      delete p.decideLeftMs;
      delete p.decideOffline;
      this.armDecision(p);
    }
  }

  /** Hráč se vyjádřil nebo vypadl: když hru držela volba „čekat na rebuy“, stůl se uvolní. */
  private releaseAfterDecision(): void {
    if (this.deps.settings()['tournament.rebuyHoldsGame']) this.releaseTable();
  }

  /** Čas na rozhodnutí vypršel: hráč je vyřazen. */
  private expireDecision(p: PlayerRecord): void {
    this.decideTimers.delete(p.userId);
    if (p.status !== 'deciding') return;
    this.eliminate(p);
    this.checkFinish();
    this.save();
    this.deps.onChange?.();
  }

  /** Odpojenému hráči odpočet stojí (volba správce); po nastavené době se vzdá, aby turnaj nečekal donekonečna. */
  private freezeOffline(p: PlayerRecord): void {
    const s = this.deps.settings();
    const now = this.deps.clock.now();
    this.decideTimers.get(p.userId)?.();
    p.decideLeftMs = p.decideUntil === null ? num(s, 'tournament.rebuyDecisionSeconds') * 1000 : Math.max(0, p.decideUntil - now);
    p.decideOffline = true;
    this.decideTimers.set(p.userId, this.deps.clock.setTimeout(() => this.expireDecision(p), num(s, 'tournament.rebuyOfflineMaxSeconds') * 1000));
    this.deps.onChange?.();
  }

  /** Hráč se připojil: odpočet pokračuje od místa, kde stál. */
  private resumeOffline(p: PlayerRecord): void {
    if (!p.decideOffline || p.decideLeftMs === undefined) return;
    this.decideTimers.get(p.userId)?.();
    this.decideTimers.delete(p.userId);
    delete p.decideOffline;
    if (this.st.paused || this.st.onBreak) return; // dál ho drží pauza (volba zastavení odpočtu)
    p.decideUntil = this.deps.clock.now() + p.decideLeftMs;
    delete p.decideLeftMs;
    this.armDecision(p);
  }

  private armDecision(p: PlayerRecord): void {
    if (p.decideLeftMs !== undefined) return;
    if (this.holdForDecision()) this.table?.hold();
    if (this.deps.settings()['tournament.rebuyWaitsForOffline'] && this.table?.isConnected?.(p.userId) === false) {
      this.freezeOffline(p);
      return;
    }
    this.decideTimers.get(p.userId)?.();
    const s = this.deps.settings();
    const now = this.deps.clock.now();
    if (p.decideUntil === null) p.decideUntil = now + num(s, 'tournament.rebuyDecisionSeconds') * 1000;
    this.decideTimers.set(
      p.userId,
      this.deps.clock.setTimeout(() => this.expireDecision(p), Math.max(0, p.decideUntil - now)),
    );
    this.deps.onChange?.();
  }

  private eliminate(p: PlayerRecord): void {
    this.decideTimers.get(p.userId)?.();
    this.decideTimers.delete(p.userId);
    p.status = 'out';
    p.decideUntil = null;
    delete p.decideLeftMs;
    delete p.decideOffline;
    this.st.eliminations.push(p.userId);
    // Změnil se okruh hráčů: rozjednané hlasování o dohodě už neplatí.
    this.voting.cancelAll('deal');
    try {
      this.table?.removeTournamentPlayer(p.userId);
    } catch {
      // hráč už u stolu není
    }
    const remaining = this.alive().length;
    this.deps.onEvent?.({ type: 'eliminated', userId: p.userId, name: p.name, remaining, by: p.lastKillers ?? [] });
    if (this.isBubble()) this.deps.onEvent?.({ type: 'bubble' });
    this.releaseAfterDecision();
  }

  private checkFinish(): void {
    if (this.st.status !== 'running') return;
    const alive = this.alive();
    if (alive.length === 1 && alive[0]!.status === 'playing') this.finish();
  }

  // ---------- rebuy, add-on, re-entry ----------

  private canRebuyNow(p: PlayerRecord, busted: boolean): boolean {
    const s = this.deps.settings();
    if (this.st.status !== 'running' || !s['tournament.rebuyEnabled']) return false;
    if (this.levelNumber() > num(s, 'tournament.rebuyUntilLevel')) return false;
    if (p.rebuys >= num(s, 'tournament.rebuyMax')) return false;
    if (p.status !== 'playing' && p.status !== 'deciding') return false;
    if (busted || p.status === 'deciding') return true;
    if (s['tournament.rebuyWhen'] === 'busted') return false;
    const chips = this.table?.chipsOf(p.userId) ?? 0;
    return chips <= (num(s, 'tournament.rebuyBelowChips') || num(s, 'tournament.startingStack'));
  }

  canRebuy(userId: string): boolean {
    const p = this.rec(userId);
    return !!p && this.canRebuyNow(p, false);
  }

  /** Může se hráč právě teď přihlásit (před startem, nebo v pozdní registraci)? */
  canRegister(userId: string): boolean {
    if (this.rec(userId)) return false;
    if (this.st.status !== 'registering' && !(this.st.status === 'running' && this.lateRegOpen())) return false;
    return this.st.players.filter((p) => p.status !== 'out').length < this.maxPlayers();
  }

  /** `busted`: rebuy po vypadnutí (živá hra: ředitel zapisuje rebuy hráče, který právě přišel o žetony). */
  rebuy(userId: string, opts: { busted?: boolean } = {}): void {
    const p = this.rec(userId);
    if (!p) throw new TournamentError('NOT_REGISTERED');
    if (!this.canRebuyNow(p, !!opts.busted)) throw new TournamentError('REBUY_NOT_ALLOWED');
    const s = this.deps.settings();
    const part = this.pay(userId, 'turnaj_rebuy', num(s, 'tournament.rebuyCost'), 0, `trn:${this.deps.id}:rebuy:${userId}:${p.entries}:${p.rebuys + 1}`);
    this.addBounty(p, part);
    p.rebuys++;
    this.table?.addTournamentChips(userId, num(s, 'tournament.rebuyChips'));
    this.deps.onEvent?.({ type: 'rebuy', userId, name: p.name, chips: num(s, 'tournament.rebuyChips'), cost: num(s, 'tournament.rebuyCost') });
    if (p.status === 'deciding') {
      this.decideTimers.get(userId)?.();
      this.decideTimers.delete(userId);
      p.status = 'playing';
      p.decideUntil = null;
      delete p.decideLeftMs;
      delete p.decideOffline;
      this.releaseAfterDecision();
    }
    this.save();
  }

  /** Po skončení posledního levelu s add-onem se hráčům jednorázově nabídne (režim „nabídka“ nebo „obojí“). */
  private openAddonOffer(): void {
    const s = this.deps.settings();
    const mode = String(s['tournament.addonMode'] ?? 'both');
    if (!s['tournament.addonEnabled'] || mode === 'window' || this.levelNumber() !== num(s, 'tournament.addonUntilLevel')) return;
    this.st.addonOffer = { until: this.deps.clock.now() + num(s, 'tournament.addonOfferSeconds') * 1000, declined: [] };
  }

  /** Do kdy platí jednorázová nabídka add-onu (ms hodin), nebo null, když neběží. */
  addonOfferUntil(): number | null {
    const o = this.st.addonOffer;
    if (!o || this.st.status !== 'running' || this.deps.clock.now() >= o.until) return null;
    return o.until;
  }

  /** Hráči se právě nabízí add-on dialogem (nabídka běží, ještě ji neodmítl ani nekoupil). */
  addonOffered(userId: string): boolean {
    const p = this.rec(userId);
    return this.addonOfferUntil() !== null && !!p && p.status === 'playing' && !p.addon && !this.st.addonOffer!.declined.includes(userId);
  }

  /** Hráč jednorázovou nabídku odmítl. */
  declineAddon(userId: string): void {
    if (!this.addonOffered(userId)) throw new TournamentError('ADDON_NOT_ALLOWED');
    this.st.addonOffer!.declined.push(userId);
    this.save();
  }

  canAddon(userId: string): boolean {
    const p = this.rec(userId);
    const s = this.deps.settings();
    if (!p || this.st.status !== 'running' || !s['tournament.addonEnabled'] || p.addon || p.status !== 'playing') return false;
    if (this.addonOffered(userId)) return true;
    if (String(s['tournament.addonMode'] ?? 'both') === 'offer') return false;
    const lv = this.levelNumber();
    return lv >= num(s, 'tournament.addonFromLevel') && lv <= num(s, 'tournament.addonUntilLevel');
  }

  addon(userId: string): void {
    if (!this.canAddon(userId)) throw new TournamentError('ADDON_NOT_ALLOWED');
    const p = this.rec(userId)!;
    const s = this.deps.settings();
    this.pay(userId, 'turnaj_addon', num(s, 'tournament.addonCost'), 0, `trn:${this.deps.id}:addon:${userId}:${p.entries}`);
    p.addon = true;
    this.table?.addTournamentChips(userId, num(s, 'tournament.addonChips'));
    this.deps.onEvent?.({ type: 'addon', userId, name: p.name, chips: num(s, 'tournament.addonChips'), cost: num(s, 'tournament.addonCost') });
    this.save();
  }

  /** Hráč v čase rozhodování po vypadnutí smí místo rebuy vstoupit znovu. */
  canReenterNowPublic(userId: string): boolean {
    const p = this.rec(userId);
    return !!p && p.status === 'deciding' && this.canReenterNow(p, true);
  }

  private canReenterNow(p: PlayerRecord, busted: boolean): boolean {
    const s = this.deps.settings();
    if (!s['tournament.reentryEnabled'] || !this.lateRegOpen()) return false;
    if (p.entries - 1 >= num(s, 'tournament.reentryMax')) return false;
    if (!busted && p.status !== 'out') return false;
    return true;
  }

  canReenter(userId: string): boolean {
    const p = this.rec(userId);
    if (!p || p.status !== 'out' || !this.canReenterNow(p, false)) return false;
    return this.alive().length < this.maxPlayers();
  }

  /** Vyřazený hráč vstoupí znovu (nebo čekající hráč místo rebuy): platí buy-in i poplatek, dostane startovní stack. */
  reenter(userId: string): void {
    const p = this.rec(userId);
    if (!p) throw new TournamentError('NOT_REGISTERED');
    const s = this.deps.settings();
    const waiting = p.status === 'deciding';
    if (!waiting && !this.canReenter(userId)) throw new TournamentError('REENTRY_NOT_ALLOWED');
    if (waiting && !this.canReenterNow(p, true)) throw new TournamentError('REENTRY_NOT_ALLOWED');
    const part = this.pay(userId, 'turnaj_buyin', num(s, 'tournament.buyIn'), num(s, 'tournament.fee'), `trn:${this.deps.id}:reg:${userId}:${this.entryNo(userId)}`);
    this.addBounty(p, part);
    p.entries++;
    p.rebuys = 0;
    p.addon = false;
    this.st.eliminations = this.st.eliminations.filter((id) => id !== userId);
    if (waiting) {
      // Hráč s nulovým stackem u stolu ještě sedí: dostane nový startovní stack.
      this.decideTimers.get(userId)?.();
      this.decideTimers.delete(userId);
      this.table?.addTournamentChips(userId, num(s, 'tournament.startingStack'));
      p.status = 'playing';
      p.decideUntil = null;
      delete p.decideLeftMs;
      delete p.decideOffline;
      this.releaseAfterDecision();
    } else {
      this.seat(p, num(s, 'tournament.startingStack'));
    }
    this.deps.onEvent?.({ type: 'reentry', userId, name: p.name, chips: num(s, 'tournament.startingStack'), cost: num(s, 'tournament.buyIn') });
    this.save();
  }

  // ---------- řízení ----------

  pause(): void {
    if (this.st.status !== 'running' || this.st.paused) throw new TournamentError('STATE');
    this.freezeClock();
    this.st.paused = true;
    this.freezeDecisions();
    this.table?.hold();
    this.deps.onEvent?.({ type: 'paused' });
    this.save();
  }

  resume(): void {
    if (this.st.status !== 'running' || !this.st.paused) throw new TournamentError('STATE');
    this.st.paused = false;
    this.runClock();
    this.thawDecisions();
    if (!this.st.onBreak) this.releaseTable();
    this.deps.onEvent?.({ type: 'resumed' });
    this.save();
  }

  /** Zrušení: všechny platby (buy-in, rebuy, add-on, poplatky) se vrátí do peněženek. */
  cancel(): void {
    if (this.st.status === 'finished' || this.st.status === 'cancelled') throw new TournamentError('STATE');
    this.cancelClock();
    this.voting.cancelAll();
    for (const t of this.decideTimers.values()) t();
    this.decideTimers.clear();
    // Bounty, která už byla vyplacena za vyřazení, zůstává hráčům; co na účtu bounty zbylo, se vrátí poměrně podle vložených částí.
    const open = this.st.payments.filter((p) => !p.refunded);
    const bank = this.deps.money.bountyBank(this.deps.id);
    const paidIn = open.reduce((a, p) => a + (p.bounty ?? 0), 0);
    const back = paidIn > 0 ? distribute(bank, open.map((p) => p.bounty ?? 0)) : open.map(() => 0);
    open.forEach((p, i) => this.refund(p, back[i] ?? 0));
    this.st.status = 'cancelled';
    this.st.finishedAt = this.deps.clock.now();
    this.table?.close();
    this.deps.onEvent?.({ type: 'cancelled' });
    this.save();
  }

  /** Zastaví časovače při vypnutí serveru (stav zůstává uložený). */
  stop(): void {
    this.voting.stop();
    this.freezeClock();
    this.cancelClock();
    for (const t of this.decideTimers.values()) t();
    this.decideTimers.clear();
  }

  private finish(dealOrder?: string[]): void {
    const s = this.deps.settings();
    this.voting.cancelAll();
    this.cancelClock();
    for (const t of this.decideTimers.values()) t();
    this.decideTimers.clear();
    const winner = dealOrder ? this.rec(dealOrder[0]!)! : this.alive()[0]!;
    const order = [...(dealOrder ?? [winner.userId]), ...[...this.st.eliminations].reverse()];
    const unique = order.length;
    // Garance: chybějící část prize poolu doplní dům (případně nově vydaná měna).
    const guarantee = num(s, 'tournament.guarantee');
    const collected = this.prizePool();
    if (guarantee > collected) this.deps.money.overlay(this.deps.id, guarantee - collected, `trn:${this.deps.id}:overlay`);
    this.st.overlay = Math.max(0, guarantee - collected);
    const pool = this.prizePool();
    let amounts: number[] = [];
    let toHouse = pool;
    if (pool > 0) {
      const pct = percentsFor(s['tournament.payoutPreset'] as PayoutPreset, String(s['tournament.payoutCustom']), unique);
      const r = computePayouts(pool, pct, { roundTo: num(s, 'tournament.payoutRoundTo'), remainder: s['tournament.payoutRemainder'] as RemainderRule });
      amounts = r.amounts;
      toHouse = r.toHouse;
    }
    // Bounty: nevyplacené odměny (režim „na konci“) a zbytek na účtu bounty (hlava vítěze, nevylosované hodnoty) připadnou vítězi.
    if (this.bountyType() !== 'none') {
      for (const p of this.st.players) {
        const unpaid = p.bountyUnpaid ?? 0;
        if (unpaid > 0) {
          this.st.knockouts = (this.st.knockouts ?? 0) + 1;
          this.deps.money.bountyPay(this.deps.id, p.userId, unpaid, `trn:${this.deps.id}:bounty:${this.st.knockouts}`, 'bounty na konci turnaje');
          p.bountyUnpaid = 0;
        }
      }
      const rest = this.deps.money.bountyBank(this.deps.id);
      if (rest > 0 && dealOrder) {
        // Dohoda ukončila turnaj: zbytek bounty se rozdělí podle zbývajících hlav (u mystery rovným dílem).
        const parts = distribute(rest, dealOrder.map((id) => this.rec(id)?.head ?? 0));
        dealOrder.forEach((id, i) => {
          if (parts[i]! <= 0) return;
          this.deps.money.bountyPay(this.deps.id, id, parts[i]!, `trn:${this.deps.id}:bountyRest:${i}`, 'zbytek bounty po dohodě');
          this.rec(id)!.bountyEarned = (this.rec(id)!.bountyEarned ?? 0) + parts[i]!;
        });
      } else if (rest > 0) {
        this.deps.money.bountyPay(this.deps.id, winner.userId, rest, `trn:${this.deps.id}:bountyRest`, 'zbytek bounty vítězi');
        winner.bountyEarned = (winner.bountyEarned ?? 0) + rest;
      }
    }
    // Dohoda: účastníci dostanou dohodnuté částky (vítěz navíc ponechanou část), ostatní výplatu za své místo.
    const deal = this.st.deal;
    const results = order.map((userId, i) => ({ userId, name: this.rec(userId)?.name ?? '', place: i + 1, payout: deal && userId in deal.amounts ? deal.amounts[userId]! + (i === 0 ? deal.keep : 0) : (amounts[i] ?? 0), bounty: this.rec(userId)?.bountyEarned ?? 0 }));
    for (const r of results) if (r.payout > 0) this.deps.money.payout(this.deps.id, r.userId, r.payout, `trn:${this.deps.id}:payout:${r.place}`);
    if (toHouse > 0) this.deps.money.toHouse(this.deps.id, toHouse, `trn:${this.deps.id}:house`);
    this.st.results = results;
    this.st.status = 'finished';
    this.st.finishedAt = this.deps.clock.now();
    for (const p of this.st.players) if (p.status !== 'out') p.status = 'out';
    // Stůl se zavře až po dokončení právě probíhajícího předělu (finish se volá z jeho události).
    const table = this.table;
    queueMicrotask(() => table?.close());
    this.deps.onEvent?.({ type: 'finished', results });
  }

  // ---------- dohoda (deal) ----------

  /** Aktuální výplatní tabulka podle počtu hráčů; garance se počítá, jako by už byla doplněna. */
  private payoutTable(): number[] {
    const s = this.deps.settings();
    const pool = Math.max(this.prizePool(), num(s, 'tournament.guarantee'));
    if (pool <= 0) return [];
    const pct = percentsFor(s['tournament.payoutPreset'] as PayoutPreset, String(s['tournament.payoutCustom']), Math.max(1, this.st.players.length));
    return computePayouts(pool, pct, { roundTo: num(s, 'tournament.payoutRoundTo'), remainder: s['tournament.payoutRemainder'] as RemainderRule }).amounts;
  }

  private dealMethods(): DealMethod[] {
    const s = this.deps.settings();
    const out: DealMethod[] = [];
    if (s['tournament.dealIcm']) out.push('icm');
    if (s['tournament.dealChipChop']) out.push('chipChop');
    if (s['tournament.dealEqual']) out.push('equal');
    if (s['tournament.dealCustom']) out.push('custom');
    return out;
  }

  /** Proč se teď nedá navrhnout dohoda (null = lze). */
  dealBlocker(): TournamentErrorCode | null {
    const s = this.deps.settings();
    if (!s['tournament.dealEnabled']) return 'DEAL_DISABLED';
    if (this.st.status !== 'running') return 'STATE';
    if (this.st.deal) return 'DEAL_DONE';
    const alive = this.alive();
    if (alive.length < 2 || alive.length > num(s, 'tournament.dealMaxPlayers') || alive.some((p) => p.status !== 'playing')) return 'DEAL_PLAYERS';
    const rebuyOpen = !!s['tournament.rebuyEnabled'] && this.levelNumber() <= num(s, 'tournament.rebuyUntilLevel');
    const addonOpen = !!s['tournament.addonEnabled'] && this.levelNumber() <= num(s, 'tournament.addonUntilLevel');
    if (this.lateRegOpen() || rebuyOpen || addonOpen) return 'DEAL_WINDOWS_OPEN';
    if (this.voting.active('deal')) return 'DEAL_ACTIVE';
    const last = this.st.lastDealRejectedAt;
    if (last !== undefined && this.deps.clock.now() - last < num(s, 'tournament.dealCooldownSeconds') * 1000) return 'DEAL_COOLDOWN';
    return null;
  }

  /** Podklady pro dialog dohody: hráči, žetony, dělená částka a výsledek každé povolené metody. */
  dealOptions(viewerId: string | null = null): DealOptions {
    const s = this.deps.settings();
    const blocked = this.dealBlocker();
    const alive = this.alive().filter((p) => p.status === 'playing');
    const participants = alive.map((p) => ({ userId: p.userId, name: p.name, chips: this.table?.chipsOf(p.userId) ?? 0 }));
    const table = this.payoutTable();
    const k = participants.length;
    const total = table.slice(0, k).reduce((a, b) => a + b, 0);
    const keepMax = Math.floor((total * num(s, 'tournament.dealKeepMaxPercent')) / 100);
    const methods: DealOptions['methods'] = {};
    if (k >= 2 && total > 0) {
      for (const m of this.dealMethods()) {
        if (m === 'custom') continue;
        methods[m] = dealAmounts(m, participants, total, { roundTo: num(s, 'tournament.payoutRoundTo'), prizes: table.slice(0, k) });
      }
    }
    const vote = this.voting.active('deal') ?? [...this.voting.all()].reverse().find((v) => v.kind === 'deal');
    return {
      blocked,
      enabled: !!s['tournament.dealEnabled'],
      maxPlayers: num(s, 'tournament.dealMaxPlayers'),
      allowed: this.dealMethods(),
      participants,
      total,
      keepMax,
      methods,
      vote: vote ? this.voting.view(vote.id, viewerId) ?? null : null,
      deal: this.st.deal ?? null,
    };
  }

  /** Návrh dohody. Částky se počítají na serveru ze žetonů v tuto chvíli; klient posílá jen metodu (a u vlastní dohody částky). */
  proposeDeal(proposerId: string | null, input: { method: DealMethod; keep?: number; custom?: Record<string, number> }): VoteState {
    const blocker = this.dealBlocker();
    if (blocker) throw new TournamentError(blocker === 'STATE' ? 'STATE' : blocker, { max: num(this.deps.settings(), 'tournament.dealMaxPlayers') });
    const s = this.deps.settings();
    if (proposerId !== null) {
      const me = this.rec(proposerId);
      if (!me || me.status !== 'playing') throw new TournamentError('FORBIDDEN');
    }
    if (!this.dealMethods().includes(input.method)) throw new TournamentError('DEAL_INVALID', { reason: 'method' });
    const opt = this.dealOptions();
    const keep = Math.floor(input.keep ?? 0);
    if (keep < 0 || keep > opt.keepMax) throw new TournamentError('DEAL_INVALID', { reason: 'keep', max: opt.keepMax });
    let amounts: Record<string, number>;
    try {
      amounts = dealAmounts(input.method, opt.participants, opt.total - keep, { roundTo: num(s, 'tournament.payoutRoundTo'), prizes: this.payoutTable().slice(0, opt.participants.length), custom: input.custom });
    } catch (e) {
      if (e instanceof DealError) throw new TournamentError('DEAL_INVALID', { reason: e.code });
      throw e;
    }
    const payload: DealPayload = { method: input.method, amounts, keep, total: opt.total, chips: Object.fromEntries(opt.participants.map((p) => [p.userId, p.chips])) };
    const vote = this.voting.propose({
      kind: 'deal',
      proposer: proposerId,
      voters: opt.participants.map((p) => p.userId),
      threshold: { type: 'unanimous' },
      timeoutMs: num(s, 'tournament.dealVoteSeconds') * 1000,
      payload,
    });
    this.deps.onEvent?.({ type: 'dealProposed', method: input.method });
    return vote;
  }

  voteDeal(userId: string, yes: boolean): void {
    const v = this.voting.active('deal');
    if (!v) throw new TournamentError('NO_VOTE');
    try {
      this.voting.vote(v.id, userId, yes);
    } catch (e) {
      if (e instanceof VoteError) throw new TournamentError(e.code === 'NOT_VOTER' ? 'NOT_VOTER' : 'NO_VOTE');
      throw e;
    }
  }

  cancelDealVote(): void {
    this.voting.cancelAll('deal');
  }

  voteView(id: string, viewerId: string | null): VoteView | undefined {
    return this.voting.view(id, viewerId);
  }

  private onDealResolved(vote: VoteState): void {
    if (this.st.status !== 'running') return;
    if (vote.status !== 'passed') {
      if (vote.status === 'rejected' || vote.status === 'expired') {
        this.st.lastDealRejectedAt = this.deps.clock.now();
        this.deps.onEvent?.({ type: 'dealRejected' });
      }
      return;
    }
    const payload = vote.payload as DealPayload;
    const participants = vote.voters;
    this.st.deal = { method: payload.method, amounts: payload.amounts, keep: payload.keep, participants, at: this.deps.clock.now() };
    this.deps.onEvent?.({ type: 'dealAccepted', method: payload.method, keep: payload.keep });
    if (payload.keep === 0) {
      // Dohoda ukončuje turnaj: pořadí zbývajících podle žetonů (kdo má víc, je výš).
      const ranked = [...participants].sort((a, b) => (this.table?.chipsOf(b) ?? 0) - (this.table?.chipsOf(a) ?? 0));
      this.finish(ranked);
    }
    this.save();
  }

  private save(): void {
    this.st.votes = this.voting.all();
    this.deps.persist?.(this.st);
    this.deps.onChange?.();
  }
}
