import { randomUUID } from 'node:crypto';
import { and, eq, getTableName, inArray, is, or, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { accounts as ledgerAccounts, type CashService, type Ledger } from '@kb/ledger';
import type { PermissionChecker, SettingValues } from '@kb/shared';
import type { AuditService, AuditSource } from './auth/audit.js';
import type { ChatImages } from './chat/images.js';
import type { HistoryService } from './history.js';
import { schema, type Db } from './db/index.js';
import type { TableManager } from './tables.js';
import type { TournamentManager } from './tournaments.js';

export class MaintenanceError extends Error {
  constructor(public readonly code: 'FORBIDDEN' | 'INVALID') {
    super(code);
  }
}

interface Deps {
  db: Db;
  ledger: Ledger;
  cash: CashService;
  /** Zápisy do DB čekající ve frontě (musí se zapsat, než se tabulky smažou). */
  flush: () => Promise<void>;
  perms: PermissionChecker;
  audit: AuditService;
  settings: () => SettingValues;
  tables: () => TableManager;
  tournaments: () => TournamentManager;
  /** Služby si drží frontu zápisů; před mazáním se nechá doběhnout. */
  idle: () => Promise<void>;
  history: () => HistoryService;
  chatImages: () => ChatImages;
  /** Hlavní administrátor (smí úplný reset; hlavní administrátory nelze smazat). */
  isMainAdmin: (userId: string) => boolean;
  /** Po smazání účtů znovu načte role a přiřazení v paměti. */
  reloadPerms: () => Promise<void>;
  /** Soubory mimo databázi (zvuky, obrázky motivů), které se při úplném resetu smažou. */
  purgeFiles: () => Promise<void>;
  /** Po úplném resetu se aplikace musí restartovat (v provozu ji znovu spustí Docker). */
  restart: () => void;
}

type Meta = { ip?: string | null; source?: AuditSource; reason?: string | null };

/** Co se má vynulovat (každá oblast zvlášť). */
export interface ResetAreas {
  /** Nejdřív zavřít otevřené stoly a zrušit běžící turnaje (žetony se vrátí do peněženek). */
  games?: boolean;
  xp?: boolean;
  achievements?: boolean;
  rating?: boolean;
  /** Historie hand, výsledky her a vyřazení (statistiky). */
  stats?: boolean;
  /** Peněženky všech hráčů na startovní zůstatek (`economy.startingBalance`). */
  wallets?: boolean;
}

/** Jednorázová příprava na ostrý provoz: každá oblast zvlášť, uživatelé a nastavení zůstávají. */
export interface LaunchOptions {
  /** Zavřít otevřené stoly a zrušit běžící turnaje. */
  games?: boolean;
  /** XP, úspěchy, rating a statistiky (historie hand, výsledky her). */
  progress?: boolean;
  /** Hotové stoly, turnaje, ankety, večery a sdílené handy z historie. */
  history?: boolean;
  /** Veškerá historie chatu (zprávy, reakce, obrázky); kanály a členství zůstávají. */
  chat?: boolean;
  /** Všechna upozornění ve zvonečku. */
  notifications?: boolean;
  /** Uživatelé, kteří se mají smazat (hlavní správce, sedící u stolu a ti v otevřených sázkách se přeskočí). */
  userIds?: string[];
  /** Peněženky všech hráčů na nulu a nový začátek účetní knihy. */
  wallets?: boolean;
}

export interface DeleteUsersResult {
  deleted: string[];
  skipped: { id: string; nickname: string; reason: 'admin' | 'self' | 'seated' | 'tournament' | 'bets' | 'bounty' | 'notFound' }[];
}

export interface MaintenanceCounts {
  users: number;
  chatMessages: number;
  chatImages: number;
  notifications: number;
  historyItems: number;
  /** Hráči, kteří mají v peněžence nenulový zůstatek, a součet zůstatků. */
  walletsNonZero: number;
  walletsTotal: number;
  xpEvents: number;
  players: number;
  achievements: number;
  ratings: number;
  hands: number;
  results: number;
  openTables: number;
  activeTournaments: number;
}

const ACTIVE = new Set(['registering', 'running']);

/**
 * Údržba pro hlavního správce: vynulování postupu (XP), úspěchů, ratingu, statistik a peněženek po testování.
 * Mazání je nevratné; každé spuštění je v audit logu.
 */
export class MaintenanceService {
  constructor(private deps: Deps) {}

  private can(actorId: string): void {
    if (!this.deps.perms.can(actorId, 'nastaveni.globalni').allowed) throw new MaintenanceError('FORBIDDEN');
  }

  private async count(table: PgTable): Promise<number> {
    const [r] = await this.deps.db.select({ n: sql<number>`count(*)::int` }).from(table);
    return Number(r?.n ?? 0);
  }

  async counts(actorId: string): Promise<MaintenanceCounts> {
    this.can(actorId);
    const tournaments = this.deps.tournaments();
    const users = await this.deps.db.select({ id: schema.users.id }).from(schema.users);
    const balances = users.map((u) => this.deps.ledger.balance(ledgerAccounts.wallet(u.id)));
    return {
      users: users.length,
      chatMessages: await this.count(schema.chatMessages),
      chatImages: await this.count(schema.chatImages),
      notifications: await this.count(schema.notifications),
      historyItems: (await this.deps.history().overview(actorId)).items.length,
      walletsNonZero: balances.filter((b) => b !== 0).length,
      walletsTotal: balances.reduce((a, b) => a + b, 0),
      xpEvents: await this.count(schema.xpEvents),
      players: await this.count(schema.playerProgress),
      achievements: await this.count(schema.playerAchievements),
      ratings: await this.count(schema.ratingState),
      hands: await this.count(schema.hands),
      results: await this.count(schema.gameResults),
      openTables: this.deps.tables().list().length,
      activeTournaments: tournaments.list().filter((r) => ACTIVE.has(tournaments.get(r.id)?.state().status ?? '')).length,
    };
  }

  /** Hromadné vynulování vybraných oblastí. Vrací, co se smazalo. */
  async reset(actorId: string, areas: ResetAreas, meta: Meta = {}): Promise<Record<string, number>> {
    this.can(actorId);
    if (!Object.values(areas).some(Boolean)) throw new MaintenanceError('INVALID');
    const done: Record<string, number> = {};
    if (areas.games) {
      const tournaments = this.deps.tournaments();
      let n = 0;
      for (const r of tournaments.list()) {
        if (!ACTIVE.has(tournaments.get(r.id)?.state().status ?? '')) continue;
        await tournaments.cancel(actorId, r.id, meta);
        n++;
      }
      done.tournaments = n;
      const tables = this.deps.tables();
      let m = 0;
      for (const r of tables.list()) {
        await tables.close(r.id);
        m++;
      }
      done.tables = m;
    }
    await this.deps.idle();
    const db = this.deps.db;
    if (areas.xp) {
      done.xpEvents = await this.count(schema.xpEvents);
      await db.delete(schema.xpEvents);
      await db.delete(schema.playerProgress);
    }
    if (areas.achievements) {
      done.achievements = await this.count(schema.playerAchievements);
      await db.delete(schema.playerAchievements);
    }
    if (areas.rating) {
      done.ratings = await this.count(schema.ratingState);
      await db.delete(schema.ratingFlags);
      await db.delete(schema.ratingEvents);
      await db.delete(schema.ratingState);
    }
    if (areas.stats) {
      done.hands = await this.count(schema.hands);
      await db.delete(schema.sharedHands);
      await db.delete(schema.hands);
      await db.delete(schema.gameResults);
      await db.delete(schema.tournamentEliminations);
    }
    if (areas.wallets) {
      done.wallets = await this.resetWallets(actorId);
      if (await this.resetHouse(actorId)) done.house = 1;
    }
    await this.deps.audit.log({ actorId, action: 'udrzba.vynulovani', targetType: 'system', after: { areas, done }, ...meta });
    return done;
  }

  /** Účet domu zpět na nulu (zůstatek jde do účtu mint) a smazání zapsaných výdajů domu; vrací, zda se něco změnilo. */
  private async resetHouse(actorId: string): Promise<boolean> {
    const balance = this.deps.ledger.balance(ledgerAccounts.house());
    const expenses = await this.count(schema.houseExpenses);
    await this.deps.db.delete(schema.houseExpenses);
    if (balance !== 0) this.deps.ledger.post({ kind: 'manual_adjustment', idempotencyKey: `reset-house:${randomUUID()}`, entries: [{ account: ledgerAccounts.house(), amount: -balance }, { account: ledgerAccounts.mint(), amount: balance }], createdBy: actorId, note: 'udrzba.vynulovani' });
    return balance !== 0 || expenses > 0;
  }

  /** Všechny peněženky na startovní zůstatek; rozdíl jde z/do účtu „mint“ (virtuální měna bez hodnoty). */
  private async resetWallets(actorId: string): Promise<number> {
    const target = Number(this.deps.settings()['economy.startingBalance'] ?? 0);
    const users = await this.deps.db.select({ id: schema.users.id }).from(schema.users);
    let n = 0;
    for (const u of users) {
      const wallet = ledgerAccounts.wallet(u.id);
      const delta = target - this.deps.ledger.balance(wallet);
      if (delta === 0) continue;
      this.deps.ledger.post({ kind: 'manual_adjustment', idempotencyKey: `reset:${randomUUID()}`, entries: [{ account: wallet, amount: delta }, { account: ledgerAccounts.mint(), amount: -delta }], createdBy: actorId, note: 'udrzba.vynulovani' });
      n++;
    }
    return n;
  }

  /**
   * Nový start účetní knihy: smaže celou historii transakcí a zůstatků (včetně účtu domu a výdajů domu) a každému hráči připíše počáteční zůstatek
   * jedinou „otevírací“ transakcí (z účtu mint). Jde jen bez otevřených stolů a běžících turnajů (žádné žetony mimo peněženky).
   */
  async resetLedger(actorId: string, meta: Meta = {}, opts: { balance?: number } = {}): Promise<{ transactionsDeleted: number; users: number }> {
    this.can(actorId);
    const tournaments = this.deps.tournaments();
    const active = tournaments.list().filter((r) => ACTIVE.has(tournaments.get(r.id)?.state().status ?? '')).length;
    if (this.deps.tables().list().length > 0 || active > 0) throw new MaintenanceError('INVALID');
    await this.deps.idle();
    await this.deps.flush();
    const db = this.deps.db;
    const transactionsDeleted = await this.count(schema.ledgerTransactions);
    await db.delete(schema.houseExpenses);
    await db.delete(schema.ledgerEntries);
    await db.delete(schema.ledgerTransactions);
    await db.delete(schema.ledgerAccounts);
    this.deps.ledger.reset();
    const target = opts.balance ?? Number(this.deps.settings()['economy.startingBalance'] ?? 0);
    const users = await db.select({ id: schema.users.id }).from(schema.users);
    for (const u of users) if (target > 0) this.deps.cash.mint(u.id, target, `opening:${u.id}:${randomUUID()}`, actorId, 'udrzba.novy_start');
    await this.deps.flush();
    await this.deps.audit.log({ actorId, action: 'udrzba.novy_start_knihy', targetType: 'system', after: { transactionsDeleted, users: users.length, startingBalance: target }, ...meta });
    return { transactionsDeleted, users: users.length };
  }

  /**
   * Jednorázová příprava na ostrý provoz. Pořadí: hry (zavřít a zrušit), postup a statistiky, historie her, chat, upozornění
   * a nakonec peněženky na nulu (nový začátek účetní knihy). Uživatelé, nastavení, šablony, role a napojení se nemění.
   */
  async prepareLaunch(actorId: string, o: LaunchOptions, meta: Meta = {}): Promise<Record<string, number>> {
    this.can(actorId);
    if (!Object.values(o).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)))) throw new MaintenanceError('INVALID');
    const done: Record<string, number> = {};
    if (o.games || o.progress) {
      const r = await this.reset(actorId, { games: !!o.games, xp: !!o.progress, achievements: !!o.progress, rating: !!o.progress, stats: !!o.progress }, meta);
      Object.assign(done, r);
    }
    await this.deps.idle();
    const db = this.deps.db;
    if (o.history) {
      const history = this.deps.history();
      let n = 0;
      for (const item of (await history.overview(actorId)).items) {
        try {
          await history.remove(actorId, item.kind, item.id, meta);
          n++;
        } catch {
          // položka, která se zrovna nedá smazat (např. stůl se otevřel), se přeskočí
        }
      }
      done.historyItems = n;
    }
    if (o.chat) {
      done.chatMessages = await this.count(schema.chatMessages);
      await db.delete(schema.chatMessages);
      done.chatImages = await this.deps.chatImages().purgeAll();
    }
    if (o.notifications) {
      done.notifications = await this.count(schema.notifications);
      await db.delete(schema.notifications);
    }
    if (o.userIds && o.userIds.length > 0) {
      const r = await this.deleteUsers(actorId, o.userIds, meta);
      done.users = r.deleted.length;
      done.usersSkipped = r.skipped.length;
    }
    if (o.wallets) {
      const r = await this.resetLedger(actorId, meta, { balance: 0 });
      done.transactionsDeleted = r.transactionsDeleted;
      done.wallets = r.users;
    }
    await this.deps.audit.log({ actorId, action: 'udrzba.priprava_ostry_provoz', targetType: 'system', after: { options: o, done }, ...meta });
    return done;
  }

  /**
   * Smaže uživatelské účty. Přeskočí hlavní administrátory, sebe, hráče sedící u stolu nebo zapsané v otevřeném turnaji
   * a hráče s otevřenou sázkou nebo odměnou na hlavu (jinak by zůstaly peníze v úschově). Zůstatek peněženky se vrací do
   * „mint“ (virtuální měna bez hodnoty), takže kniha zůstane vyrovnaná. Ostatní data hráče se smažou kaskádou.
   */
  async deleteUsers(actorId: string, userIds: string[], meta: Meta = {}): Promise<DeleteUsersResult> {
    this.can(actorId);
    const result: DeleteUsersResult = { deleted: [], skipped: [] };
    const db = this.deps.db;
    const seated = new Set<string>();
    for (const actor of this.deps.tables().actors.values()) for (const p of actor.playersSeated()) seated.add(p.userId);
    const tournaments = this.deps.tournaments();
    const playing = new Set<string>();
    for (const r of tournaments.list()) {
      const st = tournaments.get(r.id)?.state();
      if (st && ACTIVE.has(st.status)) for (const p of st.players) if (p.status !== 'out') playing.add(p.userId);
    }
    for (const id of [...new Set(userIds)]) {
      const [u] = await db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users).where(eq(schema.users.id, id));
      const skip = (reason: DeleteUsersResult['skipped'][number]['reason']) => void result.skipped.push({ id, nickname: u?.nickname ?? '', reason });
      if (!u) {
        skip('notFound');
        continue;
      }
      if (this.deps.isMainAdmin(id)) {
        skip('admin');
        continue;
      }
      if (id === actorId) {
        skip('self');
        continue;
      }
      if (seated.has(id)) {
        skip('seated');
        continue;
      }
      if (playing.has(id)) {
        skip('tournament');
        continue;
      }
      const held = await db
        .select({ id: schema.betStakes.id })
        .from(schema.betStakes)
        .innerJoin(schema.bets, eq(schema.bets.id, schema.betStakes.betId))
        .where(and(eq(schema.betStakes.userId, id), inArray(schema.bets.status, ['open', 'locked', 'proposed', 'disputed'])));
      if (held.length > 0) {
        skip('bets');
        continue;
      }
      const bounties = await db
        .select({ id: schema.headBounties.id })
        .from(schema.headBounties)
        .where(and(or(eq(schema.headBounties.targetId, id), eq(schema.headBounties.posterId, id)), inArray(schema.headBounties.status, ['open', 'pendingWinner'])));
      if (bounties.length > 0) {
        skip('bounty');
        continue;
      }
      const wallet = ledgerAccounts.wallet(id);
      const balance = this.deps.ledger.balance(wallet);
      if (balance !== 0) this.deps.ledger.post({ kind: 'manual_adjustment', idempotencyKey: `delete-user:${id}:${randomUUID()}`, entries: [{ account: wallet, amount: -balance }, { account: ledgerAccounts.mint(), amount: balance }], createdBy: actorId, note: 'udrzba.smazani_uzivatele' });
      await this.deps.flush();
      await db.delete(schema.users).where(eq(schema.users.id, id));
      await this.deps.audit.log({ actorId, action: 'udrzba.smazat_uzivatele', targetType: 'user', targetId: id, before: { nickname: u.nickname, balance }, ...meta });
      result.deleted.push(id);
    }
    if (result.deleted.length > 0) await this.deps.reloadPerms();
    return result;
  }

  /**
   * Úplný reset jako po instalaci: zavře hry, smaže všechna data ze všech tabulek (včetně uživatelů, nastavení, šablon,
   * rolí a tajných údajů) i nahrané soubory a požádá o restart aplikace. Po restartu se vytvoří hlavní správce podle
   * .env (ADMIN_NICKNAME, ADMIN_PASSWORD) a vestavěné šablony, role a zvuky se založí znovu. Jen hlavní správce.
   */
  async factoryReset(actorId: string, meta: Meta = {}): Promise<{ tables: number }> {
    this.can(actorId);
    if (!this.deps.isMainAdmin(actorId)) throw new MaintenanceError('FORBIDDEN');
    await this.reset(actorId, { games: true }, meta);
    await this.deps.idle();
    await this.deps.flush();
    await this.deps.purgeFiles();
    const names = (Object.values(schema) as unknown[]).filter((t) => is(t as object, PgTable)).map((t) => getTableName(t as PgTable));
    await this.deps.db.execute(sql.raw(`TRUNCATE TABLE ${names.map((n) => `"${n}"`).join(', ')} RESTART IDENTITY CASCADE`));
    this.deps.ledger.reset();
    console.warn('Úplný reset dokončen: data jsou smazána, aplikace se restartuje.');
    this.deps.restart();
    return { tables: names.length };
  }

  /** Vynulování jednoho hráče: XP (a úroveň), úspěchy, rating. */
  async resetUser(actorId: string, userId: string, areas: { xp?: boolean; achievements?: boolean; rating?: boolean }, meta: Meta = {}): Promise<void> {
    this.can(actorId);
    if (!Object.values(areas).some(Boolean)) throw new MaintenanceError('INVALID');
    await this.deps.idle();
    const db = this.deps.db;
    if (areas.xp) {
      await db.delete(schema.xpEvents).where(eq(schema.xpEvents.userId, userId));
      await db.delete(schema.playerProgress).where(eq(schema.playerProgress.userId, userId));
    }
    if (areas.achievements) await db.delete(schema.playerAchievements).where(eq(schema.playerAchievements.userId, userId));
    if (areas.rating) {
      await db.delete(schema.ratingFlags).where(or(eq(schema.ratingFlags.userA, userId), eq(schema.ratingFlags.userB, userId)));
      await db.delete(schema.ratingEvents).where(eq(schema.ratingEvents.userId, userId));
      await db.delete(schema.ratingState).where(eq(schema.ratingState.userId, userId));
    }
    await this.deps.audit.log({ actorId, action: 'udrzba.vynulovani_hrace', targetType: 'user', targetId: userId, after: areas, ...meta });
  }
}
