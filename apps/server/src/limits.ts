import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { LedgerGuardError, type Ledger, type Tx } from '@kb/ledger';
import { changeLimits, checkLimits, cleanLimits, mergeLimits, PERIODS, periodStart, settlePending, usageIn, LIMIT_FIELDS, type LimitEvent, type LimitViolation, type Limits, type Period, type PendingLimits, type SettingValues, type Usage } from '@kb/shared';
import type { AuditService } from './auth/audit.js';
import { schema, type Db } from './db/index.js';

export type LimitsErrorCode = 'INVALID' | 'DISABLED' | 'BREAK_SHORTER';

export class LimitsError extends Error {
  constructor(
    public code: LimitsErrorCode,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** Pohyby, které hráči berou peníze do hry (hlídají se limity). */
const GUARDED = new Set(['cash_buyin', 'cash_topup', 'turnaj_buyin', 'turnaj_rebuy', 'turnaj_addon', 'bet_stake', 'head_bounty_post']);
/** Z nich ty, které se počítají jako buy-in. */
const BUYINS = new Set(['cash_buyin', 'cash_topup', 'turnaj_buyin', 'turnaj_rebuy', 'turnaj_addon']);
/** Všechny pohyby peněženky ze hry (výsledek = čistá výhra nebo prohra). */
const GAME = new Set([...GUARDED, 'cash_cashout', 'cash_return', 'turnaj_vyplata', 'turnaj_refund', 'bounty', 'jackpot_payout', 'bet_payout', 'bet_refund', 'head_bounty_payout', 'head_bounty_return', 'time_charge']);
const KEEP_MS = 32 * 86_400_000;
const GLOBAL_KEYS: Record<string, string> = {
  lossDay: 'limits.global.lossDay',
  lossWeek: 'limits.global.lossWeek',
  lossMonth: 'limits.global.lossMonth',
  buyInsDay: 'limits.global.buyInsDay',
  buyInsWeek: 'limits.global.buyInsWeek',
  buyInsMonth: 'limits.global.buyInsMonth',
  sessionMinutes: 'limits.global.sessionMinutes',
};

interface UserState {
  current: Limits;
  pending: PendingLimits;
  breakUntil: number | null;
}

interface Deps {
  db: Db;
  ledger: Ledger;
  audit: AuditService;
  settings: () => SettingValues;
  now: () => number;
  /** Začátek právě otevřeného herního večera (pro limity „za večer“). */
  eveningStart: () => number | null;
  /** Hráči, kteří právě sedí u nějakého stolu. */
  seatedUsers: () => string[];
  notify: (userId: string, kind: string, params: Record<string, unknown>, link: string | null) => Promise<void>;
}

type Meta = { ip?: string | null };

/**
 * Osobní limity: hlídá je účetní kniha, takže se nedají obejít žádnou cestou (cash, turnaje, rebuy, sázky, odměny).
 * Zpřísnění platí hned, uvolnění až po čekací době. Pauza od hry se jen prodlužuje.
 */
export class LimitsService {
  private users = new Map<string, UserState>();
  private events = new Map<string, LimitEvent[]>();
  private sessions = new Map<string, { start: number; last: number; reminded: number; capped: boolean }>();

  constructor(private deps: Deps) {}

  async init(): Promise<void> {
    for (const r of await this.deps.db.select().from(schema.personalLimits)) {
      this.users.set(r.userId, { current: (r.current ?? {}) as Limits, pending: (r.pending ?? {}) as PendingLimits, breakUntil: r.breakUntil?.getTime() ?? null });
    }
    const since = new Date(this.deps.now() - KEEP_MS);
    const rows = await this.deps.db
      .select({ account: schema.ledgerEntries.account, amount: schema.ledgerEntries.amount, kind: schema.ledgerTransactions.kind, at: schema.ledgerTransactions.at })
      .from(schema.ledgerEntries)
      .innerJoin(schema.ledgerTransactions, eq(schema.ledgerTransactions.id, schema.ledgerEntries.transactionId))
      .where(and(like(schema.ledgerEntries.account, 'wallet:%'), gte(schema.ledgerTransactions.at, since), inArray(schema.ledgerTransactions.kind, [...GAME])));
    for (const r of rows.sort((a, b) => a.at.getTime() - b.at.getTime())) this.push(r.account.slice('wallet:'.length), { at: r.at.getTime(), buyIn: BUYINS.has(r.kind) && r.amount < 0, delta: r.amount });
  }

  private s() {
    return this.deps.settings();
  }

  private push(userId: string, e: LimitEvent): void {
    const list = this.events.get(userId) ?? [];
    list.push(e);
    const cut = e.at - KEEP_MS;
    while (list.length && list[0]!.at < cut) list.shift();
    this.events.set(userId, list);
  }

  private state(userId: string): UserState {
    const u = this.users.get(userId) ?? { current: {}, pending: {}, breakUntil: null };
    const settled = settlePending(u.current, u.pending, this.deps.now());
    if (settled.changed) {
      u.current = settled.current;
      u.pending = settled.pending;
      this.users.set(userId, u);
      void this.save(userId, u);
    }
    return u;
  }

  private global(): Limits {
    const s = this.s();
    const out: Limits = {};
    for (const [field, key] of Object.entries(GLOBAL_KEYS)) {
      const v = Number(s[key]);
      if (v > 0) out[field as keyof Limits] = v;
    }
    return out;
  }

  /** Platné limity hráče: osobní spojené se společnými. */
  effective(userId: string): Limits {
    return mergeLimits(this.state(userId).current, this.global());
  }

  private minutesOf(userId: string): number | null {
    const s = this.sessions.get(userId);
    return s ? (this.deps.now() - s.start) / 60_000 : null;
  }

  violation(userId: string, amount: number, countsBuyIn: boolean): LimitViolation | null {
    return checkLimits({ limits: this.effective(userId), now: this.deps.now(), amount, events: this.events.get(userId) ?? [], eveningStart: this.deps.eveningStart(), sessionMinutes: this.minutesOf(userId), breakUntil: this.state(userId).breakUntil, countsBuyIn });
  }

  // ---------- napojení na účetní knihu ----------

  /** Volá kniha před každou novou transakcí: peníze do hry při překročení limitu nepustí. */
  guard = (req: { kind: string; entries: { account: string; amount: number }[] }): void => {
    if (!this.s()['limits.enabled'] || !GUARDED.has(req.kind)) return;
    for (const e of req.entries) {
      if (e.amount >= 0 || !e.account.startsWith('wallet:')) continue;
      const userId = e.account.slice('wallet:'.length);
      const v = this.violation(userId, -e.amount, BUYINS.has(req.kind));
      if (v) throw new LedgerGuardError({ ...v });
    }
  };

  /** Volá kniha po každé nové transakci: zapíše pohyb do spotřeby limitů. */
  record = (tx: Tx): void => {
    if (!GAME.has(tx.kind)) return;
    for (const e of tx.entries) if (e.account.startsWith('wallet:')) this.push(e.account.slice('wallet:'.length), { at: tx.at, buyIn: BUYINS.has(tx.kind) && e.amount < 0, delta: e.amount });
  };

  // ---------- nastavení hráče ----------

  private async save(userId: string, u: UserState): Promise<void> {
    const values = { userId, current: u.current as Record<string, number>, pending: u.pending as Record<string, { value: number; at: number }>, breakUntil: u.breakUntil ? new Date(u.breakUntil) : null, updatedAt: new Date(this.deps.now()) };
    await this.deps.db.insert(schema.personalLimits).values(values).onConflictDoUpdate({ target: schema.personalLimits.userId, set: values });
  }

  async view(userId: string) {
    const u = this.state(userId);
    const now = this.deps.now();
    const usage = Object.fromEntries(PERIODS.map((p) => [p, usageIn(this.events.get(userId) ?? [], this.from(p))])) as Record<Period, Usage>;
    const s = this.s();
    return {
      enabled: !!s['limits.enabled'],
      limits: u.current,
      pending: u.pending,
      global: this.global(),
      effective: this.effective(userId),
      breakUntil: u.breakUntil && u.breakUntil > now ? u.breakUntil : null,
      usage,
      sessionMinutes: Math.floor(this.minutesOf(userId) ?? 0),
      loosenDelayHours: Number(s['limits.loosenDelayHours']),
      maxBreakDays: Number(s['limits.maxBreakDays']),
      fields: LIMIT_FIELDS,
    };
  }

  private from(p: Period): number {
    return p === 'evening' ? (this.deps.eveningStart() ?? periodStart('day', this.deps.now())) : periodStart(p, this.deps.now());
  }

  /** Změna limitů: zpřísnění hned, uvolnění po čekací době. */
  async set(userId: string, requested: unknown, meta: Meta = {}): Promise<{ applied: string[]; delayed: string[] }> {
    if (!this.s()['limits.enabled']) throw new LimitsError('DISABLED');
    const clean = cleanLimits(requested);
    if (!clean) throw new LimitsError('INVALID');
    const u = this.state(userId);
    const r = changeLimits(u.current, u.pending, clean, this.deps.now(), Number(this.s()['limits.loosenDelayHours']) * 3600_000);
    u.current = r.current;
    u.pending = r.pending;
    this.users.set(userId, u);
    await this.save(userId, u);
    await this.deps.audit.log({ actorId: userId, action: 'limity.zmenit', targetType: 'personal_limits', targetId: userId, after: { applied: r.applied, delayed: r.delayed, limits: clean }, ...meta });
    return { applied: r.applied, delayed: r.delayed };
  }

  /** Pauza od hry: jde jen prodloužit, zkrátit ani zrušit se nedá. */
  async setBreak(userId: string, hours: number, meta: Meta = {}): Promise<number> {
    if (!this.s()['limits.enabled']) throw new LimitsError('DISABLED');
    const max = Number(this.s()['limits.maxBreakDays']) * 24;
    if (!Number.isFinite(hours) || hours < 1 || hours > max) throw new LimitsError('INVALID', { field: 'hours', max });
    const u = this.state(userId);
    const until = this.deps.now() + hours * 3600_000;
    if (u.breakUntil && u.breakUntil > until) throw new LimitsError('BREAK_SHORTER', { until: u.breakUntil });
    u.breakUntil = until;
    this.users.set(userId, u);
    await this.save(userId, u);
    await this.deps.audit.log({ actorId: userId, action: 'limity.pauza', targetType: 'personal_limits', targetId: userId, after: { hours, until }, ...meta });
    return until;
  }

  // ---------- sezení a připomínky ----------

  /** Sleduje, kdo jak dlouho sedí u stolu; připomíná pauzu a hlásí dosažení limitu doby hry. */
  async tick(): Promise<void> {
    if (!this.s()['limits.enabled']) return;
    const now = this.deps.now();
    const gap = Number(this.s()['limits.sessionGapMinutes']) * 60_000;
    const seated = new Set(this.deps.seatedUsers());
    for (const u of seated) {
      const cur = this.sessions.get(u);
      if (!cur || now - cur.last > gap) this.sessions.set(u, { start: now, last: now, reminded: 0, capped: false });
      else cur.last = now;
    }
    for (const [u, sess] of [...this.sessions]) {
      if (!seated.has(u) && now - sess.last > gap) {
        this.sessions.delete(u);
        continue;
      }
      const minutes = (now - sess.start) / 60_000;
      const lim = this.effective(u);
      const every = lim.reminderMinutes ?? 0;
      if (every > 0 && Math.floor(minutes / every) > sess.reminded) {
        sess.reminded = Math.floor(minutes / every);
        await this.deps.notify(u, 'limitReminder', { minutes: Math.floor(minutes) }, null);
      }
      if (lim.sessionMinutes && minutes >= lim.sessionMinutes && !sess.capped) {
        sess.capped = true;
        await this.deps.notify(u, 'limitSession', { minutes: lim.sessionMinutes }, null);
      }
    }
  }
}
