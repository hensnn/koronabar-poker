import { and, asc, eq, gte, inArray, like, lt, sql } from 'drizzle-orm';
import { accounts, type Ledger } from '@kb/ledger';
import { DEFAULT_TZ, t, currencyFormsOf, currencyWord, monthIndex, parseYearFields, pickYearFields, yearBounds, type SettingValues, type YearChannel, type YearField, type YearStats } from '@kb/shared';
import { schema, type Db } from './db/index.js';

export class YearStatsError extends Error {
  constructor(public readonly code: 'DISABLED' | 'INVALID') {
    super(code);
  }
}

interface Deps {
  db: Db;
  ledger: Ledger;
  settings: () => SettingValues;
  now: () => number;
}

const KEY: Record<YearChannel, string> = { web: 'stats.yearFieldsWeb', email: 'stats.yearFieldsEmail', api: 'stats.yearFieldsApi' };

/**
 * Roční statistika hráče: výdělek v roce (turnaje, cash, živý cash), kladné a záporné výsledky, nabité a strhnuté žetony
 * a zůstatek na začátku a konci roku. Vždy jen data jednoho hráče; které údaje se ukážou, určuje správce pro každý kanál zvlášť.
 */
export class YearStatsService {
  /** Tvary názvu měny pro texty. */
  forms(): readonly [string, string, string] {
    return currencyFormsOf(this.deps.settings());
  }

  constructor(private deps: Deps) {}

  /** Aktuální rok v časové zóně aplikace. */
  currentYear(): number {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TZ, year: 'numeric' }).format(new Date(this.deps.now())));
  }

  private enabled(): void {
    if (this.deps.settings()['stats.yearEnabled'] === false) throw new YearStatsError('DISABLED');
  }

  /** Údaje, které správce povolil pro daný kanál. */
  fieldsFor(channel: YearChannel): YearField[] {
    return parseYearFields(this.deps.settings()[KEY[channel]], channel);
  }

  /** Roky, ve kterých hráč něco odehrál nebo měl pohyb na peněžence (nejnovější první, vždy aspoň aktuální). */
  async years(userId: string): Promise<number[]> {
    const gr = schema.gameResults;
    const rows = await this.deps.db.select({ at: gr.finishedAt }).from(gr).where(eq(gr.userId, userId));
    const hands = await this.deps.db.select({ at: sql<Date>`min(${schema.handPlayers.playedAt})` }).from(schema.handPlayers).where(eq(schema.handPlayers.userId, userId));
    const ys = new Set<number>([this.currentYear()]);
    const yearOf = (d: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TZ, year: 'numeric' }).format(d));
    for (const r of rows) ys.add(yearOf(r.at));
    const first = hands[0]?.at;
    if (first) for (let y = yearOf(new Date(first)); y <= this.currentYear(); y++) ys.add(y);
    return [...ys].sort((a, b) => b - a);
  }

  /** Úplná roční statistika (bez omezení kanálem); serverové volání. */
  async compute(userId: string, year: number): Promise<YearStats> {
    this.enabled();
    if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new YearStatsError('INVALID');
    const { from, to } = yearBounds(year, DEFAULT_TZ);
    const fromD = new Date(from);
    const toD = new Date(to);
    const db = this.deps.db;
    const gr = schema.gameResults;
    const monthly = Array.from({ length: 12 }, () => 0);
    let tournamentNet = 0;
    let liveNet = 0;
    let cashNet = 0;
    let won = 0;
    let lost = 0;
    let tournaments = 0;
    const add = (v: number) => {
      if (v > 0) won += v;
      else lost += v;
    };

    const games = await db.select().from(gr).where(and(eq(gr.userId, userId), inArray(gr.kind, ['tournament', 'live_cash']), gte(gr.finishedAt, fromD), lt(gr.finishedAt, toD))).orderBy(asc(gr.finishedAt));
    for (const g of games) {
      const net = Number(g.payout) + Number(g.bounty) - Number(g.spent);
      if (g.kind === 'tournament') {
        tournamentNet += net;
        tournaments++;
      } else liveNet += net;
      add(net);
      monthly[monthIndex(g.finishedAt.getTime(), DEFAULT_TZ)]! += net;
    }

    const hp = schema.handPlayers;
    const day = sql<string>`date_trunc('day', ${hp.playedAt} at time zone ${sql.raw(`'${DEFAULT_TZ}'`)})`;
    const cashDays = await db
      .select({ day, at: sql<Date>`min(${hp.playedAt})`, n: sql<number>`count(*)::int`, net: sql<string>`coalesce(round(sum((${hp.won} - ${hp.invested})::numeric / ${schema.hands.chipsPerUnit})), 0)` })
      .from(hp)
      .innerJoin(schema.hands, eq(schema.hands.id, hp.handId))
      .where(and(eq(hp.userId, userId), eq(hp.kind, 'cash'), gte(hp.playedAt, fromD), lt(hp.playedAt, toD)))
      .groupBy(day);
    let hands = 0;
    for (const c of cashDays) {
      const net = Number(c.net);
      cashNet += net;
      hands += Number(c.n);
      add(net);
      monthly[monthIndex(new Date(c.at).getTime(), DEFAULT_TZ)]! += net;
    }

    // Pohyby peněženky: nabití a strhnutí správcem, zůstatek na začátku a na konci roku.
    const wallet = accounts.wallet(userId);
    const le = schema.ledgerEntries;
    const lt_ = schema.ledgerTransactions;
    const sumBefore = async (limit: Date) => {
      const [r] = await db.select({ s: sql<string>`coalesce(sum(${le.amount}), 0)` }).from(le).innerJoin(lt_, eq(lt_.id, le.transactionId)).where(and(eq(le.account, wallet), lt(lt_.at, limit)));
      return Number(r?.s ?? 0);
    };
    const moved = async (kind: string, prefix: string) => {
      const [r] = await db.select({ s: sql<string>`coalesce(sum(${le.amount}), 0)` }).from(le).innerJoin(lt_, eq(lt_.id, le.transactionId)).where(and(eq(le.account, wallet), eq(lt_.kind, kind), like(lt_.idempotencyKey, `${prefix}%`), gte(lt_.at, fromD), lt(lt_.at, toD)));
      return Number(r?.s ?? 0);
    };
    const balanceStart = await sumBefore(fromD);
    const balanceEnd = await sumBefore(toD);
    const topUps = await moved('mint', 'topup:');
    const withdrawals = Math.abs(await moved('manual_adjustment', 'debit:'));

    return { year, net: tournamentNet + cashNet + liveNet, tournamentNet, cashNet, liveNet, won, lost, topUps, withdrawals, balanceStart, balanceEnd, hands, tournaments, monthly };
  }

  /** Text souhrnu pro e-mail: řádky „Popisek: hodnota“ jen pro údaje povolené pro e-mail (měsíční graf se do textu nedává). */
  summaryText(stats: YearStats, fields: readonly YearField[], forms: readonly [string, string, string]): string {
    const lines: string[] = [];
    for (const f of fields) {
      if (f === 'monthly') continue;
      const v = stats[f] as number;
      const money = !['hands', 'tournaments'].includes(f);
      const signed = ['net', 'tournamentNet', 'cashNet', 'liveNet', 'won', 'lost'].includes(f) && v > 0 ? '+' : '';
      lines.push(`${t(`year.field.${f}`)}: ${signed}${v.toLocaleString('cs-CZ')}${money ? ` ${currencyWord(v, forms)}` : ''}`);
    }
    return lines.join('\n');
  }

  /** Statistika jen s údaji povolenými pro kanál (web, e-mail, API). */
  async forChannel(userId: string, year: number, channel: YearChannel): Promise<ReturnType<typeof pickYearFields>> {
    return pickYearFields(await this.compute(userId, year), this.fieldsFor(channel));
  }
}
