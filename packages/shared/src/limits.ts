import { fromLocal, toLocal } from './schedule.js';

/**
 * Osobní limity hráče: kolik buy-inů a kolik prohry za období, jak dlouho smí hrát v kuse, jak často se mu připomene
 * pauza. Nula nebo chybějící hodnota znamená „bez limitu“. Zpřísnění platí hned, uvolnění až po čekací době.
 */
export const LIMIT_FIELDS = ['lossDay', 'lossWeek', 'lossMonth', 'lossEvening', 'buyInsDay', 'buyInsWeek', 'buyInsMonth', 'buyInsEvening', 'sessionMinutes', 'reminderMinutes'] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];
export type Limits = Partial<Record<LimitField, number>>;
export interface PendingLimit {
  value: number;
  /** Od kdy platí (ms). */
  at: number;
}
export type PendingLimits = Partial<Record<LimitField, PendingLimit>>;

export type Period = 'day' | 'week' | 'month' | 'evening';
export const PERIODS: Period[] = ['day', 'week', 'month', 'evening'];

const eff = (v: number | undefined): number => (v && v > 0 ? v : Infinity);

/** Je nová hodnota volnější než dosavadní? (Víc povoleno, nebo limit zrušen.) */
export const isLooser = (current: number | undefined, next: number | undefined): boolean => eff(next) > eff(current);

/** Zkontroluje a vyčistí vstup: jen známá pole, celá nezáporná čísla. */
export function cleanLimits(input: unknown): Limits | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Limits = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(LIMIT_FIELDS as readonly string[]).includes(k)) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1_000_000_000) return null;
    out[k as LimitField] = v;
  }
  return out;
}

/**
 * Změna limitů: zpřísnění (nebo stejná hodnota) se projeví hned a zruší čekající uvolnění, uvolnění čeká
 * `delayMs`. Každé pole se posuzuje zvlášť.
 */
export function changeLimits(current: Limits, pending: PendingLimits, requested: Limits, now: number, delayMs: number): { current: Limits; pending: PendingLimits; applied: LimitField[]; delayed: LimitField[] } {
  const next: Limits = { ...current };
  const wait: PendingLimits = { ...pending };
  const applied: LimitField[] = [];
  const delayed: LimitField[] = [];
  for (const f of Object.keys(requested) as LimitField[]) {
    const v = requested[f]!;
    if (isLooser(current[f], v) && delayMs > 0) {
      // Znovu zadané uvolnění nezkracuje už běžící čekání.
      if (wait[f]?.value === v) continue;
      wait[f] = { value: v, at: now + delayMs };
      delayed.push(f);
    } else {
      next[f] = v;
      delete wait[f];
      applied.push(f);
    }
  }
  return { current: next, pending: wait, applied, delayed };
}

/** Uplatní uvolnění, kterým uplynula čekací doba. */
export function settlePending(current: Limits, pending: PendingLimits, now: number): { current: Limits; pending: PendingLimits; changed: boolean } {
  const next: Limits = { ...current };
  const wait: PendingLimits = { ...pending };
  let changed = false;
  for (const f of Object.keys(pending) as LimitField[]) {
    const p = pending[f]!;
    if (p.at > now) continue;
    next[f] = p.value;
    delete wait[f];
    changed = true;
  }
  return { current: next, pending: wait, changed };
}

/** Platný limit: z osobního a společného (správcova) platí přísnější nenulový. */
export function mergeLimits(user: Limits, global: Limits): Limits {
  const out: Limits = {};
  for (const f of LIMIT_FIELDS) {
    const m = Math.min(eff(user[f]), eff(global[f]));
    if (Number.isFinite(m)) out[f] = m;
  }
  return out;
}

/** Začátek období v pražském čase; „večer“ určuje volající (jinak se bere začátek dne). */
export function periodStart(period: Exclude<Period, 'evening'>, now: number): number {
  const l = toLocal(now);
  if (period === 'day') return fromLocal(l.y, l.m, l.d, 0, 0);
  if (period === 'month') return fromLocal(l.y, l.m, 1, 0, 0);
  // týden od pondělí
  const monday = new Date(Date.UTC(l.y, l.m - 1, l.d - (l.weekday - 1)));
  return fromLocal(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), 0, 0);
}

/** Jedno vypořádané pohyb hráče: buy-in se počítá, `delta` je změna peněženky ze hry (vklad záporný, výběr kladný). */
export interface LimitEvent {
  at: number;
  buyIn: boolean;
  delta: number;
}

export interface Usage {
  buyIns: number;
  loss: number;
}

/** Spotřeba v období. */
export function usageIn(events: LimitEvent[], from: number): Usage {
  let buyIns = 0;
  let net = 0;
  for (const e of events) {
    if (e.at < from) continue;
    if (e.buyIn) buyIns++;
    net += e.delta;
  }
  return { buyIns, loss: Math.max(0, -net) };
}

export interface LimitViolation {
  kind: 'break' | 'session' | 'buyIns' | 'loss';
  field?: LimitField;
  limit?: number;
  used?: number;
  /** Kdy se limit uvolní (konec pauzy, nebo začátek dalšího období). */
  resetsAt?: number;
}

const FIELD: Record<'loss' | 'buyIns', Record<Period, LimitField>> = {
  loss: { day: 'lossDay', week: 'lossWeek', month: 'lossMonth', evening: 'lossEvening' },
  buyIns: { day: 'buyInsDay', week: 'buyInsWeek', month: 'buyInsMonth', evening: 'buyInsEvening' },
};

function nextReset(period: Period, now: number): number | undefined {
  if (period === 'evening') return undefined;
  const start = periodStart(period, now);
  const l = toLocal(start + 36 * 3600_000);
  if (period === 'day') return fromLocal(l.y, l.m, l.d, 0, 0);
  if (period === 'week') return periodStart('week', start + 8 * 86_400_000);
  return periodStart('month', start + 33 * 86_400_000);
}

/**
 * Smí hráč právě teď utratit `amount` (buy-in, vklad do sázky…)? Vrací první porušený limit, nebo null.
 * Pořadí: pauza od hry, doba sezení, počet buy-inů, prohra.
 */
export function checkLimits(a: { countsBuyIn?: boolean; limits: Limits; now: number; amount: number; events: LimitEvent[]; eveningStart: number | null; sessionMinutes: number | null; breakUntil: number | null }): LimitViolation | null {
  if (a.breakUntil !== null && a.breakUntil > a.now) return { kind: 'break', resetsAt: a.breakUntil };
  const sessionLimit = a.limits.sessionMinutes ?? 0;
  if (sessionLimit > 0 && a.sessionMinutes !== null && a.sessionMinutes >= sessionLimit) return { kind: 'session', field: 'sessionMinutes', limit: sessionLimit, used: Math.floor(a.sessionMinutes) };
  const from = (p: Period): number => (p === 'evening' ? (a.eveningStart ?? periodStart('day', a.now)) : periodStart(p, a.now));
  for (const p of PERIODS) {
    const limit = a.limits[FIELD.buyIns[p]] ?? 0;
    if (limit <= 0 || a.countsBuyIn === false) continue;
    const used = usageIn(a.events, from(p)).buyIns;
    if (used + 1 > limit) return { kind: 'buyIns', field: FIELD.buyIns[p], limit, used, resetsAt: nextReset(p, a.now) };
  }
  for (const p of PERIODS) {
    const limit = a.limits[FIELD.loss[p]] ?? 0;
    if (limit <= 0) continue;
    const used = usageIn(a.events, from(p)).loss;
    if (used + a.amount > limit) return { kind: 'loss', field: FIELD.loss[p], limit, used, resetsAt: nextReset(p, a.now) };
  }
  return null;
}
