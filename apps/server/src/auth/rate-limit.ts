/** Jednoduché okno pokusů v paměti (přihlášení, žádosti o e-mail). */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();

  constructor(private now: () => number = Date.now) {}

  private recent(key: string, windowMs: number): number[] {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Zapíše pokus. */
  record(key: string, windowMs: number): void {
    const list = this.recent(key, windowMs);
    list.push(this.now());
    this.hits.set(key, list);
  }

  count(key: string, windowMs: number): number {
    return this.recent(key, windowMs).length;
  }

  /** Zbývá do uvolnění (ms), nebo 0. */
  lockedFor(key: string, max: number, windowMs: number): number {
    const list = this.recent(key, windowMs);
    if (list.length < max) return 0;
    return Math.max(0, windowMs - (this.now() - list[list.length - max]!));
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}
