import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../settings/definitions/index.js';
import { resolveSettings } from '../settings/resolve.js';
import { estimateTournament } from './estimate.js';

const reg = createDefaultRegistry();
const settings = (over: Record<string, number | boolean | string>) => resolveSettings(reg, [{ scope: 'global', values: { 'tournament.startingStack': 1500, ...over } }]).values;

describe('odhad délky turnaje', () => {
  it('domácí turnaj 9 × 1500 s 15min levely trvá zhruba 2 hodiny', () => {
    const base = settings({ 'tournament.levelMinutes': 15, 'tournament.structure': '25/50, 50/100, 75/150, 100/200, 150/300, 200/400, 300/600, 400/800, 500/1000, 600/1200' });
    const e = estimateTournament(base, { players: 9 });
    // 13 500 žetonů → konec kolem BB 675 (level 7)
    expect(e.minutes).toBeGreaterThan(95);
    expect(e.minutes!).toBeLessThan(140);
    expect(e.levels).toBe(7);
    expect(e.range![0]).toBeLessThan(e.minutes!);
    expect(e.range![1]).toBeGreaterThan(e.minutes!);
    // delší levely = úměrně delší turnaj; víc hráčů = delší turnaj
    expect(estimateTournament({ ...base, 'tournament.levelMinutes': 30 }, { players: 9 }).minutes).toBe(e.minutes! * 2);
    expect(estimateTournament(base, { players: 4 }).minutes!).toBeLessThan(e.minutes!);
    // přestávky se připočítají
    expect(estimateTournament({ ...base, 'tournament.breakEveryLevels': 3, 'tournament.breakMinutes': 10 }, { players: 9 }).minutes).toBe(e.minutes! + 20);
  });

  it('bez struktury se použije vygenerovaná podle cílové délky; rozbitá struktura = bez odhadu', () => {
    const base = settings({ 'tournament.levelMinutes': 15, 'tournament.structure': '', 'tournament.targetMinutes': 120 });
    const gen = estimateTournament(base, { players: 9 });
    expect(gen.minutes).toBeGreaterThan(70);
    expect(gen.minutes!).toBeLessThan(130);
    expect(estimateTournament({ ...base, 'tournament.structure': 'xx' }, { players: 9 }).minutes).toBeNull();
  });
});
