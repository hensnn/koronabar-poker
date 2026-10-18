import { describe, expect, it } from 'vitest';
import type { TableView } from '@kb/game-core';
import { parseState as parseLeft, WIDGETS } from './TablePanel';
import { parseState as parseRight, SIDE_WIDGETS } from './SidePanel';
import { positionText, wantedList, type TournamentInfo } from './InfoCard';


const tour = (over: Partial<TournamentInfo> = {}): TournamentInfo => ({
  status: 'running',
  prizePool: 600,
  players: 6,
  alive: 4,
  payouts: [{ place: 1, amount: 400 }, { place: 2, amount: 200 }],
  bounty: { type: 'none', percent: 0, pkoCash: 0, bank: 0 },
  rebuy: { enabled: false },
  addon: { enabled: false },
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

describe('levý panel: uložený stav', () => {
  it('prázdné nastavení dá všechny widgety ve výchozím pořadí', () => {
    expect(parseLeft('').order).toEqual([...WIDGETS]);
  });
  it('neznámé widgety z dřívějších verzí (např. samostatné hodiny) se zahodí, nové se zařadí na své místo', () => {
    const s = parseLeft(JSON.stringify({ order: ['clock', 'plan', 'players'], hidden: ['clock', 'sounds'], collapsed: ['hand', 'nic'] }));
    expect(s.order).not.toContain('clock' as never);
    expect(s.hidden).toEqual(['sounds']);
    expect(s.collapsed).toEqual(['hand']);
    expect([...s.order].sort()).toEqual([...WIDGETS].sort());
    expect(s.order.indexOf('table')).toBeLessThan(s.order.indexOf('plan') + 1);
  });
  it('rozbitý JSON nespadne', () => {
    expect(parseLeft('{nesmysl').order).toEqual([...WIDGETS]);
  });
});

describe('pravý panel: uložený stav', () => {
  it('výchozí pořadí: o hře, odměny, dohoda, akce', () => {
    expect(parseRight('').order).toEqual(['info', 'bounties', 'deal', 'tools']);
    expect([...SIDE_WIDGETS]).toEqual(['info', 'bounties', 'deal', 'tools']);
  });
  it('uložené pořadí a skryté widgety se zachovají, chybějící se doplní', () => {
    const s = parseRight(JSON.stringify({ order: ['tools', 'info'], hidden: ['deal'], collapsed: ['info'] }));
    expect(s.order).toEqual(['tools', 'info', 'bounties', 'deal']);
    expect(s.hidden).toEqual(['deal']);
    expect(s.collapsed).toEqual(['info']);
  });
  it('rozbitý JSON nespadne', () => {
    expect(parseRight('[').order).toEqual([...SIDE_WIDGETS]);
  });
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
