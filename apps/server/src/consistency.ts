import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { accounts, type Ledger } from '@kb/ledger';
import type { PermissionChecker } from '@kb/shared';
import { schema, type Db } from './db/index.js';
import { SIDE_SET } from './side-results.js';
import type { WalletService } from './wallet/service.js';

export class ConsistencyError extends Error {
  constructor(public readonly code: 'FORBIDDEN') {
    super(code);
  }
}

export interface ConsistencyCheck {
  id: string;
  ok: boolean;
  /** Počet nalezených problémů (0 = v pořádku). */
  problems: number;
  /** Prvních několik nalezených problémů (text pro člověka). */
  items: string[];
}

export interface ConsistencyReport {
  at: number;
  ok: boolean;
  checks: ConsistencyCheck[];
}

interface Deps {
  db: Db;
  ledger: Ledger;
  perms: PermissionChecker;
  wallet: WalletService;
  flush: () => Promise<void>;
  now: () => number;
  /** Nastavení: o kolik smí peněženka klesnout pod nulu. */
  settings: () => Record<string, unknown>;
  /** Zapíše výsledky skončeného turnaje do statistik (pro doplnění chybějících). */
  recordResults?: (tournamentId: string) => Promise<void>;
}

const MAX_ITEMS = 10;

/**
 * Kontrola konzistence dat: ověří invarianty účetní knihy (součty, zůstatky, uzavřené hry) a shodu statistik s knihou.
 * Nic nemění, jen čte; slouží správci a při ladění. Každá kontrola vrací počet problémů a prvních několik příkladů.
 */
export class ConsistencyService {
  constructor(private deps: Deps) {}

  /** Skončené turnaje s výsledky, které nemají řádky ve statistikách (např. po pádu serveru nebo údržbě). */
  async missingResults(): Promise<string[]> {
    const db = this.deps.db;
    const have = new Set((await db.selectDistinct({ ref: schema.gameResults.ref }).from(schema.gameResults).where(eq(schema.gameResults.kind, 'tournament'))).map((r) => r.ref));
    const finished = await db.select({ id: schema.tournaments.id, state: schema.tournaments.state }).from(schema.tournaments).where(eq(schema.tournaments.status, 'finished'));
    return finished.filter((t) => ((t.state as { results?: unknown[] } | null)?.results?.length ?? 0) > 0 && !have.has(t.id)).map((t) => t.id);
  }

  /** Doplní výsledky skončených turnajů do statistik (peníze se nemění; XP a rating přepočítá Údržba). Vrací počet doplněných turnajů. */
  async repairResults(actorId: string): Promise<number> {
    if (!this.deps.perms.can(actorId, 'mena.upravit_knihu').allowed || !this.deps.recordResults) throw new ConsistencyError('FORBIDDEN');
    const ids = await this.missingResults();
    for (const id of ids) await this.deps.recordResults(id);
    return ids.length;
  }

  async run(actorId: string): Promise<ConsistencyReport> {
    if (!this.deps.perms.can(actorId, 'mena.zobrazit_knihu').allowed) throw new ConsistencyError('FORBIDDEN');
    await this.deps.flush();
    const checks: ConsistencyCheck[] = [];
    const add = (id: string, items: string[]) => checks.push({ id, ok: items.length === 0, problems: items.length, items: items.slice(0, MAX_ITEMS) });
    const db = this.deps.db;
    const le = schema.ledgerEntries;
    const lt_ = schema.ledgerTransactions;

    // 1) každá transakce má součet 0 a aspoň dva záznamy
    const unbalanced = await db.select({ id: le.transactionId, sum: sql<number>`sum(${le.amount})::int`, n: sql<number>`count(*)::int` }).from(le).groupBy(le.transactionId).having(sql`sum(${le.amount}) <> 0 or count(*) < 2`);
    add('txBalanced', unbalanced.map((x) => `pohyb ${x.id}: součet ${x.sum}, záznamů ${x.n}`));

    // 2) součet všech účtů je 0 a zůstatky v paměti odpovídají databázi
    const acc = await db.select().from(schema.ledgerAccounts);
    const total = acc.reduce((n, a) => n + Number(a.balance), 0);
    add('totalZero', total === 0 ? [] : [`součet všech účtů je ${total}, má být 0`]);
    const drift = acc.filter((a) => this.deps.ledger.balance(a.id) !== Number(a.balance)).map((a) => `účet ${a.id}: v paměti ${this.deps.ledger.balance(a.id)}, v databázi ${a.balance}`);
    add('memoryMatchesDb', drift);

    // 3) zůstatky z pohybů se shodují s uloženými zůstatky účtů
    const replay = await db.select({ account: le.account, sum: sql<number>`sum(${le.amount})::int` }).from(le).groupBy(le.account);
    const stored = new Map(acc.map((a) => [a.id, Number(a.balance)]));
    const replayBad = replay.filter((r) => (stored.get(r.account) ?? 0) !== Number(r.sum)).map((r) => `účet ${r.account}: z pohybů ${r.sum}, uložený zůstatek ${stored.get(r.account) ?? 0}`);
    add('balancesFromMoves', replayBad);

    // 4) záporné zůstatky: jen mint smí být záporný (peněženky do limitu povoleného nastavením)
    const floor = Number(this.deps.settings()['economy.negativeBalanceLimit'] ?? 0);
    const negative = acc.filter((a) => a.id !== accounts.mint() && Number(a.balance) < (a.id.startsWith('wallet:') ? -floor : 0)).map((a) => `účet ${a.id}: ${a.balance}`);
    add('noNegativeAccounts', negative);

    // 5) uzavřené hry nemají nic v poolu, bounty a úschově
    const tours = await db.select({ id: schema.tournaments.id, status: schema.tournaments.status }).from(schema.tournaments).where(inArray(schema.tournaments.status, ['finished', 'cancelled']));
    const leaks: string[] = [];
    for (const t of tours) {
      for (const a of [accounts.tournament(t.id), accounts.bounty(t.id)]) if (this.deps.ledger.balance(a) !== 0) leaks.push(`turnaj ${t.id} (${t.status}): účet ${a} má ${this.deps.ledger.balance(a)}`);
    }
    const settledBounties = await db.select({ id: schema.headBounties.id }).from(schema.headBounties).where(inArray(schema.headBounties.status, ['paid', 'returned', 'forfeited', 'cancelled']));
    for (const b of settledBounties) if (this.deps.ledger.balance(accounts.escrow(`hb:${b.id}`)) !== 0) leaks.push(`odměna na hlavu ${b.id}: úschova není prázdná`);
    const settledBets = await db.select({ id: schema.bets.id }).from(schema.bets).where(inArray(schema.bets.status, ['settled', 'void']));
    for (const b of settledBets) if (this.deps.ledger.balance(accounts.escrow(`bet:${b.id}`)) !== 0) leaks.push(`sázka ${b.id}: úschova není prázdná`);
    add('closedGamesEmpty', leaks);

    // 6) kontokorent: dluh v paměti odpovídá čerpání a splátkám v knize
    const debtRows = await db
      .select({ account: le.account, sum: sql<number>`sum(${le.amount})::int` })
      .from(le)
      .innerJoin(lt_, eq(lt_.id, le.transactionId))
      .where(and(like(le.account, 'wallet:%'), inArray(lt_.kind, ['credit_draw', 'credit_repay'])))
      .groupBy(le.account);
    const debtBad = debtRows.filter((r) => this.deps.wallet.creditDebt(r.account.slice('wallet:'.length)) !== Math.max(0, Number(r.sum))).map((r) => `hráč ${r.account.slice(7)}: v knize ${r.sum}, v paměti ${this.deps.wallet.creditDebt(r.account.slice(7))}`);
    add('creditDebt', debtBad);

    // 7) výsledky turnajů ve statistikách (game_results) odpovídají knize (bez sázek a hlav, ty se berou z knihy)
    const gr = schema.gameResults;
    const results = await db.select({ ref: gr.ref, userId: gr.userId, net: sql<number>`(${gr.payout} + ${gr.bounty} - ${gr.spent})::int` }).from(gr).where(eq(gr.kind, 'tournament'));
    const refs = [...new Set(results.map((r) => r.ref))];
    const ledgerNet = new Map<string, number>();
    if (refs.length) {
      const rows = await db
        .select({ account: le.account, game: lt_.gameId, kind: lt_.kind, sum: sql<number>`sum(${le.amount})::int` })
        .from(le)
        .innerJoin(lt_, eq(lt_.id, le.transactionId))
        .where(and(like(le.account, 'wallet:%'), inArray(lt_.gameId, refs)))
        .groupBy(le.account, lt_.gameId, lt_.kind);
      for (const r of rows) {
        if (!(r.kind.startsWith('turnaj_') || r.kind === 'bounty') || SIDE_SET.has(r.kind)) continue;
        const key = `${r.account.slice(7)}|${r.game}`;
        ledgerNet.set(key, (ledgerNet.get(key) ?? 0) + Number(r.sum));
      }
    }
    const resultBad = results.filter((r) => (ledgerNet.get(`${r.userId}|${r.ref}`) ?? 0) !== Number(r.net)).map((r) => `turnaj ${r.ref}, hráč ${r.userId}: statistiky ${r.net}, kniha ${ledgerNet.get(`${r.userId}|${r.ref}`) ?? 0}`);
    add('resultsMatchLedger', resultBad);

    // 8) skončený turnaj s výsledky má řádky ve statistikách
    add('resultsRecorded', (await this.missingResults()).map((id) => `turnaj ${id} je skončený, ale nemá výsledky ve statistikách`));

    // 9) otevřené sázky: držené vklady v evidenci odpovídají úschově v knize (evidence se zapisuje mimo dávku knihy)
    const openBets = await db.select({ id: schema.bets.id }).from(schema.bets).where(inArray(schema.bets.status, ['open', 'locked', 'proposed', 'disputed']));
    const openBad: string[] = [];
    if (openBets.length) {
      const held = await db
        .select({ betId: schema.betStakes.betId, sum: sql<number>`sum(${schema.betStakes.amount})::int` })
        .from(schema.betStakes)
        .where(inArray(schema.betStakes.betId, openBets.map((b) => b.id)))
        .groupBy(schema.betStakes.betId);
      const heldMap = new Map(held.map((h) => [h.betId, Number(h.sum)]));
      for (const b of openBets) {
        const inLedger = this.deps.ledger.balance(accounts.escrow(`bet:${b.id}`));
        if ((heldMap.get(b.id) ?? 0) !== inLedger) openBad.push(`sázka ${b.id}: vklady v evidenci ${heldMap.get(b.id) ?? 0}, úschova v knize ${inLedger}`);
      }
    }
    add('openBetsEscrow', openBad);

    // 10) výdaje domu odkazují na existující pohyb knihy
    const expenses = await db.select({ id: schema.houseExpenses.id, txId: schema.houseExpenses.txId }).from(schema.houseExpenses).where(sql`${schema.houseExpenses.txId} is not null`);
    const txIds = [...new Set(expenses.map((e) => Number(e.txId)))];
    const known = new Set(txIds.length ? (await db.select({ id: lt_.id }).from(lt_).where(inArray(lt_.id, txIds))).map((r) => Number(r.id)) : []);
    add('houseExpensesLinked', expenses.filter((e) => !known.has(Number(e.txId))).map((e) => `výdaj ${e.id}: pohyb ${e.txId} v knize neexistuje`));

    // 11) žádosti hráčů uprostřed vyřizování (pád serveru mezi dobitím a zápisem stavu)
    const stuck = await db.select({ id: schema.userRequests.id, decidedAt: schema.userRequests.decidedAt }).from(schema.userRequests).where(eq(schema.userRequests.status, 'deciding'));
    add('requestsNotStuck', stuck.map((r) => `žádost ${r.id} zůstala ve stavu „vyřizuje se“ od ${r.decidedAt?.toISOString() ?? '?'}; zkontroluj v knize pohyb s klíčem request:${r.id} a žádost ručně uzavři`));

    return { at: this.deps.now(), ok: checks.every((c) => c.ok), checks };
  }
}
