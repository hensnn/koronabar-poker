import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { bestFive, describeHand, type Card } from '@kb/game-core';
import { minimalTransfers, type Transfer } from '@kb/ledger';
import { formatLocal, t, type PermissionChecker, type SettingValues } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';
import { SIDE_KINDS, SIDE_SET } from './side-results.js';
import { settlementPartOf } from './wallet/service.js';

export type EveningErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'DISABLED' | 'CLOSED' | 'GAME_TAKEN' | 'OPEN_EXISTS';

export class EveningError extends Error {
  constructor(
    public code: EveningErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export type GameKind = 'tournament' | 'live_cash' | 'cash';

export interface EveningPlayer {
  userId: string;
  nickname: string;
  net: number;
  cash: number;
  tournament: number;
  /** Sázky na dění v turnajích a odměny na hlavu. */
  side: number;
  /** Rozpis čistého výsledku podle druhu pohybu v účetní knize (klíč = druh záznamu, např. turnaj_buyin, head_bounty_payout). */
  breakdown: Record<string, number>;
  /** Totéž slité do složek pro tabulku (buy-in, rebuy, add-on, výhra, bounty, odměny na hlavu, sázky, cash…); součet = výsledek. */
  parts: Record<string, number>;
  knockouts: number;
  placePoints: number;
  xp: number;
  score: number;
}

export interface EveningLine {
  userId: string;
  game: string;
  kind: string;
  count: number;
  amount: number;
}

export interface EveningSummary {
  computedAt: number;
  from: number;
  to: number;
  games: { kind: GameKind; ref: string; name: string; results: Record<string, number> }[];
  players: EveningPlayer[];
  /** Všechny pohyby večera po hrách: kdo, v jaké hře, jakého druhu, kolikrát a o kolik. */
  lines: EveningLine[];
  transfers: Transfer[];
  names: Record<string, string>;
  /** Co dohromady vyhráli hráči proti herně (rake, poplatky, odvody); kladné číslo patří domu. */
  house: number;
  mvp: { userId: string; nickname: string; score: number } | null;
  awards: {
    hunter: { userId: string; nickname: string; count: number } | null;
    banker: { userId: string; nickname: string; handId: string; game: string; bb: number; amount: number; unit: 'currency' | 'chips' } | null;
    badBeat: { userId: string; nickname: string; handId: string; game: string; equity: number; hand: HandShow | null } | null;
  };
  stats: { games: number; players: number; turnover: number; biggestPotBb: number | null };
  /** Handa večera: nejlepší kombinace, která na showdownu padla (ukázané karty, pětice a název kombinace). */
  bestHand: BestHand | null;
}

/** Hráč u handy pro zobrazení kartami: jeho karty (jen ukázané), kolik vyhrál, jeho nejlepší pětice a název kombinace. */
export interface HandShowPlayer {
  userId: string;
  nickname: string;
  hole: [string, string] | null;
  won: number;
  role: 'loser' | 'winner' | 'best';
  five: string[] | null;
  desc: { key: string; params?: Record<string, string> } | null;
}

/** Handa pro zobrazení: společné karty a zúčastnění hráči s ukázanými kartami. */
export interface HandShow {
  handId: string;
  game: string;
  board: string[];
  players: HandShowPlayer[];
}

/** Nejlepší kombinace večera; `userId` je držitel. */
export interface BestHand extends HandShow {
  userId: string;
  nickname: string;
}

interface Deps {
  db: Db;
  perms: PermissionChecker;
  audit: AuditService;
  settings: () => SettingValues;
  now: () => number;
  /** Hráči, kteří právě sedí u cash stolů (jejich žetony se počítají jako výběr). */
  seated: () => { userId: string; tableId: string; chips: number }[];
  /** Zpráva do hlavního chatu. */
  postChat: (text: string) => Promise<void>;
  /** Nepovinný e-mail hráči (respektuje jeho předvolbu). */
  mail: (userId: string, template: string, vars: Record<string, string | number>) => Promise<void>;
  onChanged?: (id: string) => void;
  /** Večer byl uzavřen (napojení ven). */
  onClosed?: (info: { id: string; name: string; games: number; players: number; mvp: string }) => void;
}

type Meta = { ip?: string | null };
const WALLET_KINDS = ['cash_buyin', 'cash_topup', 'cash_cashout', 'cash_return', 'bounty', 'jackpot_payout', 'time_charge', ...SIDE_KINDS];
const BUYIN_KINDS = new Set(['cash_buyin', 'cash_topup', 'turnaj_buyin', 'turnaj_rebuy', 'turnaj_addon']);
const CASH_SEEN_MS = 60_000;

type Row = typeof schema.evenings.$inferSelect;

/** Pořadí složek ve všech tabulkách a exportech večera a her. */
export const EVENING_PARTS = ['cashBuyIn', 'cashOut', 'buyIn', 'rebuy', 'addon', 'payout', 'bounty', 'headBounty', 'bets', 'refund', 'other'] as const;

/** Pohyby hráče podle druhu v knize slité do složek tabulky (žetony u stolu u otevřeného večera se počítají jako výběr). */
function partsOf(breakdown: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [kind, amount] of Object.entries(breakdown)) {
    const part = kind === 'seated' ? 'cashOut' : settlementPartOf(kind);
    out[part] = (out[part] ?? 0) + amount;
  }
  return out;
}

/**
 * Herní večer: seskupuje hry (turnaje, živý cash, cash stoly v časovém okně), vyúčtuje je dohromady, vybere MVP
 * a ocenění z uložených dat (vyřazení, hand, šance na výhru). Souhrn se při uzavření uloží a pošle do chatu.
 */
export class EveningService {
  private cashSeen = new Map<string, number>();
  private openStart: number | null = null;

  /** Začátek právě otevřeného večera (pro osobní limity „za večer“); okamžitá hodnota bez databáze. */
  currentStart(): number | null {
    return this.openStart;
  }

  /** Načte začátek posledního otevřeného večera. */
  async refreshOpen(): Promise<void> {
    const [row] = await this.deps.db.select({ at: schema.evenings.startsAt }).from(schema.evenings).where(eq(schema.evenings.status, 'open')).orderBy(desc(schema.evenings.touchedAt)).limit(1);
    this.openStart = row?.at.getTime() ?? null;
  }

  constructor(private deps: Deps) {}

  private s() {
    return this.deps.settings();
  }

  private enabled(): void {
    if (!this.s()['evening.enabled']) throw new EveningError('DISABLED');
  }

  private manage(userId: string): void {
    if (!this.deps.perms.can(userId, 'vecer.spravovat').allowed) throw new EveningError('FORBIDDEN');
  }

  private async load(id: string): Promise<Row> {
    const [row] = await this.deps.db.select().from(schema.evenings).where(eq(schema.evenings.id, id));
    if (!row) throw new EveningError('NOT_FOUND');
    return row;
  }

  private async games(id: string) {
    return this.deps.db.select().from(schema.eveningGames).where(eq(schema.eveningGames.eveningId, id));
  }

  private async touch(id: string, at = this.deps.now()): Promise<void> {
    await this.deps.db.update(schema.evenings).set({ touchedAt: new Date(at) }).where(eq(schema.evenings.id, id));
  }

  // ---------- zakládání a přiřazování her ----------

  async create(actorId: string, name: string, meta: Meta = {}): Promise<{ id: string }> {
    this.manage(actorId);
    this.enabled();
    const clean = name.trim();
    if (clean.length < 2 || clean.length > 60) throw new EveningError('INVALID', { field: 'name' });
    const now = new Date(this.deps.now());
    const [row] = await this.deps.db.insert(schema.evenings).values({ name: clean, status: 'open', startsAt: now, touchedAt: now, createdBy: actorId, auto: false }).returning();
    await this.deps.audit.log({ actorId, action: 'vecer.zalozit', targetType: 'evening', targetId: row!.id, after: { name: clean }, ...meta });
    await this.refreshOpen();
    return { id: row!.id };
  }

  async rename(actorId: string, id: string, name: string, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    const clean = name.trim();
    if (clean.length < 2 || clean.length > 60) throw new EveningError('INVALID', { field: 'name' });
    await this.load(id);
    await this.deps.db.update(schema.evenings).set({ name: clean }).where(eq(schema.evenings.id, id));
    await this.deps.audit.log({ actorId, action: 'vecer.prejmenovat', targetType: 'evening', targetId: id, after: { name: clean }, ...meta });
  }

  /** Existuje hra s tímto druhem a id? Vrací její název. */
  private async gameName(kind: GameKind, ref: string): Promise<string | null> {
    const db = this.deps.db;
    if (kind === 'tournament') return (await db.select({ n: schema.tournaments.name }).from(schema.tournaments).where(eq(schema.tournaments.id, ref)))[0]?.n ?? null;
    if (kind === 'live_cash') return (await db.select({ n: schema.liveCashGames.name }).from(schema.liveCashGames).where(eq(schema.liveCashGames.id, ref)))[0]?.n ?? null;
    return (await db.select({ n: schema.gameTables.name }).from(schema.gameTables).where(eq(schema.gameTables.id, ref)))[0]?.n ?? null;
  }

  async addGame(actorId: string, id: string, kind: GameKind, ref: string, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    const ev = await this.load(id);
    if (ev.status !== 'open') throw new EveningError('CLOSED');
    if (!['tournament', 'live_cash', 'cash'].includes(kind) || !(await this.gameName(kind, ref))) throw new EveningError('INVALID', { field: 'ref' });
    if (kind !== 'cash') {
      const [taken] = await this.deps.db.select().from(schema.eveningGames).where(and(eq(schema.eveningGames.kind, kind), eq(schema.eveningGames.ref, ref)));
      if (taken && taken.eveningId !== id) throw new EveningError('GAME_TAKEN');
    }
    await this.deps.db.insert(schema.eveningGames).values({ eveningId: id, kind, ref }).onConflictDoNothing();
    await this.touch(id);
    await this.deps.audit.log({ actorId, action: 'vecer.pridat_hru', targetType: 'evening', targetId: id, after: { kind, ref }, ...meta });
    this.deps.onChanged?.(id);
  }

  async removeGame(actorId: string, id: string, kind: GameKind, ref: string, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    const ev = await this.load(id);
    if (ev.status !== 'open') throw new EveningError('CLOSED');
    await this.deps.db.delete(schema.eveningGames).where(and(eq(schema.eveningGames.eveningId, id), eq(schema.eveningGames.kind, kind), eq(schema.eveningGames.ref, ref)));
    await this.deps.audit.log({ actorId, action: 'vecer.odebrat_hru', targetType: 'evening', targetId: id, after: { kind, ref }, ...meta });
    this.deps.onChanged?.(id);
  }

  /** Automatické přiřazení spuštěné hry: do otevřeného večera s nedávnou aktivitou, jinak do nového. */
  async attach(kind: GameKind, ref: string): Promise<string | null> {
    const s = this.s();
    if (!s['evening.enabled'] || !s['evening.autoCreate']) return null;
    const now = this.deps.now();
    if (kind !== 'cash') {
      const [taken] = await this.deps.db.select().from(schema.eveningGames).where(and(eq(schema.eveningGames.kind, kind), eq(schema.eveningGames.ref, ref)));
      if (taken) return taken.eveningId;
    }
    const since = new Date(now - Number(s['evening.gapHours']) * 3600_000);
    const [open] = await this.deps.db.select().from(schema.evenings).where(and(eq(schema.evenings.status, 'open'), gte(schema.evenings.touchedAt, since))).orderBy(desc(schema.evenings.touchedAt)).limit(1);
    let id = open?.id;
    if (!id) {
      const [row] = await this.deps.db
        .insert(schema.evenings)
        .values({ name: t('evening.autoName', { date: formatLocal(now) }), status: 'open', startsAt: new Date(now), touchedAt: new Date(now), auto: true })
        .returning();
      id = row!.id;
    }
    await this.deps.db.insert(schema.eveningGames).values({ eveningId: id, kind, ref }).onConflictDoNothing();
    await this.touch(id, now);
    await this.refreshOpen();
    this.deps.onChanged?.(id);
    return id;
  }

  /** Aktivita u cash stolu (nová handa): stůl se přiřadí k večeru, ale databáze se kvůli tomu neobtěžuje při každé handě. */
  async cashActivity(tableId: string): Promise<void> {
    const now = this.deps.now();
    const seen = this.cashSeen.get(tableId);
    if (seen !== undefined && now - seen < CASH_SEEN_MS) return;
    this.cashSeen.set(tableId, now);
    await this.attach('cash', tableId);
  }

  // ---------- souhrn ----------

  private weights() {
    const s = this.s();
    return { net: Number(s['evening.mvpNetWeight']), place: Number(s['evening.mvpPlaceWeight']), ko: Number(s['evening.mvpKnockoutWeight']), xp: Number(s['evening.mvpXpWeight']) };
  }

  async compute(ev: Row): Promise<EveningSummary> {
    const db = this.deps.db;
    const now = this.deps.now();
    const from = ev.startsAt.getTime();
    const to = ev.endsAt?.getTime() ?? now;
    const games = await this.games(ev.id);
    const tourIds = games.filter((g) => g.kind === 'tournament').map((g) => g.ref);
    const liveIds = games.filter((g) => g.kind === 'live_cash').map((g) => g.ref);
    const cashIds = games.filter((g) => g.kind === 'cash').map((g) => g.ref);
    const allIds = [...tourIds, ...liveIds, ...cashIds];
    const open = ev.status === 'open';

    // ---- peníze podle účetní knihy ----
    const txs = allIds.length
      ? await db
          .select({ id: schema.ledgerTransactions.id, kind: schema.ledgerTransactions.kind, gameId: schema.ledgerTransactions.gameId, at: schema.ledgerTransactions.at })
          .from(schema.ledgerTransactions)
          .where(and(inArray(schema.ledgerTransactions.gameId, allIds), or(sql`${schema.ledgerTransactions.kind} like 'turnaj_%'`, inArray(schema.ledgerTransactions.kind, WALLET_KINDS))))
      : [];
    const cashSet = new Set(cashIds);
    const inWindow = txs.filter((x) => !cashSet.has(x.gameId ?? '') || (x.at.getTime() >= from && x.at.getTime() <= to));
    const byTx = new Map(inWindow.map((x) => [x.id, x]));
    const entries = byTx.size ? await db.select().from(schema.ledgerEntries).where(and(inArray(schema.ledgerEntries.transactionId, [...byTx.keys()]), sql`${schema.ledgerEntries.account} like 'wallet:%'`)) : [];
    const results = new Map<string, Record<string, number>>();
    const cash: Record<string, number> = {};
    const tour: Record<string, number> = {};
    const side: Record<string, number> = {};
    const breakdown: Record<string, Record<string, number>> = {};
    const lineMap = new Map<string, EveningLine>();
    const addLine = (userId: string, game: string, kind: string, amount: number, count: number) => {
      const key = `${userId}|${game}|${kind}`;
      const l = lineMap.get(key) ?? { userId, game, kind, count: 0, amount: 0 };
      l.count += count;
      l.amount += amount;
      lineMap.set(key, l);
    };
    let turnover = 0;
    for (const e of entries) {
      const tx = byTx.get(e.transactionId)!;
      const uid = e.account.slice('wallet:'.length);
      const gid = tx.gameId ?? '';
      const r = results.get(gid) ?? {};
      r[uid] = (r[uid] ?? 0) + e.amount;
      results.set(gid, r);
      const isSide = SIDE_SET.has(tx.kind);
      const isTour = !isSide && (tx.kind.startsWith('turnaj_') || tx.kind === 'bounty');
      const bucket = isSide ? side : isTour ? tour : cash;
      bucket[uid] = (bucket[uid] ?? 0) + e.amount;
      (breakdown[uid] ??= {})[tx.kind] = (breakdown[uid]![tx.kind] ?? 0) + e.amount;
      addLine(uid, gid, tx.kind, e.amount, 1);
      if (BUYIN_KINDS.has(tx.kind) && e.amount < 0) turnover += -e.amount;
    }
    if (open) {
      const rate = Number(this.s()['cash.chipsPerCurrencyUnit']) || 1;
      for (const seat of this.deps.seated()) {
        if (!cashSet.has(seat.tableId)) continue;
        const value = Math.floor(seat.chips / rate);
        cash[seat.userId] = (cash[seat.userId] ?? 0) + value;
        (breakdown[seat.userId] ??= {}).seated = (breakdown[seat.userId]!.seated ?? 0) + value;
        addLine(seat.userId, seat.tableId, 'seated', value, 1);
        const r = results.get(seat.tableId) ?? {};
        r[seat.userId] = (r[seat.userId] ?? 0) + value;
        results.set(seat.tableId, r);
      }
    }

    // ---- umístění, vyřazení, XP ----
    const gr = tourIds.length ? await db.select().from(schema.gameResults).where(and(eq(schema.gameResults.kind, 'tournament'), inArray(schema.gameResults.ref, tourIds))) : [];
    const placePoints: Record<string, number> = {};
    for (const r of gr) placePoints[r.userId] = (placePoints[r.userId] ?? 0) + (r.field > 1 ? (r.field - r.place) / (r.field - 1) : 0);
    const elim = tourIds.length ? await db.select().from(schema.tournamentEliminations).where(inArray(schema.tournamentEliminations.tournamentId, tourIds)) : [];
    const knockouts: Record<string, number> = {};
    for (const e of elim) for (const k of e.killers) knockouts[k.userId] = (knockouts[k.userId] ?? 0) + 1;

    const userIds = [...new Set([...Object.keys(cash), ...Object.keys(tour), ...Object.keys(side), ...gr.map((r) => r.userId), ...Object.keys(knockouts)])];
    const xp: Record<string, number> = {};
    if (userIds.length) {
      const rows = await db
        .select({ userId: schema.xpEvents.userId, amount: schema.xpEvents.amount })
        .from(schema.xpEvents)
        .where(and(inArray(schema.xpEvents.userId, userIds), gte(schema.xpEvents.createdAt, new Date(from)), lte(schema.xpEvents.createdAt, new Date(to))));
      for (const r of rows) xp[r.userId] = (xp[r.userId] ?? 0) + r.amount;
    }
    const users = userIds.length ? await db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
    const names: Record<string, string> = Object.fromEntries(users.map((u) => [u.id, u.nickname]));

    const w = this.weights();
    const players: EveningPlayer[] = userIds.map((userId) => {
      const net = (cash[userId] ?? 0) + (tour[userId] ?? 0) + (side[userId] ?? 0);
      const pp = Math.round((placePoints[userId] ?? 0) * 100) / 100;
      const score = Math.round(((net * w.net) / 100 + pp * w.place + (knockouts[userId] ?? 0) * w.ko + ((xp[userId] ?? 0) * w.xp) / 100) * 10) / 10;
      return { userId, nickname: names[userId] ?? '?', net, cash: cash[userId] ?? 0, tournament: tour[userId] ?? 0, side: side[userId] ?? 0, breakdown: breakdown[userId] ?? {}, parts: partsOf(breakdown[userId] ?? {}), knockouts: knockouts[userId] ?? 0, placePoints: pp, xp: xp[userId] ?? 0, score };
    });
    players.sort((a, b) => b.score - a.score || b.net - a.net || a.nickname.localeCompare(b.nickname));

    // ---- vyúčtování a převody ----
    const total = players.reduce((n, p) => n + p.net, 0);
    const nonZero = Object.fromEntries(players.filter((p) => p.net !== 0).map((p) => [p.userId, p.net]));
    const transfers = minimalTransfers(total !== 0 ? { ...nonZero, __dum: -total } : nonZero);
    names.__dum = t('evening.house');

    // ---- ocenění z uložených hand ----
    const handFilter = and(
      or(
        tourIds.length ? inArray(schema.hands.tournamentId, tourIds) : undefined,
        cashIds.length ? and(inArray(schema.hands.tableId, cashIds), gte(schema.hands.playedAt, new Date(from)), lte(schema.hands.playedAt, new Date(to))) : undefined,
      ),
    );
    const nameOfGame = async (tableId: string, tournamentId: string | null) => (await this.gameName(tournamentId ? 'tournament' : 'cash', tournamentId ?? tableId)) ?? tableId;
    let banker: EveningSummary['awards']['banker'] = null;
    let badBeat: EveningSummary['awards']['badBeat'] = null;
    let biggestPotBb: number | null = null;
    if (tourIds.length || cashIds.length) {
      const hs = await db
        .select({ id: schema.hands.id, tableId: schema.hands.tableId, tournamentId: schema.hands.tournamentId, pot: schema.hands.pot, blinds: schema.hands.blinds, cpu: schema.hands.chipsPerUnit })
        .from(schema.hands)
        .where(handFilter);
      let best: (typeof hs)[number] | null = null;
      let bestBb = 0;
      for (const h of hs) {
        const bb = h.blinds.bb > 0 ? h.pot / h.blinds.bb : 0;
        if (bb > bestBb) {
          bestBb = bb;
          best = h;
        }
      }
      if (best) {
        biggestPotBb = Math.round(bestBb * 10) / 10;
        const [winner] = await db.select({ userId: schema.handPlayers.userId, won: schema.handPlayers.won }).from(schema.handPlayers).where(eq(schema.handPlayers.handId, best.id)).orderBy(desc(schema.handPlayers.won)).limit(1);
        if (winner && winner.won > 0) {
          const nick = (await db.select({ n: schema.users.nickname }).from(schema.users).where(eq(schema.users.id, winner.userId)))[0]?.n ?? '?';
          banker = { userId: winner.userId, nickname: nick, handId: best.id, game: await nameOfGame(best.tableId, best.tournamentId), bb: biggestPotBb, amount: best.tournamentId ? best.pot : Math.floor(best.pot / best.cpu), unit: best.tournamentId ? 'chips' : 'currency' };
        }
      }
      const min = Number(this.s()['evening.badBeatMinPercent']) / 100;
      const [bb] = await db
        .select({ userId: schema.handPlayers.userId, equity: schema.handPlayers.allInEquity, handId: schema.hands.id, tableId: schema.hands.tableId, tournamentId: schema.hands.tournamentId, nick: schema.users.nickname })
        .from(schema.handPlayers)
        .innerJoin(schema.hands, eq(schema.hands.id, schema.handPlayers.handId))
        .innerJoin(schema.users, eq(schema.users.id, schema.handPlayers.userId))
        .where(and(handFilter, eq(schema.handPlayers.won, 0), gte(schema.handPlayers.allInEquity, min)))
        .orderBy(desc(schema.handPlayers.allInEquity))
        .limit(1);
      if (bb?.equity != null) badBeat = { userId: bb.userId, nickname: bb.nick, handId: bb.handId, game: await nameOfGame(bb.tableId, bb.tournamentId), equity: Math.round(bb.equity * 1000) / 10, hand: await this.handShow(bb.handId, 'loser', bb.userId) };
    }
    // handa večera: nejlepší kombinace na showdownu (nižší skóre je lepší), jen z ukázaných karet
    let bestHand: BestHand | null = null;
    if (tourIds.length || cashIds.length) {
      const [top] = await db
        .select({ userId: schema.handPlayers.userId, handId: schema.hands.id, nick: schema.users.nickname })
        .from(schema.handPlayers)
        .innerJoin(schema.hands, eq(schema.hands.id, schema.handPlayers.handId))
        .innerJoin(schema.users, eq(schema.users.id, schema.handPlayers.userId))
        .where(and(handFilter, eq(schema.handPlayers.revealed, true), sql`${schema.handPlayers.handScore} is not null`, sql`${schema.handPlayers.hole} is not null`, eq(schema.hands.purged, false)))
        .orderBy(asc(schema.handPlayers.handScore), desc(schema.hands.pot))
        .limit(1);
      if (top) {
        const show = await this.handShow(top.handId, 'best', top.userId);
        if (show) bestHand = { ...show, userId: top.userId, nickname: top.nick };
      }
    }
    const hunterTop = [...players].filter((p) => p.knockouts > 0).sort((a, b) => b.knockouts - a.knockouts)[0];

    return {
      computedAt: now,
      from,
      to,
      games: await Promise.all(games.map(async (g) => ({ kind: g.kind as GameKind, ref: g.ref, name: (await this.gameName(g.kind as GameKind, g.ref)) ?? g.ref, results: results.get(g.ref) ?? {} }))),
      players,
      lines: [...lineMap.values()].sort((a, b) => (names[a.userId] ?? '').localeCompare(names[b.userId] ?? '') || a.game.localeCompare(b.game) || a.kind.localeCompare(b.kind)),
      transfers,
      names,
      house: -total,
      mvp: players[0] && players[0].score > 0 ? { userId: players[0].userId, nickname: players[0].nickname, score: players[0].score } : null,
      awards: { hunter: hunterTop ? { userId: hunterTop.userId, nickname: hunterTop.nickname, count: hunterTop.knockouts } : null, banker, badBeat },
      stats: { games: games.length, players: players.length, turnover, biggestPotBb },
      bestHand,
    };
  }

  /** Souhrn: u uzavřeného večera uložený, u otevřeného aktuálně spočítaný. Vidí ho účastník, správce, nebo kdokoli u uzavřeného. */
  async view(id: string, viewerId: string) {
    const ev = await this.load(id);
    const manager = this.deps.perms.can(viewerId, 'vecer.spravovat').allowed;
    const summary = ev.status === 'closed' && ev.summary ? (ev.summary as EveningSummary) : await this.compute(ev);
    const participant = summary.players.some((p) => p.userId === viewerId);
    if (!manager && !participant && ev.status === 'open') throw new EveningError('FORBIDDEN');
    return {
      id: ev.id,
      name: ev.name,
      status: ev.status as 'open' | 'closed',
      startsAt: ev.startsAt.getTime(),
      endsAt: ev.endsAt?.getTime() ?? null,
      auto: ev.auto,
      canManage: manager,
      summary,
    };
  }

  async list(viewerId: string) {
    const rows = await this.deps.db.select().from(schema.evenings).orderBy(desc(schema.evenings.startsAt)).limit(100);
    const manager = this.deps.perms.can(viewerId, 'vecer.spravovat').allowed;
    return {
      canManage: manager,
      evenings: rows.map((r) => {
        const s = r.summary as EveningSummary | null;
        return { id: r.id, name: r.name, status: r.status as 'open' | 'closed', startsAt: r.startsAt.getTime(), endsAt: r.endsAt?.getTime() ?? null, games: s?.stats.games ?? null, players: s?.stats.players ?? null, mvp: s?.mvp?.nickname ?? null };
      }),
    };
  }

  /** Hry, které jde do večera přidat: turnaje, živý cash a cash stoly, které nejsou v jiném večeru. */
  async candidates(actorId: string, id: string) {
    this.manage(actorId);
    await this.load(id);
    const db = this.deps.db;
    const taken = new Set((await db.select().from(schema.eveningGames)).filter((g) => g.eveningId !== id && g.kind !== 'cash').map((g) => `${g.kind}:${g.ref}`));
    const mine = new Set((await this.games(id)).map((g) => `${g.kind}:${g.ref}`));
    const tours = await db.select({ id: schema.tournaments.id, name: schema.tournaments.name }).from(schema.tournaments).orderBy(desc(schema.tournaments.createdAt)).limit(30);
    const lives = await db.select({ id: schema.liveCashGames.id, name: schema.liveCashGames.name }).from(schema.liveCashGames).orderBy(desc(schema.liveCashGames.createdAt)).limit(30);
    const tables = await db.select({ id: schema.gameTables.id, name: schema.gameTables.name }).from(schema.gameTables).limit(50);
    const pick = (kind: GameKind, list: { id: string; name: string }[]) => list.filter((g) => !taken.has(`${kind}:${g.id}`) && !mine.has(`${kind}:${g.id}`)).map((g) => ({ kind, ref: g.id, name: g.name }));
    return { games: [...pick('tournament', tours), ...pick('live_cash', lives), ...pick('cash', tables)] };
  }

  // ---------- uzavření ----------

  private summaryText(ev: Row, s: EveningSummary): string {
    const lines = [t('evening.chat.head', { name: ev.name, games: s.stats.games, players: s.stats.players })];
    if (s.mvp) lines.push(t('evening.chat.mvp', { nick: s.mvp.nickname, score: s.mvp.score }));
    if (s.awards.hunter) lines.push(t('evening.chat.hunter', { nick: s.awards.hunter.nickname, count: s.awards.hunter.count }));
    if (s.awards.banker) lines.push(t('evening.chat.banker', { nick: s.awards.banker.nickname, bb: s.awards.banker.bb }));
    if (s.awards.badBeat) lines.push(t('evening.chat.badBeat', { nick: s.awards.badBeat.nickname, equity: s.awards.badBeat.equity }));
    lines.push(t('evening.chat.transfers', { n: s.transfers.length, link: `${String(this.s()['system.publicUrl'] ?? '').replace(/\/$/, '')}/vecery/${ev.id}` }));
    return lines.join('\n');
  }

  /** Uzavření večera: souhrn se uloží, pošle do chatu a (volitelně) e-mailem hráčům. `actorId` null = automatika. */
  async close(actorId: string | null, id: string, meta: Meta = {}): Promise<void> {
    if (actorId) this.manage(actorId);
    const ev = await this.load(id);
    if (ev.status !== 'open') throw new EveningError('CLOSED');
    const closed = { ...ev, status: 'closed', endsAt: new Date(this.deps.now()) } as Row;
    const summary = await this.compute(closed);
    await this.deps.db.update(schema.evenings).set({ status: 'closed', endsAt: closed.endsAt, summary }).where(eq(schema.evenings.id, id));
    await this.deps.audit.log({ actorId: actorId ?? undefined, action: 'vecer.uzavrit', targetType: 'evening', targetId: id, after: { auto: actorId === null, games: summary.stats.games }, ...meta });
    await this.refreshOpen();
    this.deps.onChanged?.(id);
    this.deps.onClosed?.({ id, name: ev.name, games: summary.stats.games, players: summary.stats.players, mvp: summary.mvp?.nickname ?? '' });
    const s = this.s();
    if (s['evening.chatSummary'] && summary.stats.games > 0) await this.deps.postChat(this.summaryText(closed, summary)).catch(() => undefined);
    if (s['evening.emailEnabled'] && summary.stats.players > 0) {
      const text = this.summaryText(closed, summary);
      for (const p of summary.players) await this.deps.mail(p.userId, 'vecer_souhrn', { nazev: ev.name, souhrn: text, odkaz: `${String(s['system.publicUrl'] ?? '').replace(/\/$/, '')}/vecery/${id}` }).catch(() => undefined);
    }
  }

  /**
   * Znovu otevře uzavřený večer (např. uzavřený omylem): vrátí ho do stavu otevřený a smaže uložený souhrn, který se spočítá znovu
   * při dalším uzavření. Jen když není otevřený jiný večer. Co po uzavření už odešlo (chat, e-maily, hlasování o handě), se nevrací.
   */
  async reopen(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    this.enabled();
    const ev = await this.load(id);
    if (ev.status !== 'closed') throw new EveningError('INVALID', { field: 'status' });
    const [other] = await this.deps.db.select({ id: schema.evenings.id }).from(schema.evenings).where(eq(schema.evenings.status, 'open')).limit(1);
    if (other) throw new EveningError('OPEN_EXISTS', { id: other.id });
    await this.deps.db.update(schema.evenings).set({ status: 'open', endsAt: null, summary: null, touchedAt: new Date(this.deps.now()) }).where(eq(schema.evenings.id, id));
    await this.deps.audit.log({ actorId, action: 'vecer.znovu_otevrit', targetType: 'evening', targetId: id, ...meta });
    await this.refreshOpen();
    this.deps.onChanged?.(id);
  }

  /** Přepočítá uložený souhrn uzavřeného večera (např. po opravě zápisu živé hry). */
  async recompute(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    const ev = await this.load(id);
    if (ev.status !== 'closed') throw new EveningError('INVALID', { field: 'status' });
    const summary = await this.compute(ev);
    await this.deps.db.update(schema.evenings).set({ summary }).where(eq(schema.evenings.id, id));
    await this.deps.audit.log({ actorId, action: 'vecer.prepocitat', targetType: 'evening', targetId: id, ...meta });
    this.deps.onChanged?.(id);
  }

  async remove(actorId: string, id: string, meta: Meta = {}): Promise<void> {
    this.manage(actorId);
    await this.load(id);
    await this.deps.db.delete(schema.evenings).where(eq(schema.evenings.id, id));
    await this.deps.audit.log({ actorId, action: 'vecer.smazat', targetType: 'evening', targetId: id, ...meta });
  }

  /** Automatické uzavření večerů, kde už delší dobu nic neběží (volá plánovač). */
  async closeStale(): Promise<number> {
    const s = this.s();
    if (!s['evening.enabled'] || !s['evening.autoClose']) return 0;
    const cutoff = new Date(this.deps.now() - Number(s['evening.gapHours']) * 3600_000);
    const stale = await this.deps.db.select().from(schema.evenings).where(and(eq(schema.evenings.status, 'open'), lte(schema.evenings.touchedAt, cutoff), eq(schema.evenings.auto, true)));
    let n = 0;
    for (const ev of stale) {
      const games = await this.games(ev.id);
      const tourIds = games.filter((g) => g.kind === 'tournament').map((g) => g.ref);
      const liveIds = games.filter((g) => g.kind === 'live_cash').map((g) => g.ref);
      const runningT = tourIds.length ? await this.deps.db.select({ id: schema.tournaments.id }).from(schema.tournaments).where(and(inArray(schema.tournaments.id, tourIds), inArray(schema.tournaments.status, ['registering', 'running']))) : [];
      const runningL = liveIds.length ? await this.deps.db.select({ id: schema.liveCashGames.id }).from(schema.liveCashGames).where(and(inArray(schema.liveCashGames.id, liveIds), eq(schema.liveCashGames.status, 'open'))) : [];
      if (runningT.length || runningL.length) continue;
      await this.close(null, ev.id);
      n++;
    }
    return n;
  }

  /** Pořadí pro televizi: večer, který právě běží (nebo naposledy skončil v posledních hodinách). */
  async tvBoard() {
    const [ev] = await this.deps.db.select().from(schema.evenings).where(isNull(schema.evenings.endsAt)).orderBy(desc(schema.evenings.touchedAt)).limit(1);
    const row =
      ev ??
      (
        await this.deps.db
          .select()
          .from(schema.evenings)
          .where(gte(schema.evenings.endsAt, new Date(this.deps.now() - 6 * 3600_000)))
          .orderBy(desc(schema.evenings.endsAt))
          .limit(1)
      )[0];
    if (!row) return null;
    const s = row.status === 'closed' && row.summary ? (row.summary as EveningSummary) : await this.compute(row);
    if (s.players.length === 0) return null;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      mvp: s.mvp?.nickname ?? null,
      players: s.players.slice(0, 10).map((p, i) => ({ rank: i + 1, nickname: p.nickname, net: p.net, score: p.score })),
      awards: { hunter: s.awards.hunter ? { nickname: s.awards.hunter.nickname, count: s.awards.hunter.count } : null, banker: s.awards.banker ? { nickname: s.awards.banker.nickname, bb: s.awards.banker.bb } : null, badBeat: s.awards.badBeat ? { nickname: s.awards.badBeat.nickname, equity: s.awards.badBeat.equity } : null },
    };
  }

  // ---------- handy pro zobrazení kartami ----------

  /**
   * Handa pro grafické zobrazení: společné karty a hráči, kteří ukázali karty. Smolař (`loser`): on a vítězové handy; nejlepší kombinace (`best`): držitel.
   * U handy, jejíž podrobnosti už byly smazány, nebo bez ukázaných karet se vrací `null`.
   */
  private async handShow(handId: string, focus: 'loser' | 'best', focusUserId: string): Promise<HandShow | null> {
    const db = this.deps.db;
    const [h] = await db.select({ board: schema.hands.board, purged: schema.hands.purged, tableId: schema.hands.tableId, tournamentId: schema.hands.tournamentId }).from(schema.hands).where(eq(schema.hands.id, handId));
    if (!h || h.purged) return null;
    const ps = await db
      .select({ userId: schema.handPlayers.userId, hole: schema.handPlayers.hole, won: schema.handPlayers.won, revealed: schema.handPlayers.revealed, nick: schema.users.nickname })
      .from(schema.handPlayers)
      .innerJoin(schema.users, eq(schema.users.id, schema.handPlayers.userId))
      .where(eq(schema.handPlayers.handId, handId));
    const board = h.board ?? [];
    const players: HandShowPlayer[] = [];
    for (const p of ps) {
      const role: HandShowPlayer['role'] | null = p.userId === focusUserId ? focus : focus === 'loser' && p.won > 0 ? 'winner' : null;
      if (!role || !p.hole || !p.revealed) continue;
      const five = board.length === 5 ? bestFive(p.hole as [Card, Card], board as Card[]).cards : null;
      const desc = five ? describeHand(five) : null;
      players.push({ userId: p.userId, nickname: p.nick, hole: p.hole, won: p.won, role, five: five ? (desc?.cards ?? five) : null, desc: desc ? { key: desc.key, params: desc.params } : null });
    }
    if (!players.some((p) => p.role === focus)) return null;
    return { handId, game: (await this.gameName(h.tournamentId ? 'tournament' : 'cash', h.tournamentId ?? h.tableId)) ?? h.tableId, board, players };
  }

  /** CSV souhrnu (hráči a převody) pro tabulky. */
  async csv(viewerId: string, id: string): Promise<string> {
    const v = await this.view(id, viewerId);
    const esc = (x: string | number) => `"${String(x).replace(/"/g, '""')}"`;
    // Stejné sloupce a pořadí jako tabulka na stránce večera: složky (cash, buy-in, rebuy, add-on, výhra, bounty, hlavy, sázky…), vyřazení, profit.
    const parts = EVENING_PARTS.filter((k) => v.summary.players.some((p) => (p.parts?.[k] ?? 0) !== 0));
    const players = [...v.summary.players].sort((a, b) => b.net - a.net || a.nickname.localeCompare(b.nickname, 'cs'));
    const rows = [[t('evening.csv.player'), ...parts.map((k) => t(`settlement.part.${k}`)), t('evening.csv.knockoutsCol'), t('evening.csv.net')].map(esc).join(';')];
    for (const p of players) rows.push([p.nickname, ...parts.map((k) => p.parts?.[k] ?? 0), p.knockouts, p.net].map(esc).join(';'));
    rows.push('');
    rows.push([t('evening.csv.from'), t('evening.csv.to'), t('evening.csv.amount')].map(esc).join(';'));
    for (const tr of v.summary.transfers) rows.push([v.summary.names[tr.from] ?? tr.from, v.summary.names[tr.to] ?? tr.to, tr.amount].map(esc).join(';'));
    // Rozpis všech pohybů: hráč, hra, druh pohybu, počet a částka (záporná = hráč zaplatil).
    const gameName = new Map(v.summary.games.map((g) => [g.ref, g.name]));
    rows.push('');
    rows.push([t('evening.csv.player'), t('evening.csv.game'), t('evening.csv.kind'), t('evening.csv.count'), t('evening.csv.amount')].map(esc).join(';'));
    for (const l of v.summary.lines ?? []) rows.push([v.summary.names[l.userId] ?? l.userId, gameName.get(l.game) ?? l.game, t(l.kind === 'seated' ? 'evening.kind.seated' : `ledger.kind.${l.kind}`), l.count, l.amount].map(esc).join(';'));
    return `﻿${rows.join('\r\n')}\r\n`;
  }
}
