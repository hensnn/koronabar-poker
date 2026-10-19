import { describe, expect, it } from 'vitest';
import type { TableView } from '@kb/game-core';
import { entryActions, positionText, wantedList, type TournamentInfo } from './InfoCard';


const tour = (over: Partial<TournamentInfo> = {}): TournamentInfo => ({
  status: 'running',
  prizePool: 600,
  players: 6,
  alive: 4,
  payouts: [{ place: 1, amount: 400 }, { place: 2, amount: 200 }],
  bounty: { type: 'none', percent: 0, pkoCash: 0, bank: 0 },
  buyIn: 100,
  fee: 10,
  serverTime: 0,
  rebuy: { enabled: true, cost: 100, chips: 600 },
  addon: { enabled: true, cost: 50, chips: 400 },
  me: { status: 'playing', decideUntil: null, canRebuy: false, canAddon: false, canReenter: false },
  reentry: { enabled: false },
  standings: [
    { userId: 'a', place: 1, chips: 3000, status: 'playing' },
    { userId: 'b', place: 2, chips: 2000, status: 'playing' },
    { userId: 'c', place: 3, chips: 1000, status: 'playing' },
    { userId: 'd', place: 4, chips: 500, status: 'playing' },
    { userId: 'e', place: 5, chips: 0, status: 'out' },
    { userId: 'f', place: 6, chips: 0, status: 'out' },
  ],
  deal: { enabled: false, open: false, done: null },
  ...over,
});

describe('moje pozice v turnaji', () => {
  it('před bublinou ukáže, kolik hráčů zbývá vyřadit do peněz', () => {
    expect(positionText(tour(), 'c')).toBe('Jste 3. z 4 · do peněz 2');
  });
  it('v penězích to řekne', () => {
    expect(positionText(tour({ alive: 2, standings: tour().standings.map((p) => (p.userId === 'c' || p.userId === 'd' ? { ...p, status: 'out' } : p)) }), 'a')).toBe('Jste 1. z 2 · jste v penězích');
  });
  it('vyřazený hráč vidí své konečné místo', () => {
    expect(positionText(tour(), 'e')).toBe('Vyřazen na 5. místě');
  });
  it('mimo běžící turnaj nebo pro cizího hráče nic neukazuje', () => {
    expect(positionText(tour({ status: 'finished' }), 'a')).toBeNull();
    expect(positionText(tour(), 'nikdo')).toBeNull();
    expect(positionText(null, 'a')).toBeNull();
  });
});

describe('odměny na hlavu', () => {
  const seat = (n: number, name: string, wanted?: number) => ({ seat: n, playerId: `p${n}`, name, wanted }) as unknown as TableView['seats'][number];
  it('seřadí hledané hráče podle odměny a ostatní vynechá', () => {
    const view = { seats: [seat(0, 'A', 50), seat(1, 'B'), seat(2, 'C', 200), seat(3, 'D', 0)] } as unknown as TableView;
    expect(wantedList(view)).toEqual([
      { seat: 2, name: 'C', amount: 200 },
      { seat: 0, name: 'A', amount: 50 },
    ]);
  });
});

describe('rebuy, add-on a re-entry u stolu', () => {
  const kinds = (x: ReturnType<typeof entryActions>) => x.map((a) => `${a.kind}:${a.active ? 'on' : 'off'}`);
  it('tlačítka jsou v turnaji s danou funkcí stále na místě; aktivní jsou jen ta, která hráč smí', () => {
    expect(kinds(entryActions(tour()))).toEqual(['rebuy:off', 'addon:off']);
    const me = { status: 'deciding', decideUntil: 1, canRebuy: true, canAddon: false, canReenter: true };
    expect(kinds(entryActions(tour({ me, reentry: { enabled: true } })))).toEqual(['rebuy:on', 'addon:off', 'reenter:on']);
    expect(kinds(entryActions(tour({ me: { ...me, canAddon: true }, reentry: { enabled: true } })))).toEqual(['rebuy:on', 'addon:on', 'reenter:on']);
  });
  it('po skončení turnaje jsou všechna neaktivní, divák a chybějící turnaj je nemají', () => {
    const me = { status: 'deciding', decideUntil: 1, canRebuy: true, canAddon: true, canReenter: true };
    expect(entryActions(tour({ me, status: 'finished', reentry: { enabled: true } })).every((a) => !a.active)).toBe(true);
    expect(entryActions(tour({ me: { ...me, status: null } }))).toEqual([]);
    expect(entryActions(null)).toEqual([]);
  });
  it('popisky nesou cenu (re-entry buy-in + poplatek)', () => {
    const me = { status: 'deciding', decideUntil: 1, canRebuy: true, canAddon: true, canReenter: true };
    expect(entryActions(tour({ me, reentry: { enabled: true } })).map((a) => a.label)).toEqual(['Rebuy (100)', 'Add-on (50)', 'Vstoupit znovu (110)']);
  });
});
