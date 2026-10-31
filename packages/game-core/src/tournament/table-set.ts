import { randomInt } from 'node:crypto';
import type { TournamentTable } from './tournament.js';

/** Co turnaj potřebuje od jednoho ze svých stolů (podmnožina `TableActor`). */
export interface SetTable {
  seatTournamentPlayer(userId: string, name: string, seat: number, chips: number): void;
  addTournamentChips(userId: string, chips: number): void;
  removeTournamentPlayer(userId: string): void;
  chipsOf(userId: string): number | null;
  isConnected?(userId: string): boolean | null;
  hold(fresh?: boolean): void;
  release(): void;
  playersSeated(): { userId: string; name: string; seat: number; chips: number; pendingChips: number; mode: string }[];
  close(): void;
  currentPhase(): string;
  /** Pohled diváka (kvůli pozici dealera). */
  viewFor(userId: string | null): { buttonSeat: number | null };
}

/** Navržené přesazení hráče (živý turnaj). */
export interface SeatMove {
  userId: string;
  name: string;
  fromTable: string;
  toTable: string;
  reason: 'balance' | 'break';
}

export type TableSetEvent =
  | { type: 'moved'; userId: string; name: string; fromTable: string; toTable: string; seat: number }
  /** Hráč dostal konkrétní místo (při usazení a přesazení): turnaj si ho zapíše do svého stavu. */
  | { type: 'seated'; userId: string; tableId: string; seat: number }
  | { type: 'tableBroken'; tableId: string; moved: { userId: string; name: string; toTable: string; seat: number }[] }
  | { type: 'finalTable'; tableId: string }
  | { type: 'handForHand'; active: boolean };

export interface TableSetOptions {
  tournamentId: string;
  seatsPerTable: () => number;
  maxTables: () => number;
  /** Největší povolený rozdíl v počtu hráčů mezi nejplnějším a nejprázdnějším stolem. */
  balanceMaxDiff: () => number;
  /** Je hand-for-hand v nastavení zapnutý? */
  handForHand: () => boolean;
  /** Blíží se bublina, takže se hraje hand-for-hand (rozhoduje turnaj). */
  handForHandActive: () => boolean;
  /** Vytvoří stůl (nebo ho obnoví z uloženého stavu) a zaregistruje ho. */
  createTable: (tableId: string) => SetTable;
  /** Stůl je zrušený: odregistrovat. */
  destroyTable: (tableId: string) => void;
  /** Změnil se seznam stolů (uložit do stavu turnaje). */
  onTablesChanged: (ids: string[]) => void;
  onEvent?: (e: TableSetEvent) => void;
  /** Živý turnaj: sada jen radí (přesazení potvrzuje ředitel), sama nic nepřesazuje. */
  advisory?: boolean;
  /** Náhodné číslo od 0 do n−1 (kryptografický generátor, v testech jde podvrhnout). */
  rnd?: (n: number) => number;
}

interface Entry {
  id: string;
  table: SetTable;
}

/**
 * Stoly jednoho turnaje: rozsadí hráče vyváženě, po každé handě vyrovnává počty, ruší stoly, na které už nezbývají
 * hráči (až po finálový stůl), a na bublině drží stoly, aby se hrálo hand-for-hand. Turnaj s ním mluví jako s jedním
 * stolem (`TournamentTable`), takže jednostolový turnaj se chová stejně jako dřív.
 */
export class TournamentTableSet implements TournamentTable {
  private tables: Entry[] = [];
  /** Stoly, které dohrály handu a čekají na ostatní (hand-for-hand). */
  private waiting = new Set<string>();
  private hfh = false;
  private rnd: (n: number) => number;

  constructor(private o: TableSetOptions) {
    this.rnd = o.rnd ?? ((n) => randomInt(n));
  }

  // ---------- evidence stolů ----------

  /** Nový turnaj: první stůl má id turnaje. */
  init(): void {
    if (this.tables.length === 0) this.add(this.o.tournamentId);
  }

  /** Obnova po restartu serveru: stoly podle uloženého seznamu. */
  restore(ids: string[]): void {
    for (const id of ids.length ? ids : [this.o.tournamentId]) this.add(id);
  }

  private add(id: string): Entry {
    const e = { id, table: this.o.createTable(id) };
    this.tables.push(e);
    this.o.onTablesChanged(this.tableIds());
    return e;
  }

  private nextId(): string {
    const used = new Set(this.tables.map((t) => t.id));
    for (let n = 2; ; n++) {
      const id = `${this.o.tournamentId}~${n}`;
      if (!used.has(id)) return id;
    }
  }

  tableIds(): string[] {
    return this.tables.map((t) => t.id);
  }

  tableCount(): number {
    return this.tables.length;
  }

  /** Stůl, který určuje hodiny „po handách“ (první v pořadí). */
  isLead(tableId: string): boolean {
    return this.tables[0]?.id === tableId;
  }

  tableOf(userId: string): string | null {
    return this.find(userId)?.id ?? null;
  }

  /** Skutečné místo hráče u jeho stolu. */
  seatOf(userId: string): number | null {
    return this.find(userId)?.table.playersSeated().find((s) => s.userId === userId)?.seat ?? null;
  }

  /** Stoly s hráči (pro přehled na stránce turnaje). */
  overview(): { id: string; players: { userId: string; name: string; seat: number; chips: number }[] }[] {
    return this.tables.map((t) => ({ id: t.id, players: t.table.playersSeated().filter((s) => s.mode !== 'leaving').map((s) => ({ userId: s.userId, name: s.name, seat: s.seat, chips: s.chips + s.pendingChips })) }));
  }

  get(tableId: string): SetTable | undefined {
    return this.tables.find((t) => t.id === tableId)?.table;
  }

  private find(userId: string): Entry | undefined {
    return this.tables.find((t) => t.table.playersSeated().some((s) => s.userId === userId));
  }

  private seats(): number {
    return this.o.seatsPerTable();
  }

  /** Hráči u stolu, kteří se nerozloučili (včetně těch, co čekají na rozhodnutí o rebuy). */
  private count(t: Entry): number {
    return t.table.playersSeated().filter((s) => s.mode !== 'leaving').length;
  }

  private freeSeat(t: Entry): number | null {
    const taken = new Set(t.table.playersSeated().map((s) => s.seat));
    const free = Array.from({ length: this.seats() }, (_, i) => i).filter((i) => !taken.has(i));
    return free.length ? free[this.rnd(free.length)]! : null;
  }

  // ---------- rozhraní pro turnaj ----------

  prepareStart(players: number): void {
    const need = Math.min(this.o.maxTables(), Math.max(1, Math.ceil(players / this.seats())));
    while (this.tables.length < need) this.add(this.nextId());
  }

  /** Usadí hráče k nejméně obsazenému stolu na náhodné místo; `seat` z turnaje se ignoruje (vyvažuje se podle počtu). */
  seatTournamentPlayer(userId: string, name: string, _seat: number, chips: number): void {
    let candidates = this.tables.filter((t) => this.count(t) < this.seats());
    if (candidates.length === 0 && this.tables.length < this.o.maxTables()) candidates = [this.add(this.nextId())];
    if (candidates.length === 0) throw new Error('FULL');
    const min = Math.min(...candidates.map((t) => this.count(t)));
    const lowest = candidates.filter((t) => this.count(t) === min);
    const t = lowest[this.rnd(lowest.length)]!;
    const seat = this.freeSeat(t)!;
    t.table.seatTournamentPlayer(userId, name, seat, chips);
    this.o.onEvent?.({ type: 'seated', userId, tableId: t.id, seat });
  }

  addTournamentChips(userId: string, chips: number): void {
    const t = this.find(userId);
    if (!t) throw new Error('NOT_SEATED');
    t.table.addTournamentChips(userId, chips);
  }

  removeTournamentPlayer(userId: string): void {
    const t = this.find(userId);
    if (!t) throw new Error('NOT_SEATED');
    t.table.removeTournamentPlayer(userId);
    // Po vyřazení může stolům, které zrovna nehrají, začít chybět hráči: tady se to vyřeší hned.
    this.afterRemoval();
  }

  isConnected(userId: string): boolean | null {
    return this.find(userId)?.table.isConnected?.(userId) ?? null;
  }

  chipsOf(userId: string): number | null {
    return this.find(userId)?.table.chipsOf(userId) ?? null;
  }

  hold(fresh?: boolean): void {
    for (const t of this.tables) t.table.hold(fresh);
  }

  release(): void {
    this.waiting.clear();
    for (const t of this.tables) t.table.release();
  }

  /** Všichni hráči se virtuálním číslem místa (index stolu × místa u stolu + místo). */
  playersSeated(): { userId: string; seat: number }[] {
    const per = this.seats();
    return this.tables.flatMap((t, i) => t.table.playersSeated().map((s) => ({ userId: s.userId, seat: i * per + s.seat })));
  }

  close(): void {
    for (const t of this.tables) {
      t.table.close();
      if (t.id !== this.o.tournamentId) this.o.destroyTable(t.id);
    }
  }

  // ---------- vyvažování a rušení stolů ----------

  /** Volá stůl na předělu po skončené handě. */
  onBoundary(tableId: string): void {
    const t = this.tables.find((x) => x.id === tableId);
    if (!t || this.tables.length === 0) return;
    this.rebalance(t);
    this.holdForHand(tableId);
  }

  /** Počet stolů, které turnaj potřebuje pro dosavadní hráče. */
  private needed(): number {
    const players = this.tables.reduce((n, t) => n + this.count(t), 0);
    return Math.max(1, Math.ceil(players / this.seats()));
  }

  /** Smí se z tohoto stolu přesazovat? Jen mezi handami a když nikdo nečeká na rozhodnutí o rebuy. */
  private movable(t: Entry): boolean {
    if (t.table.currentPhase() === 'hand' || t.table.currentPhase() === 'runout') return false;
    return t.table.playersSeated().every((s) => s.mode === 'leaving' || s.chips + s.pendingChips > 0);
  }

  /** Další velká blind u stolu: druhý hráč po dealerovi. Hráč ve hře, kterému by to bylo nejméně nepříjemné přesadit. */
  private pickToMove(t: Entry): { userId: string; name: string } | null {
    const per = this.seats();
    const players = t.table.playersSeated().filter((s) => s.mode !== 'leaving' && s.chips + s.pendingChips > 0);
    if (players.length === 0) return null;
    const button = t.table.viewFor(null).buttonSeat;
    if (button === null) return players[this.rnd(players.length)]!;
    const order = [...players].sort((a, b) => ((a.seat - button + per) % per || per) - ((b.seat - button + per) % per || per));
    return order[Math.min(1, order.length - 1)]!;
  }

  private rebalance(t: Entry): void {
    if (this.tables.length <= 1 || !this.movable(t)) return;
    // Stůl, na který už nezbývají hráči, se rozpustí, jakmile je nejmenší.
    if (this.tables.length > this.needed()) {
      const smallest = Math.min(...this.tables.map((x) => this.count(x)));
      if (this.count(t) === smallest) {
        this.breakTable(t);
        return;
      }
    }
    for (let guard = 0; guard < this.seats(); guard++) {
      const others = this.tables.filter((x) => x !== t && this.count(x) < this.seats());
      if (others.length === 0) return;
      const target = others.reduce((a, b) => (this.count(b) < this.count(a) ? b : a));
      if (this.count(t) - this.count(target) <= this.o.balanceMaxDiff()) return;
      const who = this.pickToMove(t);
      if (!who) return;
      const seat = this.freeSeat(target);
      const chips = t.table.chipsOf(who.userId);
      if (seat === null || chips === null || chips <= 0) return;
      target.table.seatTournamentPlayer(who.userId, who.name, seat, chips);
      t.table.removeTournamentPlayer(who.userId);
      this.o.onEvent?.({ type: 'moved', userId: who.userId, name: who.name, fromTable: t.id, toTable: target.id, seat });
      this.o.onEvent?.({ type: 'seated', userId: who.userId, tableId: target.id, seat });
    }
  }

  private breakTable(t: Entry): void {
    const players = t.table.playersSeated().filter((s) => s.mode !== 'leaving');
    const moved: { userId: string; name: string; toTable: string; seat: number }[] = [];
    for (const p of players) {
      const others = this.tables.filter((x) => x !== t && this.count(x) < this.seats());
      if (others.length === 0) return;
      const target = others.reduce((a, b) => (this.count(b) < this.count(a) ? b : a));
      const seat = this.freeSeat(target)!;
      const chips = t.table.chipsOf(p.userId);
      if (chips === null || chips <= 0) return;
      target.table.seatTournamentPlayer(p.userId, p.name, seat, chips);
      t.table.removeTournamentPlayer(p.userId);
      moved.push({ userId: p.userId, name: p.name, toTable: target.id, seat });
      this.o.onEvent?.({ type: 'seated', userId: p.userId, tableId: target.id, seat });
    }
    this.tables = this.tables.filter((x) => x !== t);
    this.waiting.delete(t.id);
    t.table.close();
    if (t.id !== this.o.tournamentId) this.o.destroyTable(t.id);
    this.o.onTablesChanged(this.tableIds());
    this.o.onEvent?.({ type: 'tableBroken', tableId: t.id, moved });
    if (this.tables.length === 1) this.o.onEvent?.({ type: 'finalTable', tableId: this.tables[0]!.id });
  }

  /** Stoly, které zrovna nehrají, po vyřazení zkontrolují počty (zastavený stůl žádný další předěl nedostane). */
  private afterRemoval(): void {
    if (this.o.advisory) {
      this.pruneEmpty();
      return;
    }
    for (const t of [...this.tables]) if (this.tables.includes(t) && t.table.currentPhase() === 'idle') this.rebalance(t);
    this.syncHandForHand();
  }

  // ---------- rady pro živý turnaj ----------

  /** Prázdné stoly, které už turnaj nepotřebuje, zaniknou (živý turnaj nemá předěly, kde by se to stalo samo). */
  private pruneEmpty(): void {
    for (const t of [...this.tables]) {
      if (this.tables.length <= 1 || this.count(t) > 0 || this.tables.length <= this.needed()) continue;
      this.tables = this.tables.filter((x) => x !== t);
      t.table.close();
      if (t.id !== this.o.tournamentId) this.o.destroyTable(t.id);
      this.o.onTablesChanged(this.tableIds());
      this.o.onEvent?.({ type: 'tableBroken', tableId: t.id, moved: [] });
      if (this.tables.length === 1) this.o.onEvent?.({ type: 'finalTable', tableId: this.tables[0]!.id });
    }
  }

  /**
   * Co by se mělo přesadit, aby stoly byly vyvážené, případně aby se nejmenší stůl zrušil. Nic neprovádí,
   * jen navrhuje (platí pro živý turnaj, kde přesazení potvrzuje ředitel).
   */
  suggest(): SeatMove[] {
    if (this.tables.length < 2) return [];
    const per = this.seats();
    const counts = new Map(this.tables.map((t) => [t.id, this.count(t)]));
    const moves: SeatMove[] = [];
    const taken = new Set<string>();
    const pickFrom = (t: Entry) => {
      const players = t.table.playersSeated().filter((s) => s.mode !== 'leaving' && !taken.has(s.userId));
      return [...players].sort((a, b) => b.seat - a.seat)[0];
    };
    const target = (except: string) => {
      const open = this.tables.filter((x) => x.id !== except && counts.get(x.id)! < per);
      return open.length ? open.reduce((a, b) => (counts.get(b.id)! < counts.get(a.id)! ? b : a)) : null;
    };
    if (this.tables.length > this.needed()) {
      const smallest = this.tables.reduce((a, b) => (counts.get(b.id)! < counts.get(a.id)! ? b : a));
      for (let guard = 0; guard < per; guard++) {
        const p = pickFrom(smallest);
        const to = p ? target(smallest.id) : null;
        if (!p || !to) break;
        taken.add(p.userId);
        counts.set(smallest.id, counts.get(smallest.id)! - 1);
        counts.set(to.id, counts.get(to.id)! + 1);
        moves.push({ userId: p.userId, name: p.name, fromTable: smallest.id, toTable: to.id, reason: 'break' });
      }
      return moves;
    }
    for (let guard = 0; guard < per * this.tables.length; guard++) {
      const from = this.tables.reduce((a, b) => (counts.get(b.id)! > counts.get(a.id)! ? b : a));
      const to = target(from.id);
      if (!to || counts.get(from.id)! - counts.get(to.id)! <= this.o.balanceMaxDiff()) break;
      const p = pickFrom(from);
      if (!p) break;
      taken.add(p.userId);
      counts.set(from.id, counts.get(from.id)! - 1);
      counts.set(to.id, counts.get(to.id)! + 1);
      moves.push({ userId: p.userId, name: p.name, fromTable: from.id, toTable: to.id, reason: 'balance' });
    }
    return moves;
  }

  /** Provede přesazení, které ředitel potvrdil; vrací nové místo. */
  applyMove(userId: string, toTable: string): { seat: number; fromTable: string } {
    const from = this.find(userId);
    const to = this.tables.find((t) => t.id === toTable);
    if (!from || !to || from === to) throw new Error('INVALID_MOVE');
    const seat = this.freeSeat(to);
    if (seat === null) throw new Error('TABLE_FULL');
    const name = from.table.playersSeated().find((s) => s.userId === userId)?.name ?? '';
    const chips = from.table.chipsOf(userId) ?? 1;
    to.table.seatTournamentPlayer(userId, name, seat, chips);
    from.table.removeTournamentPlayer(userId);
    this.o.onEvent?.({ type: 'moved', userId, name, fromTable: from.id, toTable: to.id, seat });
    this.o.onEvent?.({ type: 'seated', userId, tableId: to.id, seat });
    this.pruneEmpty();
    return { seat, fromTable: from.id };
  }

  // ---------- hand-for-hand ----------

  private holdForHand(tableId: string): void {
    if (this.tables.length < 2 || !this.o.handForHand() || !this.o.handForHandActive()) {
      this.syncHandForHand();
      return;
    }
    if (!this.hfh) {
      this.hfh = true;
      this.o.onEvent?.({ type: 'handForHand', active: true });
    }
    const t = this.tables.find((x) => x.id === tableId);
    if (!t) return;
    // Poslední stůl, který dohrál: ostatní se uvolní a tento (je uprostřed předělu) bez zdržení rozdá sám.
    // Uvolnění nesmí naplánovat další předěl, jinak by se předěl provedl dvakrát a rozehraná handa by přišla o žetony.
    if (this.tables.every((x) => x === t || this.waiting.has(x.id))) {
      for (const x of this.tables) if (x !== t) x.table.release();
      this.waiting.clear();
      return;
    }
    t.table.hold();
    this.waiting.add(tableId);
  }

  /** Bublina splasla (nebo zbyl jeden stůl): zadržené stoly se uvolní. */
  private syncHandForHand(): void {
    const active = this.tables.length > 1 && this.o.handForHand() && this.o.handForHandActive();
    if (active) return;
    if (this.waiting.size > 0) {
      for (const x of this.tables) if (this.waiting.has(x.id)) x.table.release();
      this.waiting.clear();
    }
    if (this.hfh) {
      this.hfh = false;
      this.o.onEvent?.({ type: 'handForHand', active: false });
    }
  }
}
