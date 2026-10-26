import { beforeEach, describe, expect, it, vi } from 'vitest';

// Síť nahrazena: GET vrací se zpožděním, které lze ručně vyřešit.
const pendingGets: Array<(v: unknown) => void> = [];
vi.mock('./api', () => ({
  get: (url: string) =>
    new Promise((resolve) => {
      pendingGets.push((v) => resolve(v));
      void url;
    }),
  put: async () => ({}),
  del: async () => ({}),
}));
vi.mock('./net', () => ({ onSocket: () => () => undefined }));

const localStore = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: (k: string) => localStore.get(k) ?? null, setItem: (k: string, v: string) => localStore.set(k, v), removeItem: (k: string) => localStore.delete(k) },
});
Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => 'abcdefgh-1234' } });

describe('settings store', () => {
  beforeEach(() => {
    pendingGets.length = 0;
  });

  it('pomalá odpověď načtení nepřepíše změnu uloženou mezitím', async () => {
    const s = await import('./settings');
    const load = s.loadSettings();
    // Hráč mezitím vypne zvuky (optimistická změna, PUT proběhne hned).
    await s.saveUserSetting('sounds.play', false);
    // Teprve teď doběhne starý GET s původní hodnotou.
    pendingGets[0]!({ user: { 'sounds.play': true }, device: {} });
    pendingGets[1]!({ values: {} });
    await load;
    expect(s.resolveFor().values['sounds.play']).toBe(false);
  });

  it('běžné načtení převezme hodnoty ze serveru', async () => {
    const s = await import('./settings');
    const load = s.loadSettings();
    pendingGets[0]!({ user: { 'sounds.play': true, 'ui.showInBb': true }, device: {} });
    pendingGets[1]!({ values: {} });
    await load;
    expect(s.resolveFor().values['ui.showInBb']).toBe(true);
    expect(s.resolveFor().values['sounds.play']).toBe(true);
  });
});

describe('hodnota pro všechna zařízení a starší hodnota jen pro zařízení', () => {
  it('uložení do účtu přebije starší hodnotu stejného klíče uloženou pro zařízení (jinak by změna nebyla vidět)', async () => {
    const s = await import('./settings');
    const load = s.loadSettings();
    pendingGets[pendingGets.length - 2]!({ user: {}, device: { 'ui.tableLayout': '{"left":["table"],"right":[],"hidden":[],"collapsed":[],"hiddenSides":[]}' } });
    pendingGets[pendingGets.length - 1]!({ values: {} });
    await load;
    expect(String(s.resolveFor().values['ui.tableLayout'])).toContain('"collapsed":[]');
    const next = '{"left":["table"],"right":[],"hidden":[],"collapsed":["players"],"hiddenSides":[]}';
    await s.saveUserSetting('ui.tableLayout', next);
    expect(s.resolveFor().values['ui.tableLayout']).toBe(next);
  });
});
