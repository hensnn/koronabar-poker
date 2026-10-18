import { describe, expect, it } from 'vitest';
import { CashService, Ledger } from '@kb/ledger';
import { createDefaultRegistry, type SettingValues } from '@kb/shared';
import { FakeClock } from './clock.js';
import { TableActor, type TableEvent } from './table-actor.js';

const reg = createDefaultRegistry();
type Prefs = Record<string, Record<string, string>>;

function make(over: Record<string, number | boolean | string> = {}, prefs: Prefs = {}, seed = 1) {
  const clock = new FakeClock();
  const cash = new CashService(new Ledger());
  const settings = { ...reg.defaults(), 'cash.minBuyInBb': 10, 'cash.maxBuyInBb': 500, 'time.betweenHandsMs': 100, 'time.showdownMs': 100, 'time.potToWinnerMs': 100, 'time.allInRunoutDelayMs': 50, 'time.allInRiverDramaMs': 50, 'odds.enabled': false, ...over } as SettingValues;
  const events: TableEvent[] = [];
  let n = seed;
  const rnd = () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const actor = new TableActor({ tableId: 't', settings: () => settings, clock, cash, randomProvider: rnd, onEvent: (e) => events.push(e), userPref: (u, k) => prefs[u]?.[k] });
  ['a', 'b'].forEach((p, i) => {
    cash.mint(p, 100_000, `m-${p}`);
    actor.join(p, p.toUpperCase(), i, 1000);
  });
  clock.advance(100);
  const acting = () => {
    const v = actor.viewFor(null);
    return v.seats.find((s) => s.seat === v.actingSeat)?.playerId;
  };
  /** Dohraje handu bez sázek (call/check) až na showdown. */
  const toShowdown = () => {
    for (let i = 0; i < 40 && actor.currentPhase() === 'hand'; i++) {
      const p = acting();
      if (!p) break;
      const legal = actor.viewFor(p).legal!;
      actor.act(p, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' });
    }
  };
  return { clock, actor, events, acting, toShowdown };
}

const MUCK: Prefs = { a: { 'ui.showdownLosing': 'muck' }, b: { 'ui.showdownLosing': 'muck' } };
const ASK: Prefs = { a: { 'ui.showdownLosing': 'ask' }, b: { 'ui.showdownLosing': 'ask' } };

describe('showdown: ukázat, nebo odhodit karty (muck)', () => {
  it('ve výchozím nastavení se na showdownu ukážou karty všech', () => {
    const m = make();
    m.toShowdown();
    const v = m.actor.viewFor(null);
    expect(v.winners).not.toBeNull();
    expect(v.seats.every((s) => s.cards !== null && s.reveal === undefined)).toBe(true);
    expect(m.events.some((e) => e.type === 'mucked')).toBe(false);
  });

  it('poražený s nastavením „muck“ karty odhodí; výherce je ukázat musí a historie mu karty neprozradí', () => {
    let mucks = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const m = make({}, MUCK, seed);
      m.toShowdown();
      const v = m.actor.viewFor(null);
      const winSeats = new Set(v.winners!.map((w) => w.seat));
      for (const s of v.seats) {
        if (winSeats.has(s.seat)) {
          expect(s.cards, 'výherce musí ukázat').not.toBeNull();
          expect(s.reveal).toBeUndefined();
        }
        if (s.reveal === 'muck') {
          mucks++;
          expect(s.cards).toBeNull();
          expect(winSeats.has(s.seat)).toBe(false);
          // vlastní karty hráč vidí, soupeř ne
          expect(m.actor.viewFor(s.playerId).seats.find((x) => x.seat === s.seat)!.cards).not.toBeNull();
          const end = m.events.find((e) => e.type === 'handEnd');
          expect(end && end.type === 'handEnd' && end.record.players.find((p) => p.userId === s.playerId)!.revealed).toBe(false);
          expect(m.events.some((e) => e.type === 'mucked' && e.userId === s.playerId)).toBe(true);
        }
      }
    }
    expect(mucks).toBeGreaterThan(0);
  });

  it('zakázaný muck u stolu (special.muckAllowed) vynutí ukázání všech karet', () => {
    const m = make({ 'special.muckAllowed': false }, MUCK);
    m.toShowdown();
    expect(m.actor.viewFor(null).seats.every((s) => s.cards !== null && s.reveal === undefined)).toBe(true);
  });

  it('„ptát se“: poražený rozhoduje do limitu, jeho karty zatím nikdo nevidí; po ukázání se zveřejní', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const m = make({}, ASK, seed);
      m.toShowdown();
      const deciding = m.actor.viewFor(null).seats.find((s) => s.reveal === 'deciding');
      if (!deciding) continue;
      const other = m.actor.viewFor(null).seats.find((s) => s.seat !== deciding.seat)!;
      expect(deciding.cards).toBeNull();
      expect(m.actor.viewFor(deciding.playerId).showdownChoice?.deadline).toBeGreaterThan(0);
      expect(m.actor.viewFor(other.playerId).showdownChoice).toBeNull();
      expect(m.events.some((e) => e.type === 'handEnd')).toBe(false);
      expect(() => m.actor.showdownChoice(other.playerId, 'show')).toThrowError(expect.objectContaining({ code: 'NOT_ALLOWED' }));
      m.actor.showdownChoice(deciding.playerId, 'show');
      const after = m.actor.viewFor(null).seats.find((s) => s.seat === deciding.seat)!;
      expect(after.cards).not.toBeNull();
      expect(after.reveal).toBeUndefined();
      const end = m.events.find((e) => e.type === 'handEnd');
      expect(end && end.type === 'handEnd' && end.record.players.find((p) => p.userId === deciding.playerId)!.revealed).toBe(true);
      m.clock.advance(1000);
      expect(m.actor.currentPhase() === 'hand' || m.actor.viewFor(null).handNumber >= 2).toBe(true);
      return;
    }
    throw new Error('žádná handa s rozhodováním');
  });

  it('„ptát se“: bez odpovědi do limitu se karty odhodí (muck) a handa se dokončí', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const m = make({ 'time.showdownChoiceMs': 2000 }, ASK, seed);
      m.toShowdown();
      const deciding = m.actor.viewFor(null).seats.find((s) => s.reveal === 'deciding');
      if (!deciding) continue;
      m.clock.advance(1900);
      expect(m.actor.viewFor(null).seats.find((s) => s.seat === deciding.seat)!.reveal).toBe('deciding');
      m.clock.advance(200);
      const after = m.actor.viewFor(null).seats.find((s) => s.seat === deciding.seat)!;
      expect(after.reveal).toBe('muck');
      expect(after.cards).toBeNull();
      const end = m.events.find((e) => e.type === 'handEnd');
      expect(end && end.type === 'handEnd' && end.record.players.find((p) => p.userId === deciding.playerId)!.revealed).toBe(false);
      m.clock.advance(3000);
      expect(m.actor.viewFor(null).handNumber).toBeGreaterThanOrEqual(2);
      expect(m.actor.hasError()).toBeFalsy();
      return;
    }
    throw new Error('žádná handa s rozhodováním');
  });

  it('výherce bez showdownu s nastavením „ukazovat vždy“ ukáže karty sám', () => {
    const m = make({ 'special.showCards': true }, { a: { 'ui.showdownWinning': 'always' }, b: { 'ui.showdownWinning': 'always' } });
    const p = m.acting()!;
    m.actor.act(p, { type: 'fold' });
    const v = m.actor.viewFor(null);
    const winner = v.seats.find((s) => s.playerId !== p)!;
    expect(winner.exposed?.every((c) => c !== null)).toBe(true);
    expect(v.seats.find((s) => s.playerId === p)!.exposed).toBeUndefined();
    expect(m.events.some((e) => e.type === 'shown' && e.userId === winner.playerId && e.which === 'both')).toBe(true);
  });

  it('výherce bez showdownu s výchozím nastavením karty neukazuje', () => {
    const m = make({ 'special.showCards': true });
    m.actor.act(m.acting()!, { type: 'fold' });
    expect(m.actor.viewFor(null).seats.every((s) => s.exposed === undefined)).toBe(true);
  });
});
