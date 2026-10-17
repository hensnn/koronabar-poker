import { DEFAULT_POLL_CONFIG, tally, type Answer, type Ballot, type PollConfig, type Voter } from '@kb/shared';
import type { Clock } from './clock.js';

/**
 * Herní hlasování ano/ne o návrhu (deal, run it twice, pauza…). Rozhodování (většina, předčasné ukončení)
 * počítá společný engine anket z `@kb/shared`; tato třída přidává časovač, uložení stavu a obsluhu po rozhodnutí.
 * Pravidla se zadávají při návrhu: kdo hlasuje, váhy, kolik je potřeba k přijetí (jednomyslně, většina,
 * procentní práh), časový limit (kdo neodpoví, nesouhlasí) a zda jsou hlasy tajné.
 * Stav je čistá data (jde uložit do DB); funkce, které se po rozhodnutí zavolají, se hledají podle druhu hlasování.
 */

export type VoteThreshold = { type: 'unanimous' } | { type: 'majority' } | { type: 'percent'; percent: number };
export type VoteStatus = 'open' | 'passed' | 'rejected' | 'expired' | 'cancelled';

export interface VoteState {
  id: string;
  kind: string;
  proposer: string | null;
  voters: string[];
  weights: Record<string, number>;
  threshold: VoteThreshold;
  /** Absolutní čas konce podle hodin (ms). */
  deadline: number;
  secret: boolean;
  votes: Record<string, boolean>;
  status: VoteStatus;
  /** Data návrhu (např. částky dealu). Vždy čisté JSON. */
  payload: unknown;
  createdAt: number;
  decidedAt: number | null;
}

export class VoteError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'NOT_VOTER' | 'CLOSED' | 'ALREADY_OPEN' | 'INVALID') {
    super(code);
  }
}

export interface ProposeInput {
  kind: string;
  proposer?: string | null;
  voters: string[];
  weights?: Record<string, number>;
  threshold?: VoteThreshold;
  timeoutMs: number;
  secret?: boolean;
  payload?: unknown;
  /** Navrhovatel automaticky souhlasí (výchozí ano, je-li mezi hlasujícími). */
  proposerAgrees?: boolean;
}

export type VoteHandler = (state: VoteState) => void;

/** Veřejný pohled na hlasování. U tajných hlasování se do rozhodnutí neukazují jednotlivé hlasy. */
export interface VoteView {
  id: string;
  kind: string;
  proposer: string | null;
  status: VoteStatus;
  deadline: number;
  secret: boolean;
  threshold: VoteThreshold;
  payload: unknown;
  voters: { userId: string; vote: boolean | null; voted: boolean }[];
  myVote: boolean | null;
  canVote: boolean;
  /** Součty: u tajného otevřeného hlasování jen počet odevzdaných hlasů. */
  tally: { yes: number | null; no: number | null; voted: number; total: number };
}

/**
 * Převod pravidel herního hlasování na nastavení společného enginu anket (`@kb/shared`): rozhodování, většinu
 * i předčasné ukončení tak počítá jedna implementace pro herní hlasování i pro ankety.
 * Kdo neodpoví, nesouhlasí; jednomyslně = všichni ano; většina = nadpoloviční ze všech vah; procento se
 * počítá ze všech vah (nehlasující jako „ne“).
 */
export function pollConfigOf(v: Pick<VoteState, 'threshold' | 'secret'>): PollConfig {
  const t = v.threshold;
  return {
    ...DEFAULT_POLL_CONFIG,
    type: 'yesno',
    threshold: t.type === 'unanimous' ? { kind: 'unanimous' } : t.type === 'majority' ? { kind: 'majorityOfAll' } : { kind: 'percent', percent: t.percent },
    nonVoters: 'no',
    anonymity: v.secret ? 'secret' : 'public',
    earlyClose: true,
    allowChange: true,
  };
}

export class Voting {
  private votes = new Map<string, VoteState>();
  private timers = new Map<string, () => void>();
  private seq = 0;

  constructor(
    private deps: {
      clock: Clock;
      handlers: Record<string, VoteHandler>;
      /** Změna stavu (rozeslání klientům a uložení). */
      onChange?: (state: VoteState) => void;
      idPrefix?: string;
    },
  ) {}

  /** Obnova po restartu: otevřená hlasování znovu rozběhnou časovač (uplynulé se vyhodnotí hned). */
  restore(states: VoteState[]): void {
    for (const s of states) {
      this.votes.set(s.id, structuredClone(s));
      const n = Number(s.id.split(':').pop());
      if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
      if (s.status === 'open') this.arm(s.id);
    }
  }

  all(): VoteState[] {
    return [...this.votes.values()].map((v) => structuredClone(v));
  }

  get(id: string): VoteState | undefined {
    const v = this.votes.get(id);
    return v ? structuredClone(v) : undefined;
  }

  /** Otevřené hlasování daného druhu (nebo jakékoli). */
  active(kind?: string): VoteState | undefined {
    for (const v of this.votes.values()) if (v.status === 'open' && (!kind || v.kind === kind)) return structuredClone(v);
    return undefined;
  }

  propose(input: ProposeInput): VoteState {
    if (input.voters.length === 0 || input.timeoutMs <= 0) throw new VoteError('INVALID');
    const voters = [...new Set(input.voters)];
    const weights: Record<string, number> = {};
    for (const v of voters) weights[v] = Math.max(0, input.weights?.[v] ?? 1);
    const now = this.deps.clock.now();
    const state: VoteState = {
      id: `${this.deps.idPrefix ?? 'v'}:${++this.seq}`,
      kind: input.kind,
      proposer: input.proposer ?? null,
      voters,
      weights,
      threshold: input.threshold ?? { type: 'unanimous' },
      deadline: now + input.timeoutMs,
      secret: !!input.secret,
      votes: {},
      status: 'open',
      payload: input.payload ?? null,
      createdAt: now,
      decidedAt: null,
    };
    if (input.proposer && voters.includes(input.proposer) && input.proposerAgrees !== false) state.votes[input.proposer] = true;
    this.votes.set(state.id, state);
    this.arm(state.id);
    this.evaluate(state.id, false);
    this.changed(state.id);
    return structuredClone(this.votes.get(state.id)!);
  }

  vote(id: string, userId: string, yes: boolean): VoteState {
    const v = this.votes.get(id);
    if (!v) throw new VoteError('NOT_FOUND');
    if (v.status !== 'open') throw new VoteError('CLOSED');
    if (!v.voters.includes(userId)) throw new VoteError('NOT_VOTER');
    v.votes[userId] = yes;
    this.evaluate(id, false);
    this.changed(id);
    return structuredClone(v);
  }

  cancel(id: string): void {
    const v = this.votes.get(id);
    if (!v || v.status !== 'open') return;
    this.close(v, 'cancelled');
    this.changed(id);
  }

  /** Zruší všechna otevřená hlasování (např. změnily se podmínky). */
  cancelAll(kind?: string): void {
    for (const v of this.votes.values()) if (v.status === 'open' && (!kind || v.kind === kind)) this.cancel(v.id);
  }

  /** Hlasující, který přestal být způsobilý (odešel od stolu, vypadl): hlasování se přepočítá bez něj. */
  removeVoter(id: string, userId: string): void {
    const v = this.votes.get(id);
    if (!v || v.status !== 'open' || !v.voters.includes(userId)) return;
    v.voters = v.voters.filter((x) => x !== userId);
    delete v.votes[userId];
    delete v.weights[userId];
    if (v.voters.length === 0) this.close(v, 'cancelled');
    else this.evaluate(id, false);
    this.changed(id);
  }

  stop(): void {
    for (const c of this.timers.values()) c();
    this.timers.clear();
  }

  view(id: string, viewerId: string | null): VoteView | undefined {
    const v = this.votes.get(id);
    if (!v) return undefined;
    const open = v.status === 'open';
    const hide = v.secret && open;
    const yes = v.voters.filter((u) => v.votes[u] === true).length;
    const no = v.voters.filter((u) => v.votes[u] === false).length;
    return {
      id: v.id,
      kind: v.kind,
      proposer: v.proposer,
      status: v.status,
      deadline: v.deadline,
      secret: v.secret,
      threshold: v.threshold,
      payload: v.payload,
      voters: v.voters.map((u) => ({ userId: u, voted: u in v.votes, vote: hide ? (u === viewerId ? (v.votes[u] ?? null) : null) : (v.votes[u] ?? null) })),
      myVote: viewerId && viewerId in v.votes ? v.votes[viewerId]! : null,
      canVote: open && !!viewerId && v.voters.includes(viewerId),
      tally: { yes: hide ? null : yes, no: hide ? null : no, voted: yes + no, total: v.voters.length },
    };
  }

  // ---------- vnitřní logika ----------

  private arm(id: string): void {
    this.timers.get(id)?.();
    const v = this.votes.get(id);
    if (!v || v.status !== 'open') return;
    const wait = Math.max(0, v.deadline - this.deps.clock.now());
    this.timers.set(
      id,
      this.deps.clock.setTimeout(() => {
        this.timers.delete(id);
        this.evaluate(id, true);
        this.changed(id);
      }, wait),
    );
  }

  /** Vyhodnotí hlasování společným enginem: přijato, předčasně zamítnuto (už nejde dosáhnout), nebo po vypršení. */
  private evaluate(id: string, timeUp: boolean): void {
    const v = this.votes.get(id);
    if (!v || v.status !== 'open') return;
    const voters: Voter[] = v.voters.map((u) => ({ userId: u, weight: v.weights[u] ?? 0 }));
    const ballots: Ballot[] = v.voters.filter((u) => u in v.votes).map((u) => ({ userId: u, answer: { type: 'yesno', value: v.votes[u] ? 'yes' : 'no' } satisfies Answer }));
    const res = tally(pollConfigOf(v), voters, ballots, false);
    if (res.final) return this.close(v, res.outcome === 'passed' ? 'passed' : 'rejected');
    if (timeUp) this.close(v, 'expired');
  }

  private close(v: VoteState, status: Exclude<VoteStatus, 'open'>): void {
    v.status = status;
    v.decidedAt = this.deps.clock.now();
    this.timers.get(v.id)?.();
    this.timers.delete(v.id);
    this.deps.handlers[v.kind]?.(structuredClone(v));
  }

  private changed(id: string): void {
    const v = this.votes.get(id);
    if (v) this.deps.onChange?.(structuredClone(v));
  }
}
