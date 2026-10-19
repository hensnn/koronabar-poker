import { describe, expect, it } from 'vitest';
import type { SeatView, TableView } from '@kb/game-core';
import { playerFacts } from './PlayerCard';
import type { TournamentInfo } from './InfoCard';

const seat = { seat: 1, playerId: 'u1', name: 'Anna', stack: 1500, status: 'active', sitOut: false } as unknown as SeatView;
const cash = { info: { tournament: false, bigBlind: 20, currencySymbol: 'Kč', chipsPerCurrencyUnit: 1 } } as unknown as TableView;
const trn = { info: { tournament: true, bigBlind: 20, currencySymbol: 'Kč', chipsPerCurrencyUnit: 1 } } as unknown as TableView;
const tour = (over: Partial<TournamentInfo> = {}) =>
  ({
    alive: 5,
    rebuy: { enabled: true, cost: 100, chips: 1000, max: 3, untilLevel: 4 },
    addon: { enabled: true, cost: 50, chips: 500 },
    levelNumber: 2,
    standings: [{ userId: 'u1', place: 2, chips: 1500, status: 'playing', entries: 2, rebuys: 1, addon: true, head: 100, bounty: 50 }],
    ...over,
  }) as unknown as TournamentInfo;
const labels = (rows: { label: string }[]) => rows.map((r) => r.label);

describe('karta hráče (hover u stolu)', () => {
  it('cash: žetony a velikost stacku v big blindech', () => {
    const rows = playerFacts(seat, cash, null, false);
    expect(rows.find((r) => r.label.includes('blind'))!.value).toBe('75.0 BB');
  });

  it('turnaj: pořadí, zbývající rebuy, add-on, vstupy a odměny', () => {
    const rows = playerFacts(seat, trn, tour(), false);
    const text = rows.map((r) => `${r.label}: ${r.value}`).join(' | ');
    expect(text).toContain('2. / 5');
    expect(text).toContain('1 z 3 (zbývá 2)');
    expect(text).toContain('využit');
    expect(labels(rows)).toContain('Vstupů');
    expect(labels(rows)).toContain('Odměna na hlavě');
    expect(labels(rows)).toContain('Získané bounty');
  });

  it('po konci rebuy se ukáže „už nelze“, bez rebuy se řádek vynechá', () => {
    const closed = playerFacts(seat, trn, tour({ levelNumber: 6 }), false).find((r) => r.label === 'Rebuy')!;
    expect(closed.value).toContain('už nelze');
    expect(labels(playerFacts(seat, trn, tour({ rebuy: { enabled: false, cost: 0, chips: 0 } }), false))).not.toContain('Rebuy');
  });
});
