import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { minimalTransfers, type Transfer } from '@kb/ledger';
import { formatLocal, t, type PermissionChecker, type SettingValues } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';

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
  knockouts: number;
  placePoints: number;
  xp: number;
  score: number;
}

export interface EveningSummary {
  computedAt: number;
  from: number;
  to: number;
  games: { kind: GameKind; ref: string; name: string; results: Record<string, number> }[];
  players: EveningPlayer[];
  transfers: Transfer[];
  names: Record<string, string>;
  /** Co dohromady vyhráli hráči proti herně (rake, poplatky, odvody); kladné číslo patří domu. */
  house: number;
  mvp: { userId: string; nickname: string; score: number } | null;
  awards: {
    hunter: { userId: string; nickname: string; count: number } | null;
    banker: { userId: string; nickname: string; handId: string; game: string; bb: number; amount: number; unit: 'currency' | 'chips' } | null;
    badBeat: { userId: string; nickname: string; handId: string; game: string; equity: number } | null;
  };
  stats: { games: number; players: number; turnover: number; biggestPotBb: number | null };
  /** Handa večera podle hlasování hráčů. */
  handOfEvening: HandOfEvening | null;
}

/** Kandidát na handu večera (jedna možnost ankety). */
export interface HandCandidate {
  kind: 'bigPot' | 'badBeat' | 'bluff' | 'longshot';
  handId: string;
  userId: string;
  nickname: string;
  game: string;
  /** Velký pot v BB, nebo šance na výhru v procentech. */
  value: number;
  label: string;
}

export interface HandOfEvening extends HandCandidate {
  sharedId: string | null;
  votes: number;
}

export interface HandVote {
  pollId: string;
  candidates: HandCandidate[];
  result?: HandOfEvening | null;
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
  /** Anketa o handě večera: vrací id ankety (možnosti mají id o1, o2… v pořadí kandidátů). */
  createHandPoll?: (title: string, labels: string[], voterIds: string[], hours: number) => Promise<string>;
  /** Stav a výsledek ankety. */
  pollResult?: (pollId: string) => Promise<{ open: boolean; winners: string[]; votes: number } | null>;
  /** Sdílí handu jménem systému a vrací id sdílení (karta v chatu). */
  shareHand?: (handId: string) => Promise<string>;
  /** Nepovinný e-mail hráči (respektuje jeho předvolbu). */
  mail: (userId: string, template: string, vars: Record<string, string | number>) => Promise<void>;
  onChanged?: (id: string) => void;
  /** Večer byl uzavřen (napojení ven). */
  onClosed?: (info: { id: string; name: string; games: number; players: number; mvp: string }) => void;
}

type Meta = { ip?: string | null };
const WALLET_KINDS = ['cash_buyin', 'cash_topup', 'cash_cashout', 'cash_return', 'bounty', 'jackpot_payout', 'time_charge'];
const BUYIN_KINDS = new Set(['cash_buyin', 'cash_topup', 'turnaj_buyin', 'turnaj_rebuy', 'turnaj_addon']);
const CASH_SEEN_MS = 60_000;

type Row = typeof schema.evenings.$inferSelect;

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
    let turnover = 0;
    for (const e of entries) {
      const tx = byTx.get(e.transactionId)!;
      const uid = e.account.slice('wallet:'.length);
      const gid = tx.gameId ?? '';
      const r = results.get(gid) ?? {};
      r[uid] = (r[uid] ?? 0) + e.amount;
      results.set(gid, r);
      const isTour = tx.kind.startsWith('turnaj_') || tx.kind === 'bounty';
      (isTour ? tour : cash)[uid] = ((isTour ? tour : cash)[uid] ?? 0) + e.amount;
      if (BUYIN_KINDS.has(tx.kind) && e.amount < 0) turnover += -e.amount;
    }
    if (open) {
      const rate = Number(this.s()['cash.chipsPerCurrencyUnit']) || 1;
      for (const seat of this.deps.seated()) {
        if (!cashSet.has(seat.tableId)) continue;
        const value = Math.floor(seat.chips / rate);
        cash[seat.userId] = (cash[seat.userId] ?? 0) + value;
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

    const userIds = [...new Set([...Object.keys(cash), ...Object.keys(tour), ...gr.map((r) => r.userId), ...Object.keys(knockouts)])];
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
      const net = (cash[userId] ?? 0) + (tour[userId] ?? 0);
      const pp = Math.round((placePoints[userId] ?? 0) * 100) / 100;
      const score = Math.round(((net * w.net) / 100 + pp * w.place + (knockouts[userId] ?? 0) * w.ko + ((xp[userId] ?? 0) * w.xp) / 100) * 10) / 10;
      return { userId, nickname: names[userId] ?? '?', net, cash: cash[userId] ?? 0, tournament: tour[userId] ?? 0, knockouts: knockouts[userId] ?? 0, placePoints: pp, xp: xp[userId] ?? 0, score };
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
      if (bb?.equity != null) badBeat = { userId: bb.userId, nickname: bb.nick, handId: bb.handId, game: await nameOfGame(bb.tableId, bb.tournamentId), equity: Math.round(bb.equity * 1000) / 10 };
    }
    const hunterTop = [...players].filter((p) => p.knockouts > 0).sort((a, b) => b.knockouts - a.knockouts)[0];

    return {
      computedAt: now,
      from,
      to,
      games: await Promise.all(games.map(async (g) => ({ kind: g.kind as GameKind, ref: g.ref, name: (await this.gameName(g.kind as GameKind, g.ref)) ?? g.ref, results: results.get(g.ref) ?? {} }))),
      players,
      transfers,
      names,
      house: -total,
      mvp: players[0] && players[0].score > 0 ? { userId: players[0].userId, nickname: players[0].nickname, score: players[0].score } : null,
      awards: { hunter: hunterTop ? { userId: hunterTop.userId, nickname: hunterTop.nickname, count: hunterTop.knockouts } : null, banker, badBeat },
      stats: { games: games.length, players: players.length, turnover, biggestPotBb },
      handOfEvening: ((ev.handVote as HandVote | null)?.result ?? null) as HandOfEvening | null,
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
      handVote: ev.handVote ? { pollId: (ev.handVote as HandVote).pollId, candidates: (ev.handVote as HandVote).candidates.map((c) => ({ kind: c.kind, label: c.label, handId: c.handId, nickname: c.nickname, game: c.game })), decided: (ev.handVote as HandVote).result !== undefined } : null,
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
    if (s['evening.handVoteAuto']) await this.startHandVote(null, id).catch(() => undefined);
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

  // ---------- handa večera ----------

  /** Kandidáti na handu večera z uložených hand: největší pot, nejhorší bad beat, ukázaný bluff, nejnepravděpodobnější výhra. */
  async handCandidates(ev: Row): Promise<HandCandidate[]> {
    const db = this.deps.db;
    const from = ev.startsAt.getTime();
    const to = ev.endsAt?.getTime() ?? this.deps.now();
    const games = await this.games(ev.id);
    const tourIds = games.filter((g) => g.kind === 'tournament').map((g) => g.ref);
    const cashIds = games.filter((g) => g.kind === 'cash').map((g) => g.ref);
    if (!tourIds.length && !cashIds.length) return [];
    const filter = or(
      tourIds.length ? inArray(schema.hands.tournamentId, tourIds) : undefined,
      cashIds.length ? and(inArray(schema.hands.tableId, cashIds), gte(schema.hands.playedAt, new Date(from)), lte(schema.hands.playedAt, new Date(to))) : undefined,
    );
    const base = () =>
      db
        .select({ handId: schema.hands.id, tableId: schema.hands.tableId, tournamentId: schema.hands.tournamentId, pot: schema.hands.pot, blinds: schema.hands.blinds, userId: schema.handPlayers.userId, equity: schema.handPlayers.allInEquity, nickname: schema.users.nickname })
        .from(schema.handPlayers)
        .innerJoin(schema.hands, eq(schema.hands.id, schema.handPlayers.handId))
        .innerJoin(schema.users, eq(schema.users.id, schema.handPlayers.userId));
    const gameName = async (tableId: string, tournamentId: string | null) => (await this.gameName(tournamentId ? 'tournament' : 'cash', tournamentId ?? tableId)) ?? tableId;
    const bb = (r: { pot: number; blinds: { bb: number } }) => (r.blinds.bb > 0 ? Math.round((r.pot / r.blinds.bb) * 10) / 10 : 0);
    const out: HandCandidate[] = [];
    const used = new Set<string>();
    const add = async (kind: HandCandidate['kind'], r: { handId: string; tableId: string; tournamentId: string | null; userId: string; nickname: string }, value: number) => {
      if (used.has(r.handId)) return;
      used.add(r.handId);
      const label = t(`evening.handVote.${kind}`, { nick: r.nickname, bb: value, equity: value });
      out.push({ kind, handId: r.handId, userId: r.userId, nickname: r.nickname, game: await gameName(r.tableId, r.tournamentId), value, label });
    };
    // největší pot (vítěz handy)
    const winners = await base().where(and(filter, gte(schema.handPlayers.won, 1)));
    const pots = winners.filter((r) => r.blinds.bb > 0).sort((a, b) => b.pot / b.blinds.bb - a.pot / a.blinds.bb);
    if (pots[0]) await add('bigPot', pots[0], bb(pots[0]));
    // nejhorší bad beat: nejvyšší šance na výhru u prohry
    const min = Number(this.s()['evening.badBeatMinPercent']) / 100;
    const [bad] = await base().where(and(filter, eq(schema.handPlayers.won, 0), gte(schema.handPlayers.allInEquity, min))).orderBy(desc(schema.handPlayers.allInEquity)).limit(1);
    if (bad) await add('badBeat', bad, Math.round((bad.equity ?? 0) * 1000) / 10);
    // ukázaný bluff: vítěz bez showdownu, který dobrovolně ukázal karty
    const bluffs = await base().where(and(filter, eq(schema.hands.showdown, false), eq(schema.handPlayers.revealed, true), gte(schema.handPlayers.won, 1)));
    const bluff = bluffs.filter((r) => r.blinds.bb > 0).sort((a, b) => b.pot / b.blinds.bb - a.pot / a.blinds.bb)[0];
    if (bluff) await add('bluff', bluff, bb(bluff));
    // nejnepravděpodobnější výhra: výherce s nejmenší šancí na výhru v all-inu
    const [long] = await base().where(and(filter, gte(schema.handPlayers.won, 1), isNotNull(schema.handPlayers.allInEquity))).orderBy(asc(schema.handPlayers.allInEquity)).limit(1);
    if (long && (long.equity ?? 1) < 0.5) await add('longshot', long, Math.round((long.equity ?? 0) * 1000) / 10);
    return out;
  }

  /** Spustí hlasování o handě večera mezi hráči večera. Vrací false, když není z čeho vybírat. */
  async startHandVote(actorId: string | null, id: string): Promise<boolean> {
    if (actorId) this.manage(actorId);
    const ev = await this.load(id);
    if (ev.handVote || !this.deps.createHandPoll) return false;
    const candidates = await this.handCandidates(ev);
    if (candidates.length < 2) return false;
    const summary = ev.status === 'closed' && ev.summary ? (ev.summary as EveningSummary) : await this.compute(ev);
    const voters = summary.players.map((p) => p.userId);
    if (voters.length < 2) return false;
    const pollId = await this.deps.createHandPoll(t('evening.handVote.title', { name: ev.name }), candidates.map((c) => c.label), voters, Number(this.s()['evening.handVoteHours']));
    const vote: HandVote = { pollId, candidates };
    await this.deps.db.update(schema.evenings).set({ handVote: vote as unknown as Record<string, unknown> }).where(eq(schema.evenings.id, id));
    await this.deps.audit.log({ actorId: actorId ?? undefined, action: 'vecer.hlasovani_handy', targetType: 'evening', targetId: id, after: { pollId, candidates: candidates.length } });
    await this.deps.postChat(t('evening.handVote.chat', { name: ev.name })).catch(() => undefined);
    this.deps.onChanged?.(id);
    return true;
  }

  /** Uzavřená hlasování o handě večera: vybere vítěze, uloží ho do souhrnu a pošle handu do chatu. */
  async finalizeHandVotes(): Promise<number> {
    if (!this.deps.pollResult) return 0;
    const rows = await this.deps.db.select().from(schema.evenings).where(isNotNull(schema.evenings.handVote));
    let n = 0;
    for (const ev of rows) {
      const vote = ev.handVote as HandVote | null;
      if (!vote || vote.result !== undefined) continue;
      const r = await this.deps.pollResult(vote.pollId);
      if (!r || r.open) continue;
      const index = r.winners.length ? Number(r.winners[0]!.replace(/^o/, '')) - 1 : 0;
      const pick = vote.candidates[index] ?? vote.candidates[0] ?? null;
      let result: HandOfEvening | null = null;
      if (pick) {
        const sharedId = this.deps.shareHand ? await this.deps.shareHand(pick.handId).catch(() => null) : null;
        result = { ...pick, sharedId, votes: r.votes };
      }
      const next: HandVote = { ...vote, result };
      const summary = ev.summary ? ({ ...(ev.summary as EveningSummary), handOfEvening: result } as EveningSummary) : null;
      await this.deps.db.update(schema.evenings).set({ handVote: next as unknown as Record<string, unknown>, ...(summary ? { summary } : {}) }).where(eq(schema.evenings.id, ev.id));
      if (result) await this.deps.postChat(t('evening.handVote.winner', { name: ev.name, label: result.label, card: result.sharedId ? `{{ruka:${result.sharedId}}}` : '' })).catch(() => undefined);
      this.deps.onChanged?.(ev.id);
      n++;
    }
    return n;
  }

  /** CSV souhrnu (hráči a převody) pro tabulky. */
  async csv(viewerId: string, id: string): Promise<string> {
    const v = await this.view(id, viewerId);
    const esc = (x: string | number) => `"${String(x).replace(/"/g, '""')}"`;
    const rows = [[t('evening.csv.player'), t('evening.csv.net'), t('evening.csv.cash'), t('evening.csv.tournament'), t('evening.csv.knockouts'), t('evening.csv.xp'), t('evening.csv.score')].map(esc).join(';')];
    for (const p of v.summary.players) rows.push([p.nickname, p.net, p.cash, p.tournament, p.knockouts, p.xp, p.score].map(esc).join(';'));
    rows.push('');
    rows.push([t('evening.csv.from'), t('evening.csv.to'), t('evening.csv.amount')].map(esc).join(';'));
    for (const tr of v.summary.transfers) rows.push([v.summary.names[tr.from] ?? tr.from, v.summary.names[tr.to] ?? tr.to, tr.amount].map(esc).join(';'));
    return `﻿${rows.join('\r\n')}\r\n`;
  }
}
