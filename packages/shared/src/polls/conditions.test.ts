import { describe, expect, it } from 'vitest';
import { eligibleOf, EVERYONE, matches, validatePollCondition, type PlayerProfile, type PollCondition } from './conditions.js';

const profile = (over: Partial<PlayerProfile> = {}): PlayerProfile => ({
  userId: 'u1',
  online: true,
  tableIds: [],
  tournamentIds: [],
  aliveTournamentIds: [],
  registeredTournamentIds: [],
  channelIds: [],
  roleKeys: ['hrac'],
  maxPower: 10,
  level: 5,
  rankName: 'Štamgast',
  division: 'Bronz',
  ratingTournament: { value: 1600, provisional: false },
  ratingCash: null,
  accountAgeDays: 100,
  daysSinceActive: 2,
  activity: { handsTotal: 500, gamesTotal: 20, handsSeason: 100, gamesSeason: 5, handsInLast: (d) => (d >= 30 ? 80 : 10), gamesInLast: () => 3 },
  seriesIds: ['s1'],
  leaderboardRank: 4,
  tournamentWins: 2,
  balance: 1000,
  ...over,
});

const all = (...children: PollCondition[]): PollCondition => ({ type: 'group', mode: 'all', children });
const any = (...children: PollCondition[]): PollCondition => ({ type: 'group', mode: 'any', children });

describe('podmínky hlasování', () => {
  it('prázdná skupina platí pro všechny, prázdné „nebo“ pro nikoho', () => {
    expect(matches(EVERYONE, profile())).toBe(true);
    expect(matches(any(), profile())).toBe(false);
  });

  it('přítomnost: online, u stolu, v turnaji (i jen nevyřazení), v kanálu, registrovaný', () => {
    const p = profile({ tableIds: ['t1'], tournamentIds: ['x'], aliveTournamentIds: [], channelIds: ['c1'], registeredTournamentIds: ['r1'] });
    expect(matches({ type: 'online' }, p)).toBe(true);
    expect(matches({ type: 'online' }, profile({ online: false }))).toBe(false);
    expect(matches({ type: 'atTable', id: 't1' }, p)).toBe(true);
    expect(matches({ type: 'atTable', id: 't2' }, p)).toBe(false);
    expect(matches({ type: 'inTournament', id: 'x' }, p)).toBe(true);
    expect(matches({ type: 'inTournament', id: 'x', aliveOnly: true }, p)).toBe(false);
    expect(matches({ type: 'inChannel', id: 'c1' }, p)).toBe(true);
    expect(matches({ type: 'registered', id: 'r1' }, p)).toBe(true);
  });

  it('role, síla role, level, hodnost, divize', () => {
    const p = profile();
    expect(matches({ type: 'role', keys: ['moderator', 'hrac'] }, p)).toBe(true);
    expect(matches({ type: 'role', keys: ['admin'] }, p)).toBe(false);
    expect(matches({ type: 'minPower', min: 10 }, p)).toBe(true);
    expect(matches({ type: 'minPower', min: 11 }, p)).toBe(false);
    expect(matches({ type: 'level', min: 5, max: 10 }, p)).toBe(true);
    expect(matches({ type: 'level', min: 6 }, p)).toBe(false);
    expect(matches({ type: 'rank', keys: ['Štamgast'] }, p)).toBe(true);
    expect(matches({ type: 'division', keys: ['Zlato'] }, p)).toBe(false);
  });

  it('rating: rozsah, druh, ne-provizorní', () => {
    const p = profile({ ratingTournament: { value: 1600, provisional: true } });
    expect(matches({ type: 'rating', scope: 'tournament', min: 1500, max: 1700 }, p)).toBe(true);
    expect(matches({ type: 'rating', scope: 'tournament', notProvisional: true }, p)).toBe(false);
    expect(matches({ type: 'rating', scope: 'cash', min: 0 }, p)).toBe(false); // cash rating nemá
  });

  it('aktivita: celkem, za sezónu, za posledních X dní; stáří účtu a poslední aktivita', () => {
    const p = profile();
    expect(matches({ type: 'activity', metric: 'hands', period: 'total', min: 500 }, p)).toBe(true);
    expect(matches({ type: 'activity', metric: 'games', period: 'season', min: 6 }, p)).toBe(false);
    expect(matches({ type: 'activity', metric: 'hands', period: 'days', days: 30, min: 50 }, p)).toBe(true);
    expect(matches({ type: 'activity', metric: 'hands', period: 'days', days: 7, min: 50 }, p)).toBe(false);
    expect(matches({ type: 'accountAge', min: 90 }, p)).toBe(true);
    expect(matches({ type: 'accountAge', max: 30 }, p)).toBe(false);
    expect(matches({ type: 'lastActive', days: 7 }, p)).toBe(true);
    expect(matches({ type: 'lastActive', days: 1 }, p)).toBe(false);
    expect(matches({ type: 'lastActive', days: 7 }, profile({ daysSinceActive: null }))).toBe(false);
  });

  it('výsledky: série, žebříček, výhry; konkrétní hráči; zůstatek', () => {
    const p = profile();
    expect(matches({ type: 'series', id: 's1' }, p)).toBe(true);
    expect(matches({ type: 'series', id: 's9' }, p)).toBe(false);
    expect(matches({ type: 'series' }, p)).toBe(true);
    expect(matches({ type: 'leaderboardTop', max: 10 }, p)).toBe(true);
    expect(matches({ type: 'leaderboardTop', max: 3 }, p)).toBe(false);
    expect(matches({ type: 'wins', min: 3 }, p)).toBe(false);
    expect(matches({ type: 'players', keys: ['u1', 'u2'] }, p)).toBe(true);
    expect(matches({ type: 'balance', min: 500, max: 2000 }, p)).toBe(true);
  });

  it('skládání A / NEBO / kromě', () => {
    const p = profile();
    expect(matches(all({ type: 'online' }, { type: 'level', min: 5 }), p)).toBe(true);
    expect(matches(all({ type: 'online' }, { type: 'level', min: 6 }), p)).toBe(false);
    expect(matches(any({ type: 'level', min: 6 }, { type: 'role', keys: ['hrac'] }), p)).toBe(true);
    // kromě konkrétních hráčů
    expect(matches(all({ type: 'online' }, { type: 'players', keys: ['u1'], not: true }), p)).toBe(false);
    expect(matches({ type: 'group', mode: 'any', not: true, children: [{ type: 'level', min: 6 }] }, p)).toBe(true);
  });

  it('živý výpis oprávněných', () => {
    const ps = [profile({ userId: 'a', level: 1 }), profile({ userId: 'b', level: 9 }), profile({ userId: 'c', level: 12, online: false })];
    expect(eligibleOf(all({ type: 'online' }, { type: 'level', min: 5 }), ps).map((x) => x.userId)).toEqual(['b']);
    expect(eligibleOf(EVERYONE, ps)).toHaveLength(3);
  });
});

describe('kontrola stromu podmínek', () => {
  it('přijme platný strom, odmítne špatné typy a parametry', () => {
    expect(validatePollCondition(all({ type: 'online' }, { type: 'level', min: 3 })).ok).toBe(true);
    expect(validatePollCondition({ type: 'nesmysl' })).toMatchObject({ ok: false, issue: { reason: 'type' } });
    expect(validatePollCondition({ type: 'atTable' })).toMatchObject({ ok: false, issue: { reason: 'param' } }); // chybí id stolu
    expect(validatePollCondition({ type: 'role', keys: [] })).toMatchObject({ ok: false });
    expect(validatePollCondition({ type: 'level', min: 'a' })).toMatchObject({ ok: false });
    expect(validatePollCondition({ type: 'group', mode: 'xor', children: [] })).toMatchObject({ ok: false });
    expect(validatePollCondition(null)).toMatchObject({ ok: false });
  });

  it('omezí hloubku a velikost stromu', () => {
    let deep: PollCondition = { type: 'online' };
    for (let i = 0; i < 8; i++) deep = all(deep);
    expect(validatePollCondition(deep)).toMatchObject({ ok: false, issue: { reason: 'depth' } });
    const wide = all(...Array.from({ length: 70 }, () => ({ type: 'online' }) as PollCondition));
    expect(validatePollCondition(wide)).toMatchObject({ ok: false, issue: { reason: 'size' } });
  });
});
