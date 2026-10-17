import { describe, expect, it } from 'vitest';
import { formatLocal, fromLocal, nextOccurrences, ScheduleError, toLocal, type ScheduleRule } from './schedule.js';

const iso = (ms: number) => new Date(ms).toISOString();

describe('čas v pásmu Europe/Prague', () => {
  it('převod místního času na UTC respektuje zimní i letní čas', () => {
    expect(iso(fromLocal(2026, 1, 15, 20, 0))).toBe('2026-01-15T19:00:00.000Z'); // zima: UTC+1
    expect(iso(fromLocal(2026, 7, 15, 20, 0))).toBe('2026-07-15T18:00:00.000Z'); // léto: UTC+2
    expect(toLocal(Date.parse('2026-07-15T18:00:00Z'))).toMatchObject({ y: 2026, m: 7, d: 15, h: 20, mi: 0, weekday: 3 }); // středa
  });

  it('okolí přechodu: poslední neděle v říjnu a březnu', () => {
    // 2026: letní čas začíná 29. 3. (2:00 → 3:00), končí 25. 10. (3:00 → 2:00)
    expect(iso(fromLocal(2026, 3, 28, 20, 0))).toBe('2026-03-28T19:00:00.000Z');
    expect(iso(fromLocal(2026, 3, 29, 20, 0))).toBe('2026-03-29T18:00:00.000Z');
    expect(iso(fromLocal(2026, 10, 24, 20, 0))).toBe('2026-10-24T18:00:00.000Z');
    expect(iso(fromLocal(2026, 10, 25, 20, 0))).toBe('2026-10-25T19:00:00.000Z');
    // neexistující 2:30 se posune dopředu, ne zpět
    expect(fromLocal(2026, 3, 29, 2, 30)).toBeGreaterThanOrEqual(Date.parse('2026-03-29T01:00:00Z'));
  });
});

describe('opakování', () => {
  const weekly: ScheduleRule = { type: 'weekly', weekday: 5, time: '20:00', everyWeeks: 1, from: '2026-01-01' };

  it('každý pátek ve 20:00 drží místní čas i přes změnu času', () => {
    const list = nextOccurrences(weekly, Date.parse('2026-10-15T00:00:00Z'), 4);
    expect(list.map(iso)).toEqual(['2026-10-16T18:00:00.000Z', '2026-10-23T18:00:00.000Z', '2026-10-30T19:00:00.000Z', '2026-11-06T19:00:00.000Z']);
    for (const ms of list) expect(toLocal(ms)).toMatchObject({ h: 20, mi: 0, weekday: 5 });
  });

  it('výskyt přesně v okamžiku „po“ se nepočítá', () => {
    const at = Date.parse('2026-10-16T18:00:00Z');
    expect(nextOccurrences(weekly, at, 1)[0]).toBe(Date.parse('2026-10-23T18:00:00Z'));
    expect(nextOccurrences(weekly, at - 1, 1)[0]).toBe(at);
  });

  it('každé dva týdny od zadaného data', () => {
    const rule: ScheduleRule = { type: 'weekly', weekday: 4, time: '19:30', everyWeeks: 2, from: '2026-10-01' };
    const days = nextOccurrences(rule, Date.parse('2026-09-01T00:00:00Z'), 4).map((ms) => `${toLocal(ms).m}-${toLocal(ms).d}`);
    expect(days).toEqual(['10-1', '10-15', '10-29', '11-12']);
  });

  it('první čtvrtek v měsíci a poslední pátek v měsíci', () => {
    const first: ScheduleRule = { type: 'monthlyNth', weekday: 4, nth: 1, time: '19:00', from: '2026-01-01' };
    expect(nextOccurrences(first, Date.parse('2026-10-01T18:00:00Z'), 3).map((ms) => `${toLocal(ms).m}-${toLocal(ms).d}`)).toEqual(['11-5', '12-3', '1-7']);
    const last: ScheduleRule = { type: 'monthlyNth', weekday: 5, nth: -1, time: '21:00', from: '2026-01-01' };
    expect(nextOccurrences(last, Date.parse('2026-10-01T00:00:00Z'), 3).map((ms) => `${toLocal(ms).m}-${toLocal(ms).d}`)).toEqual(['10-30', '11-27', '12-25']);
  });

  it('denně každé tři dny a jednorázově', () => {
    const daily: ScheduleRule = { type: 'daily', time: '12:00', everyDays: 3, from: '2026-10-01' };
    expect(nextOccurrences(daily, Date.parse('2026-10-02T00:00:00Z'), 3).map((ms) => toLocal(ms).d)).toEqual([4, 7, 10]);
    const at = Date.parse('2027-01-01T10:00:00Z');
    expect(nextOccurrences({ type: 'once', at }, 0, 5)).toEqual([at]);
    expect(nextOccurrences({ type: 'once', at }, at, 5)).toEqual([]);
  });

  it('pravidlo před datem „from“ nic nevrací; neplatné pravidlo vyhodí chybu', () => {
    const rule: ScheduleRule = { type: 'weekly', weekday: 1, time: '10:00', everyWeeks: 1, from: '2027-06-01' };
    expect(toLocal(nextOccurrences(rule, 0, 1)[0]!)).toMatchObject({ y: 2027, m: 6, d: 7 });
    expect(() => nextOccurrences({ type: 'weekly', weekday: 5, time: '25:00', everyWeeks: 1, from: '2026-01-01' }, 0)).toThrow(ScheduleError);
    expect(() => nextOccurrences({ type: 'weekly', weekday: 5, time: '20:00', everyWeeks: 0, from: '2026-01-01' }, 0)).toThrow(ScheduleError);
    expect(() => nextOccurrences({ type: 'daily', time: '20:00', everyDays: 1, from: 'dnes' }, 0)).toThrow(ScheduleError);
  });

  it('formát pro zobrazení je v místním čase', () => {
    expect(formatLocal(Date.parse('2026-10-16T18:00:00Z'))).toContain('20:00');
  });
});
