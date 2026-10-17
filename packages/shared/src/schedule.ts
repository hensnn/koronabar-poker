/**
 * Pravidla plánování turnajů. Čas se zadává v místním čase (výchozí Europe/Prague) a převádí se na UTC
 * tak, aby „každý pátek ve 20:00“ platilo v zimě i v létě (přechod letního času).
 * Dny v týdnu jsou ISO: 1 = pondělí … 7 = neděle.
 */

export const DEFAULT_TZ = 'Europe/Prague';

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type ScheduleRule =
  /** Jednorázově v daný okamžik (UTC ms). */
  | { type: 'once'; at: number }
  /** Každý N-tý den od data \`from\`. */
  | { type: 'daily'; time: string; everyDays: number; from: string }
  /** Daný den v týdnu, každý N-tý týden počínaje týdnem data \`from\`. */
  | { type: 'weekly'; weekday: Weekday; time: string; everyWeeks: number; from: string }
  /** N-tý (1 až 4) nebo poslední (-1) daný den v měsíci, např. „první čtvrtek“. */
  | { type: 'monthlyNth'; weekday: Weekday; nth: 1 | 2 | 3 | 4 | -1; time: string; from: string };

export class ScheduleError extends Error {
  constructor(public readonly code: 'TIME' | 'DATE' | 'RULE') {
    super(code);
  }
}

interface Local {
  y: number;
  m: number; // 1–12
  d: number;
  h: number;
  mi: number;
  /** ISO den v týdnu */
  weekday: Weekday;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Místní čas v zadaném pásmu pro okamžik v UTC. */
export function toLocal(ms: number, tz = DEFAULT_TZ): Local {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]));
  const y = parts.year!;
  const m = parts.month!;
  const d = parts.day!;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = neděle
  return { y, m, d, h: parts.hour!, mi: parts.minute!, weekday: (dow === 0 ? 7 : dow) as Weekday };
}

/** Posun pásma v ms (místní čas − UTC) v daném okamžiku. */
function offsetAt(ms: number, tz: string): number {
  const l = toLocal(ms, tz);
  const asUtc = Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, 0);
  return asUtc - Math.floor(ms / 60000) * 60000;
}

/** Okamžik v UTC pro místní datum a čas; neexistující čas (jarní přechod) se posune dopředu. */
export function fromLocal(y: number, m: number, d: number, h: number, mi: number, tz = DEFAULT_TZ): number {
  const naive = Date.UTC(y, m - 1, d, h, mi, 0);
  let guess = naive - offsetAt(naive, tz);
  // Druhý průchod opraví případ, kdy se posun mezi odhadem a výsledkem liší (okolí přechodu).
  guess = naive - offsetAt(guess, tz);
  return guess;
}

export function parseTime(time: string): { h: number; mi: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!m) throw new ScheduleError('TIME');
  return { h: Number(m[1]), mi: Number(m[2]) };
}

export function parseDate(date: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) throw new ScheduleError('DATE');
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

const dayNumber = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);

/** Který týden (od pondělí) patří dané datum: číslo týdne od epochy. */
const weekNumber = (y: number, m: number, d: number) => Math.floor((dayNumber(y, m, d) + 3) / 7);

/** Kolikátý je tento den v týdnu v měsíci (1 = první) a zda je poslední. */
function nthInMonth(y: number, m: number, d: number): { nth: number; last: boolean } {
  const nth = Math.floor((d - 1) / 7) + 1;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { nth, last: d + 7 > daysInMonth };
}

export function validateRule(rule: ScheduleRule): void {
  if (rule.type === 'once') {
    if (!Number.isFinite(rule.at)) throw new ScheduleError('RULE');
    return;
  }
  parseTime(rule.time);
  parseDate(rule.from);
  if (rule.type === 'daily' && (!Number.isInteger(rule.everyDays) || rule.everyDays < 1 || rule.everyDays > 366)) throw new ScheduleError('RULE');
  if (rule.type === 'weekly' && (!Number.isInteger(rule.everyWeeks) || rule.everyWeeks < 1 || rule.everyWeeks > 52 || rule.weekday < 1 || rule.weekday > 7)) throw new ScheduleError('RULE');
  if (rule.type === 'monthlyNth' && (![1, 2, 3, 4, -1].includes(rule.nth) || rule.weekday < 1 || rule.weekday > 7)) throw new ScheduleError('RULE');
}

/**
 * Nejbližších \`count\` výskytů pravidla po okamžiku \`after\` (UTC ms), vzestupně.
 * Hledá se nejvýš dva roky dopředu.
 */
export function nextOccurrences(rule: ScheduleRule, after: number, count = 1, tz = DEFAULT_TZ): number[] {
  validateRule(rule);
  if (rule.type === 'once') return rule.at > after ? [rule.at] : [];
  const { h, mi } = parseTime(rule.time);
  const from = parseDate(rule.from);
  const fromDay = dayNumber(from.y, from.m, from.d);
  const fromWeek = weekNumber(from.y, from.m, from.d);
  const out: number[] = [];
  // Začínáme dnem (místním) o den dřív, aby se nic nepřeskočilo kvůli pásmu.
  const start = toLocal(after - 86_400_000, tz);
  let day = Math.max(dayNumber(start.y, start.m, start.d), fromDay);
  for (let i = 0; i < 800 && out.length < count; i++, day++) {
    const dt = new Date(day * 86_400_000);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    if (day < fromDay) continue;
    const weekday = ((dt.getUTCDay() + 6) % 7) + 1;
    let match = false;
    if (rule.type === 'daily') match = (day - fromDay) % rule.everyDays === 0;
    else if (rule.type === 'weekly') match = weekday === rule.weekday && (weekNumber(y, m, d) - fromWeek) % rule.everyWeeks === 0;
    else {
      const x = nthInMonth(y, m, d);
      match = weekday === rule.weekday && (rule.nth === -1 ? x.last : x.nth === rule.nth);
    }
    if (!match) continue;
    const at = fromLocal(y, m, d, h, mi, tz);
    if (at > after) out.push(at);
  }
  return out;
}

/** Datum a čas v místním pásmu jako text pro zobrazení (např. „pá 17. 10. 2026 20:00“). */
export function formatLocal(ms: number, tz = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat('cs-CZ', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}
