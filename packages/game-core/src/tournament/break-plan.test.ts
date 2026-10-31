import { describe, expect, it } from 'vitest';
import { nextBreakPlan, type BreakPlanInput } from './break-plan.js';

const base: BreakPlanInput = { every: 4, repeat: true, levelNumber: 2, onBreak: false, mode: 'time', levelMinutes: 15, levelHands: 10, handsInLevel: 0, clockMs: 600_000, breakMinutes: 10 };

describe('plánovaná přestávka', () => {
  it('po každých N levelech: čas do začátku = zbytek levelu + další levely', () => {
    expect(nextBreakPlan(base)).toEqual({ afterLevel: 4, levelsLeft: 3, inMs: 600_000 + 2 * 15 * 60_000, handsLeft: null, minutes: 10 });
    expect(nextBreakPlan({ ...base, levelNumber: 4, clockMs: 120_000 })).toEqual({ afterLevel: 4, levelsLeft: 1, inMs: 120_000, handsLeft: null, minutes: 10 });
    expect(nextBreakPlan({ ...base, levelNumber: 5 })!.afterLevel).toBe(8);
  });
  it('jen jednou: po N-tém levelu, pak už žádná', () => {
    expect(nextBreakPlan({ ...base, repeat: false })!.afterLevel).toBe(4);
    expect(nextBreakPlan({ ...base, repeat: false, levelNumber: 5 })).toBeNull();
  });
  it('bez přestávek, během přestávky nebo s nulovou délkou nic', () => {
    expect(nextBreakPlan({ ...base, every: 0 })).toBeNull();
    expect(nextBreakPlan({ ...base, onBreak: true })).toBeNull();
    expect(nextBreakPlan({ ...base, breakMinutes: 0 })).toBeNull();
  });
  it('levely podle hand: počet hand do přestávky, čas neznámý; neběžící hodiny dají čas null', () => {
    expect(nextBreakPlan({ ...base, mode: 'hands', handsInLevel: 3 })).toEqual({ afterLevel: 4, levelsLeft: 3, inMs: null, handsLeft: 7 + 20, minutes: 10 });
    expect(nextBreakPlan({ ...base, clockMs: null })!.inMs).toBeNull();
  });
});
