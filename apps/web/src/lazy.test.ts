import { describe, expect, it } from 'vitest';
import { loadWithRetry, RELOAD_FLAG } from './lazy';

const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), map: m };
};

describe('líné načtení stránky po nasazení nové verze', () => {
  it('první selhání importu stránku jednou obnoví a poznamená si to', async () => {
    const storage = memStorage();
    let reloads = 0;
    const p = loadWithRetry(() => Promise.reject(new Error('404')), { storage, reload: () => reloads++ });
    // Slib se nikdy nevyřeší (stránka se obnovuje); stačí ověřit vedlejší účinky.
    await Promise.race([p, new Promise((r) => setTimeout(r, 10))]);
    expect(reloads).toBe(1);
    expect(storage.getItem(RELOAD_FLAG)).toBe('1');
  });

  it('druhé selhání po obnovení už chybu propustí (žádná smyčka obnovování)', async () => {
    const storage = memStorage();
    storage.setItem(RELOAD_FLAG, '1');
    let reloads = 0;
    await expect(loadWithRetry(() => Promise.reject(new Error('404')), { storage, reload: () => reloads++ })).rejects.toThrow('404');
    expect(reloads).toBe(0);
  });

  it('úspěšné načtení příznak smaže, aby příští nasazení zase smělo obnovit', async () => {
    const storage = memStorage();
    storage.setItem(RELOAD_FLAG, '1');
    const m = await loadWithRetry(() => Promise.resolve({ Page: 1 }), { storage, reload: () => undefined });
    expect(m).toEqual({ Page: 1 });
    expect(storage.getItem(RELOAD_FLAG)).toBeNull();
  });

  it('bez úložiště se neobnovuje (nešlo by poznat smyčku) a chyba se propustí', async () => {
    let reloads = 0;
    await expect(loadWithRetry(() => Promise.reject(new Error('x')), { storage: null, reload: () => reloads++ })).rejects.toThrow('x');
    expect(reloads).toBe(0);
  });
});
