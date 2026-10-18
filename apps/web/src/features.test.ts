import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '@kb/shared';
import { featuresOf, type Features } from './features';

const reg = createDefaultRegistry();
const defaults = reg.defaults() as Record<string, unknown>;

/** Který klíč nastavení vypíná kterou funkci. */
const SWITCH: Record<keyof Features, string[]> = {
  polls: ['poll.enabled'],
  chat: ['chat.enabled'],
  shop: ['cosmetics.enabled', 'cosmetics.shopEnabled'],
  xp: ['xp.enabled'],
  rating: ['rating.enabled'],
  bets: ['bets.enabled'],
  headBounty: ['headBounty.enabled'],
  evenings: ['evening.enabled'],
  liveCash: ['liveCash.enabled'],
  shareHands: ['hands.shareEnabled'],
  limits: ['limits.enabled'],
  assistant: ['assistant.enabled'],
};

describe('vypínatelné funkce', () => {
  it('všechny klíče, které funkce vypínají, existují v nastavení', () => {
    for (const keys of Object.values(SWITCH)) for (const k of keys) expect(k in defaults, k).toBe(true);
  });

  it('s výchozím nastavením je vše zapnuté kromě živého cashe', () => {
    const f = featuresOf(defaults);
    for (const [name, on] of Object.entries(f)) expect(on, name).toBe(name !== 'liveCash');
  });

  for (const [name, keys] of Object.entries(SWITCH) as [keyof Features, string[]][]) {
    for (const key of keys) {
      if (name === 'liveCash') continue;
      it(`${key}=false vypne „${name}“ a nic jiného`, () => {
        const f = featuresOf({ ...defaults, [key]: false });
        expect(f[name]).toBe(false);
        for (const [other, on] of Object.entries(f)) if (other !== name && other !== 'liveCash') expect(on, other).toBe(true);
      });
    }
  }

  it('živý cash se zapíná až výslovně', () => {
    expect(featuresOf({ ...defaults, 'liveCash.enabled': true }).liveCash).toBe(true);
    expect(featuresOf({ ...defaults, 'liveCash.enabled': false }).liveCash).toBe(false);
  });
});
