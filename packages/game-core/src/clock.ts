/** Zdroj času a časovačů. Časovače hry běží na serveru; testy dostávají FakeClock. */
export interface Clock {
  now(): number;
  /** Naplánuje funkci; vrací funkci pro zrušení. */
  setTimeout(fn: () => void, ms: number): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};

export class FakeClock implements Clock {
  private t = 1_000_000;
  private queue: { at: number; id: number; fn: () => void }[] = [];
  private nextId = 1;

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.queue.push({ at: this.t + Math.max(0, ms), id, fn });
    return () => {
      this.queue = this.queue.filter((q) => q.id !== id);
    };
  }
  /** Posune čas a spustí všechny časovače, které mezitím vypršely (i ty, co vzniknou při běhu). */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0];
      if (!next || next.at > target) break;
      this.queue.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = target;
  }
  pending(): number {
    return this.queue.length;
  }
}
