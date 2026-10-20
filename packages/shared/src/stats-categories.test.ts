import { describe, expect, it } from 'vitest';
import { buildCategories, type CategoryPlayer } from './stats-categories.js';

const p = (userId: string, o: Partial<CategoryPlayer> = {}): CategoryPlayer => ({ userId, nickname: userId, total: 0, tournamentNet: 0, cashNet: 0, balance: 0, xp: 0, ratingTournament: null, ratingCash: null, hands: 0, games: 0, wins: 0, itm: 0, avgPlace: null, bounty: 0, ...o });

describe('kategorie: kdo je v čem nejlepší', () => {
  const players = [
    p('A', { total: 300, tournamentNet: 300, games: 4, wins: 2, itm: 3, avgPlace: 2.1, xp: 900, balance: 50 }),
    p('B', { total: 100, tournamentNet: -50, cashNet: 150, games: 1, wins: 1, itm: 1, avgPlace: 1, hands: 80, balance: 400 }),
    p('C', { games: 6, wins: 0, itm: 1, avgPlace: 4.5, ratingTournament: 1480 }),
  ];
  const by = (id: string, minGames = 3) => buildCategories(players, { minGames, top: 5 }).find((c) => c.id === id);
  it('řadí podle směru kategorie', () => {
    expect(by('total')!.entries.map((e) => e.userId)).toEqual(['A', 'B', 'C']);
    expect(by('avgPlace')!.entries.map((e) => e.userId)).toEqual(['A', 'C']); // nižší je lepší
    expect(by('balance')!.entries[0]!.userId).toBe('B');
  });
  it('podíly se počítají jen od minima turnajů (B s jedním turnajem se mezi nimi nehodnotí)', () => {
    expect(by('winRate')!.entries.map((e) => [e.userId, e.value])).toEqual([['A', 50], ['C', 0]]);
    expect(by('winRate', 1)!.entries[0]).toMatchObject({ userId: 'B', value: 100 });
  });
  it('prázdné kategorie se vynechají a počet je omezený', () => {
    expect(by('bounty')).toBeUndefined();
    expect(by('ratingCash')).toBeUndefined();
    expect(buildCategories(players, { minGames: 3, top: 1 }).every((c) => c.entries.length === 1)).toBe(true);
  });
});
