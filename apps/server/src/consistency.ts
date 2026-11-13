import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { auditPayouts, type TournamentState } from '@kb/game-core';
import { accounts, type Ledger } from '@kb/ledger';
import { computePayouts, percentsFor, type PayoutPreset, type PermissionChecker, type RemainderRule, type SettingValues } from '@kb/shared';
import type { AuditService, AuditSource } from './auth/audit.js';
import { schema, type Db } from './db/index.js';
import { SIDE_SET } from './side-results.js';
import type { WalletService } from './wallet/service.js';

export class ConsistencyError extends Error {
  constructor(
    public readonly code: 'FORBIDDEN' | 'NOTHING_TO_FIX' | 'INSUFFICIENT_FUNDS',
    public readonly params: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

/** Jeden skončený turnaj, u kterého vyplacené výhry nesedí s přepočtem (nebo je nejde ověřit). */
export interface PayoutProblem {
  id: string;
  name: string;
  finishedAt: number | null;
  /**
   * `fixable`: rozdíl způsobilo chybné dělení výplat a jde opravit převodem mezi hráči.
   * `mismatch`: výplaty se liší z jiného důvodu, oprava jen ručně.
   * `uncertain`: výplaty sedí, ale dělení mezi sousedními místy nejde ze záznamu ověřit.
   */
  kind: 'fixable' | 'mismatch' | 'uncertain';
  /** Prize pool turnaje podle knihy a počet míst, která podle nastavení berou výhru. */
  pool: number;
  paidPlaces: number;
  /** Všechna místa turnaje: co se vyplatilo, co mělo být a kolik má hráč teď na zůstatku (kvůli vrácení přeplatku). */
  rows: { userId: string; name: string; place: number; paid: number; correct: number; balance: number; flagged: boolean }[];
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
  /** Zapíše výsledky skončeného turnaje do statistik (pro doplnění chybějících). */
  recordResults?: (tournamentId: string) => Promise<void>;
  /** Skončené turnaje s výsledky a nastavením, se kterým se hrály (pro přepočet výplat). */
  finishedTournaments?: (onlyId?: string) => Promise<{ id: string; name: string; settings: SettingValues; st: TournamentState }[]>;
  /** Zapíše opravené výplaty do stavu turnaje. */
  correctPayouts?: (tournamentId: string, correct: Record<string, number>) => Promise<void>;
  /** Po opravě výplat: obnoví zůstatky dotčených hráčů a žebříčky. */
  afterPayoutFix?: (userIds: string[]) => void;
  audit?: AuditService;
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

  /**
   * Přepočet výplat skončených turnajů: z prize poolu a nastavení turnaje spočítá, co mělo které místo dostat, a porovná to
   * s tím, co se vyplatilo. Hledá hlavně chybu, kdy si výplatu rozdělili hráči, kteří kdysi vypadli spolu a pak si dali rebuy.
   * Jen čte. Prize pool bere z knihy (co z účtu turnaje odešlo na výplatách a zbytku domu).
   */
  async payoutProblems(onlyId?: string): Promise<PayoutProblem[]> {
    if (!this.deps.finishedTournaments) return [];
    await this.deps.flush();
    const db = this.deps.db;
    const le = schema.ledgerEntries;
    const lt_ = schema.ledgerTransactions;
    const tours = await this.deps.finishedTournaments(onlyId);
    if (tours.length === 0) return [];
    const paidOut = await db
      .select({ account: le.account, sum: sql<number>`sum(${le.amount})::int` })
      .from(le)
      .innerJoin(lt_, eq(lt_.id, le.transactionId))
      .where(and(like(le.account, 'tournament:%'), eq(lt_.kind, 'turnaj_vyplata')))
      .groupBy(le.account);
    const poolOf = new Map(paidOut.map((r) => [r.account, -Number(r.sum)]));
    const out: PayoutProblem[] = [];
    for (const t of tours) {
      const results = t.st.results!;
      const pool = poolOf.get(accounts.tournament(t.id)) ?? 0;
      let amounts: number[] = [];
      if (pool > 0) {
        try {
          const pct = percentsFor(t.settings['tournament.payoutPreset'] as PayoutPreset, String(t.settings['tournament.payoutCustom']), results.length);
          amounts = computePayouts(pool, pct, { roundTo: Number(t.settings['tournament.payoutRoundTo']), remainder: t.settings['tournament.payoutRemainder'] as RemainderRule }).amounts;
        } catch {
          amounts = [];
        }
      }
      const audit = auditPayouts({
        results,
        amounts,
        deal: t.st.deal ?? null,
        tiedGroups: t.st.tiedGroups ?? [],
        rebought: new Set(t.st.players.filter((p) => p.rebuys > 0).map((p) => p.userId)),
      });
      const kind = audit.verdict === 'ok' ? (audit.uncertain.length > 0 ? 'uncertain' : null) : audit.verdict;
      if (!kind) continue;
      const unsure = new Set(audit.uncertain.flat());
      out.push({
        id: t.id,
        name: t.name,
        finishedAt: t.st.finishedAt,
        kind,
        pool,
        paidPlaces: amounts.filter((x) => x > 0).length,
        rows: results.map((r, i) => ({
          userId: r.userId,
          name: r.name,
          place: r.place,
          paid: r.payout,
          correct: audit.correct[i]!,
          balance: this.deps.ledger.balance(accounts.wallet(r.userId)),
          flagged: kind === 'uncertain' ? unsure.has(r.userId) : r.payout !== audit.correct[i],
        })),
      });
    }
    return out.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  }

  /** Seznam turnajů s chybnými nebo neověřitelnými výplatami pro správce (jen čte). */
  async payoutReport(actorId: string): Promise<PayoutProblem[]> {
    if (!this.deps.perms.can(actorId, 'mena.zobrazit_knihu').allowed) throw new ConsistencyError('FORBIDDEN');
    return this.payoutProblems();
  }

  /**
   * Opraví chybně rozdělené výplaty jednoho turnaje: jedním pohybem v knize převede rozdíl od hráčů, kteří dostali víc,
   * hráčům, kteří dostali míň (součet je nula, nic nevzniká ani nemizí), a opraví záznam turnaje i statistiky.
   * Když přeplacený hráč nemá dost na zůstatku, neprovede se nic (peněženka nesmí do mínusu ani do kontokorentu bez jeho vědomí).
   */
  async repairPayouts(actorId: string, tournamentId: string, meta: { ip?: string | null; source?: AuditSource } = {}): Promise<{ moved: number }> {
    if (!this.deps.perms.can(actorId, 'mena.upravit_knihu').allowed || !this.deps.correctPayouts) throw new ConsistencyError('FORBIDDEN');
    const [problem] = await this.payoutProblems(tournamentId);
    if (!problem || problem.kind !== 'fixable') throw new ConsistencyError('NOTHING_TO_FIX');
    const rows = problem.rows.filter((r) => r.paid !== r.correct);
    for (const r of rows) {
      const owes = r.paid - r.correct;
      if (owes > 0 && r.balance < owes) throw new ConsistencyError('INSUFFICIENT_FUNDS', { name: r.name, owes, has: r.balance });
    }
    const entries = rows.map((r) => ({ account: accounts.wallet(r.userId), amount: r.correct - r.paid }));
    const moved = entries.reduce((n, e) => n + Math.max(0, e.amount), 0);
    this.deps.ledger.post({ kind: 'turnaj_vyplata', idempotencyKey: `trn:${tournamentId}:payoutfix`, gameId: tournamentId, createdBy: actorId, note: 'oprava chybně rozdělených výplat turnaje', entries });
    await this.deps.correctPayouts(tournamentId, Object.fromEntries(rows.map((r) => [r.userId, r.correct])));
    await this.deps.flush();
    const gr = schema.gameResults;
    for (const r of rows) await this.deps.db.update(gr).set({ payout: r.correct }).where(and(eq(gr.kind, 'tournament'), eq(gr.ref, tournamentId), eq(gr.userId, r.userId)));
    await this.deps.audit?.log({
      actorId,
      action: 'turnaj.oprava_vyplat',
      targetType: 'tournament',
      targetId: tournamentId,
      before: Object.fromEntries(rows.map((r) => [r.userId, r.paid])),
      after: Object.fromEntries(rows.map((r) => [r.userId, r.correct])),
      ...meta,
    });
    this.deps.afterPayoutFix?.(rows.map((r) => r.userId));
    return { moved };
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

    // 4) záporné zůstatky: jen mint smí být záporný (chybějící Korony hráče kryje kontokorent, peněženka pod nulu nejde)
    const negative = acc.filter((a) => a.id !== accounts.mint() && Number(a.balance) < 0).map((a) => `účet ${a.id}: ${a.balance}`);
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

    // 12) výplaty skončených turnajů odpovídají přepočtu (chybně dělené výplaty po společném vypadnutí a rebuy)
    const payouts = (await this.payoutProblems()).filter((p) => p.kind !== 'uncertain');
    add('tournamentPayouts', payouts.map((p) => `turnaj ${p.name}: ${p.rows.filter((r) => r.flagged).map((r) => `${r.place}. ${r.name} dostal ${r.paid}, mělo být ${r.correct}`).join('; ')}`));

    return { at: this.deps.now(), ok: checks.every((c) => c.ok), checks };
  }
}
