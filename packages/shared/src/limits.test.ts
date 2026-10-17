import { describe, expect, it } from 'vitest';
import { changeLimits, checkLimits, cleanLimits, mergeLimits, periodStart, settlePending, usageIn, type LimitEvent } from './limits.js';
import { fromLocal } from './schedule.js';

const H = 3600_000;
// středa 14. 10. 2026 12:00 pražského času
const NOW = fromLocal(2026, 10, 14, 12, 0);

describe('osobní limity: změny', () => {
  it('zpřísnění platí hned, uvolnění čeká a nová hodnota pole se posuzuje zvlášť', () => {
    const r = changeLimits({ lossDay: 500, buyInsDay: 3 }, {}, { lossDay: 200, buyInsDay: 0, lossWeek: 1000 }, NOW, 24 * H);
    expect(r.current).toEqual({ lossDay: 200, buyInsDay: 3, lossWeek: 1000 });
    expect(r.applied.sort()).toEqual(['lossDay', 'lossWeek']);
    expect(r.delayed).toEqual(['buyInsDay']);
    expect(r.pending.buyInsDay).toEqual({ value: 0, at: NOW + 24 * H });
  });

  it('nastavení limitu poprvé (z neomezeného) je zpřísnění; zrušení limitu je uvolnění', () => {
    expect(changeLimits({}, {}, { lossDay: 100 }, NOW, H).applied).toEqual(['lossDay']);
    expect(changeLimits({ lossDay: 100 }, {}, { lossDay: 0 }, NOW, H).delayed).toEqual(['lossDay']);
  });

  it('zpřísnění zruší čekající uvolnění a opakované uvolnění nezkrátí čekání', () => {
    const first = changeLimits({ lossDay: 100 }, {}, { lossDay: 500 }, NOW, 24 * H);
    const again = changeLimits(first.current, first.pending, { lossDay: 500 }, NOW + 5 * H, 24 * H);
    expect(again.pending.lossDay!.at).toBe(NOW + 24 * H);
    const tighter = changeLimits(first.current, first.pending, { lossDay: 80 }, NOW + H, 24 * H);
    expect(tighter.current.lossDay).toBe(80);
    expect(tighter.pending.lossDay).toBeUndefined();
  });

  it('čekající uvolnění se uplatní, až uplyne doba', () => {
    const r = changeLimits({ lossDay: 100 }, {}, { lossDay: 500 }, NOW, 24 * H);
    expect(settlePending(r.current, r.pending, NOW + 23 * H).changed).toBe(false);
    const done = settlePending(r.current, r.pending, NOW + 24 * H);
    expect(done).toMatchObject({ changed: true, current: { lossDay: 500 }, pending: {} });
  });

  it('vstup se čistí a společné limity správce se skládají s osobními (platí přísnější)', () => {
    expect(cleanLimits({ lossDay: 100, nesmysl: 1 })).toBeNull();
    expect(cleanLimits({ lossDay: -1 })).toBeNull();
    expect(cleanLimits({ lossDay: 1.5 })).toBeNull();
    expect(cleanLimits({ lossDay: 100 })).toEqual({ lossDay: 100 });
    expect(mergeLimits({ lossDay: 300, buyInsDay: 0 }, { lossDay: 200, buyInsDay: 5, lossWeek: 0 })).toEqual({ lossDay: 200, buyInsDay: 5 });
    expect(mergeLimits({}, {})).toEqual({});
  });
});

describe('osobní limity: období a kontrola', () => {
  it('začátek dne, týdne (pondělí) a měsíce v pražském čase', () => {
    expect(periodStart('day', NOW)).toBe(fromLocal(2026, 10, 14, 0, 0));
    expect(periodStart('week', NOW)).toBe(fromLocal(2026, 10, 12, 0, 0));
    expect(periodStart('month', NOW)).toBe(fromLocal(2026, 10, 1, 0, 0));
  });

  const ev = (hoursAgo: number, delta: number, buyIn = delta < 0): LimitEvent => ({ at: NOW - hoursAgo * H, buyIn, delta });

  it('spotřeba: počet buy-inů a čistá prohra za období', () => {
    const events = [ev(1, -100), ev(2, -100), ev(3, 150, false), ev(30, -500)];
    expect(usageIn(events, NOW - 5 * H)).toEqual({ buyIns: 2, loss: 50 });
    expect(usageIn(events, NOW - 40 * H)).toEqual({ buyIns: 3, loss: 550 });
  });

  const base = { now: NOW, amount: 100, events: [] as LimitEvent[], eveningStart: null, sessionMinutes: null, breakUntil: null };

  it('počet buy-inů a prohra za období brání dalšímu vkladu', () => {
    const events = [ev(1, -100), ev(2, -100)];
    expect(checkLimits({ ...base, events, limits: { buyInsDay: 2 } })).toMatchObject({ kind: 'buyIns', field: 'buyInsDay', limit: 2, used: 2 });
    expect(checkLimits({ ...base, events, limits: { buyInsDay: 3 } })).toBeNull();
    expect(checkLimits({ ...base, events, limits: { lossDay: 250 } })).toMatchObject({ kind: 'loss', field: 'lossDay', used: 200 });
    expect(checkLimits({ ...base, events, limits: { lossDay: 300 } })).toBeNull();
    // výběr (kladná změna) prohru snižuje
    expect(checkLimits({ ...base, events: [...events, ev(0.5, 150, false)], limits: { lossDay: 250 } })).toBeNull();
  });

  it('starší události mimo období se nezapočítají a limit oznámí, kdy se uvolní', () => {
    const events = [ev(30, -1000)];
    expect(checkLimits({ ...base, events, limits: { lossDay: 200 } })).toBeNull();
    const v = checkLimits({ ...base, events: [ev(1, -150)], limits: { lossDay: 200 } });
    expect(v).toMatchObject({ kind: 'loss', resetsAt: fromLocal(2026, 10, 15, 0, 0) });
  });

  it('večer se počítá od začátku večera, pauza od hry a doba sezení blokují vždy', () => {
    const events = [ev(5, -100), ev(1, -100)];
    expect(checkLimits({ ...base, events, eveningStart: NOW - 2 * H, limits: { buyInsEvening: 1 } })).toMatchObject({ field: 'buyInsEvening', used: 1 });
    expect(checkLimits({ ...base, events, eveningStart: NOW - 6 * H, limits: { buyInsEvening: 2 } })).toMatchObject({ field: 'buyInsEvening', used: 2 });
    expect(checkLimits({ ...base, limits: {}, breakUntil: NOW + H })).toEqual({ kind: 'break', resetsAt: NOW + H });
    expect(checkLimits({ ...base, limits: {}, breakUntil: NOW - H })).toBeNull();
    expect(checkLimits({ ...base, limits: { sessionMinutes: 120 }, sessionMinutes: 130 })).toMatchObject({ kind: 'session', limit: 120, used: 130 });
    expect(checkLimits({ ...base, limits: { sessionMinutes: 120 }, sessionMinutes: 60 })).toBeNull();
    expect(checkLimits({ ...base, limits: { sessionMinutes: 0 }, sessionMinutes: 999 })).toBeNull();
  });
});
