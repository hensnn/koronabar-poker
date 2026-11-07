import { describe, expect, it } from 'vitest';
import type { SeatView, TableView } from '@kb/game-core';
import { playerFacts, seatBounty } from './PlayerCard';
import type { BountyList, TournamentInfo } from './InfoCard';

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

describe('karta hráče: odměna na hlavu a její stav', () => {
  const list = (over: Partial<BountyList> = {}): BountyList => ({
    survivedRule: 'return',
    rows: [
      { targetId: 'u1', poster: 'Eva', amount: 200, status: 'open' },
      { targetId: 'u1', poster: 'Petr', amount: 100, status: 'open' },
      { targetId: 'u1', poster: 'Eva', amount: 50, status: 'open' },
      { targetId: 'u2', poster: 'Karel', amount: 999, status: 'open' },
    ],
    ...over,
  });

  it('součet, zadavatelé se sečtenými částkami a stav „čeká“', () => {
    const b = seatBounty(list(), 'u1')!;
    expect(b.total).toBe(350);
    expect(b.posters).toEqual([{ name: 'Eva', amount: 250 }, { name: 'Petr', amount: 100 }]);
    expect(b.status).toBe('open');
  });

  it('bez odměny na hráče je výsledek null (i bez seznamu)', () => {
    expect(seatBounty(list(), 'u3')).toBeNull();
    expect(seatBounty(null, 'u1')).toBeNull();
  });

  it('odměna čekající na vítěze má stav „připadne vítězi“', () => {
    const b = seatBounty(list({ rows: [{ targetId: 'u1', poster: 'Eva', amount: 100, status: 'pendingWinner' }] }), 'u1')!;
    expect(b.status).toBe('pendingWinner');
  });

  it('řádky karty: výše, kdo vypsal, stav a co se stane, když hráč přežije', () => {
    const rows = playerFacts(seat, trn, tour(), false, seatBounty(list({ survivedRule: 'winner' }), 'u1'));
    const text = rows.map((r) => `${r.label}: ${r.value}`).join(' | ');
    expect(text).toContain('Vypsaná odměna: 350');
    expect(text).toContain('Vypsal(i): Eva (250), Petr (100)');
    expect(text).toContain('Stav odměny: čeká');
    expect(text).toContain('Když hráč přežije: připadne vítězi turnaje');
  });

  it('jediný zadavatel je bez částky v závorce; u odměny čekající na vítěze se „když přežije“ nezobrazuje', () => {
    const rows = playerFacts(seat, trn, tour(), false, seatBounty({ survivedRule: 'return', rows: [{ targetId: 'u1', poster: 'Eva', amount: 100, status: 'pendingWinner' }] }, 'u1'));
    const text = rows.map((r) => `${r.label}: ${r.value}`).join(' | ');
    expect(text).toContain('Vypsal(i): Eva');
    expect(text).not.toContain('Eva (');
    expect(text).toContain('připadne vítězi turnaje');
    expect(labels(rows)).not.toContain('Když hráč přežije');
  });

  it('bez odměny se žádné řádky o odměně nepřidají', () => {
    expect(labels(playerFacts(seat, trn, tour(), false, null))).not.toContain('Stav odměny');
  });
});
