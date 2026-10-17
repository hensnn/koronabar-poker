/**
 * Engine anket a hlasování (čisté funkce): typy otázek, kontrola odpovědí, váhy, kvórum, potřebná většina,
 * řešení remízy a předčasné ukončení. Nezná databázi ani čas; vše dostává na vstupu.
 */

export const POLL_TYPES = ['yesno', 'single', 'multi', 'ranked', 'rating', 'schedule', 'text'] as const;
export type PollType = (typeof POLL_TYPES)[number];

export interface PollOption {
  id: string;
  label: string;
  emoji?: string;
  image?: string;
  /** Možnost přidal hlasující (ne zakladatel). */
  addedBy?: string;
  /** Termín (ms) u výběru termínu; podle vítězného termínu se může naplánovat turnaj. */
  at?: number;
  /** Hodnota pro navázanou akci (id šablony, id hráče, hodnota nastavení). */
  value?: string;
}

export type SlotAnswer = 'yes' | 'maybe' | 'no';

export type Answer =
  | { type: 'yesno'; value: 'yes' | 'no' | 'abstain' }
  | { type: 'single'; option: string }
  | { type: 'multi'; options: string[] }
  | { type: 'ranked'; order: string[] }
  | { type: 'rating'; scores: Record<string, number> }
  | { type: 'schedule'; slots: Record<string, SlotAnswer> }
  | { type: 'text'; text: string };

export const THRESHOLDS = ['simple', 'majorityOfAll', 'twoThirds', 'threeQuarters', 'unanimous', 'percent'] as const;
export type ThresholdKind = (typeof THRESHOLDS)[number];

export interface WeightRule {
  mode: 'equal' | 'byRole' | 'byLevel' | 'byRating' | 'byStack';
  /** byRole: klíč role → váha (chybějící role mají váhu 1). */
  table?: Record<string, number>;
  /** byLevel: každých `step` levelů přidá +1 k váze. */
  step?: number;
  /** Strop váhy jednoho hráče. */
  cap?: number;
}

export interface PollConfig {
  type: PollType;
  options: PollOption[];
  /** Vícenásobný výběr: minimum a maximum zvolených možností. */
  minChoices?: number;
  maxChoices?: number;
  /** Hodnocení: nejvyšší počet bodů (od 1). */
  ratingMax?: number;
  /** Hlasující smí přidat vlastní možnost. */
  allowAddOptions?: boolean;
  threshold: { kind: ThresholdKind; percent?: number };
  quorum: { kind: 'none' | 'count' | 'percent'; value?: number };
  /** Jak se počítají ti, kdo nehlasovali (jen ano/ne). */
  nonVoters: 'ignore' | 'no' | 'yes';
  tie: 'founder' | 'random' | 'extend' | 'role';
  anonymity: 'public' | 'anonymous' | 'secret';
  weights: WeightRule;
  allowChange: boolean;
  earlyClose: boolean;
}

export const DEFAULT_POLL_CONFIG: PollConfig = {
  type: 'yesno',
  options: [],
  threshold: { kind: 'simple' },
  quorum: { kind: 'none' },
  nonVoters: 'ignore',
  tie: 'founder',
  anonymity: 'public',
  weights: { mode: 'equal' },
  allowChange: true,
  earlyClose: true,
};

// ---------- kontrola konfigurace a odpovědí ----------

export type ConfigIssue = 'type' | 'options' | 'choices' | 'rating' | 'threshold' | 'quorum' | 'weights';

export function validateConfig(c: PollConfig): ConfigIssue | null {
  if (!POLL_TYPES.includes(c.type)) return 'type';
  const needsOptions = !['yesno', 'text'].includes(c.type);
  if (needsOptions) {
    const min = c.type === 'schedule' ? 1 : 2;
    if (c.options.length < min || c.options.length > 30) return 'options';
    const ids = new Set(c.options.map((o) => o.id));
    if (ids.size !== c.options.length || c.options.some((o) => !o.id || o.id.length > 40 || !o.label.trim() || o.label.length > 120)) return 'options';
  }
  if (c.type === 'multi') {
    const min = c.minChoices ?? 1;
    const max = c.maxChoices ?? c.options.length;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > c.options.length) return 'choices';
  }
  if (c.type === 'rating' && !(Number.isInteger(c.ratingMax) && c.ratingMax! >= 2 && c.ratingMax! <= 10)) return 'rating';
  if (!THRESHOLDS.includes(c.threshold.kind)) return 'threshold';
  if (c.threshold.kind === 'percent' && !(c.threshold.percent !== undefined && c.threshold.percent > 0 && c.threshold.percent <= 100)) return 'threshold';
  if (c.quorum.kind !== 'none' && !(c.quorum.value !== undefined && c.quorum.value > 0 && (c.quorum.kind === 'count' || c.quorum.value <= 100))) return 'quorum';
  if (c.weights.cap !== undefined && !(c.weights.cap >= 1)) return 'weights';
  if (c.weights.mode === 'byLevel' && !(c.weights.step !== undefined && c.weights.step >= 1)) return 'weights';
  return null;
}

export type AnswerIssue = 'type' | 'option' | 'count' | 'order' | 'score' | 'slot' | 'text';

/** Je odpověď platná pro danou anketu? Vrací důvod chyby, nebo null. */
export function validateAnswer(c: PollConfig, a: Answer): AnswerIssue | null {
  if (a.type !== c.type) return 'type';
  const ids = new Set(c.options.map((o) => o.id));
  switch (a.type) {
    case 'yesno':
      return ['yes', 'no', 'abstain'].includes(a.value) ? null : 'option';
    case 'single':
      return ids.has(a.option) ? null : 'option';
    case 'multi': {
      if (new Set(a.options).size !== a.options.length || a.options.some((o) => !ids.has(o))) return 'option';
      const min = c.minChoices ?? 1;
      const max = c.maxChoices ?? c.options.length;
      return a.options.length >= min && a.options.length <= max ? null : 'count';
    }
    case 'ranked':
      if (a.order.length === 0) return 'count';
      return new Set(a.order).size === a.order.length && a.order.every((o) => ids.has(o)) ? null : 'order';
    case 'rating': {
      const entries = Object.entries(a.scores);
      if (entries.length === 0) return 'count';
      const max = c.ratingMax ?? 5;
      return entries.every(([k, v]) => ids.has(k) && Number.isInteger(v) && v >= 1 && v <= max) ? null : 'score';
    }
    case 'schedule': {
      const entries = Object.entries(a.slots);
      if (entries.length === 0) return 'count';
      return entries.every(([k, v]) => ids.has(k) && ['yes', 'maybe', 'no'].includes(v)) ? null : 'slot';
    }
    case 'text':
      return typeof a.text === 'string' && a.text.trim().length > 0 && a.text.length <= 500 ? null : 'text';
  }
}

// ---------- váhy ----------

export interface WeightFacts {
  roleKey?: string | null;
  level: number;
  rating: number | null;
  stack: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function weightOf(rule: WeightRule, f: WeightFacts): number {
  let w = 1;
  switch (rule.mode) {
    case 'equal':
      break;
    case 'byRole':
      w = (f.roleKey && rule.table?.[f.roleKey]) || 1;
      break;
    case 'byLevel':
      w = 1 + Math.floor(f.level / Math.max(1, rule.step ?? 1));
      break;
    case 'byRating':
      w = f.rating ? Math.max(0.5, Math.min(3, f.rating / 1500)) : 1;
      break;
    case 'byStack':
      w = Math.max(0, f.stack ?? 0);
      break;
  }
  if (rule.cap !== undefined) w = Math.min(w, rule.cap);
  return round2(Math.max(0, w));
}

// ---------- výpočet výsledku ----------

export interface Voter {
  userId: string;
  weight: number;
  /** Síla nejvyšší role (pro řešení remízy „nejvýše postavená role“). */
  power?: number;
}

export interface Ballot {
  userId: string;
  answer: Answer;
}

export interface OptionResult {
  id: string;
  score: number;
  voters: number;
  /** Podíl z odevzdaných vah (0 až 1). */
  share: number;
  /** Další údaje: průměr u hodnocení, dostupnost u termínu. */
  extra?: Record<string, number>;
}

export type Outcome = 'open' | 'passed' | 'rejected' | 'no_quorum' | 'tie';

export interface PollResult {
  outcome: Outcome;
  /** Hotový výsledek (anketa skončila nebo ho nejde zvrátit). */
  final: boolean;
  winners: string[];
  tied: string[];
  options: OptionResult[];
  voted: number;
  eligible: number;
  votedWeight: number;
  eligibleWeight: number;
  participationPercent: number;
  /** Ranked: kola okamžitého rozstřelu. */
  rounds?: { eliminated: string | null; counts: Record<string, number> }[];
  texts?: { userId: string | null; text: string }[];
}

interface Counted {
  voter: Voter;
  answer: Answer;
}

const totalWeight = (vs: Voter[]) => vs.reduce((n, v) => n + v.weight, 0);

function quorumOk(c: PollConfig, voted: number, eligible: number): boolean {
  if (c.quorum.kind === 'none') return true;
  if (c.quorum.kind === 'count') return voted >= (c.quorum.value ?? 0);
  return eligible > 0 && voted / eligible >= (c.quorum.value ?? 0) / 100;
}

/** Splňuje podíl `top` z odevzdaných (`voted`) a všech oprávněných (`all`) vah potřebnou většinu? */
function shareOk(c: PollConfig, top: number, voted: number, all: number): boolean {
  if (top <= 0) return false;
  switch (c.threshold.kind) {
    case 'simple':
      return true;
    case 'majorityOfAll':
      return top * 2 > all;
    case 'twoThirds':
      return top * 3 >= voted * 2;
    case 'threeQuarters':
      return top * 4 >= voted * 3;
    case 'unanimous':
      return top >= voted;
    case 'percent':
      return top * 100 >= voted * (c.threshold.percent ?? 50);
  }
}

/** Rozhodnutí ano/ne podle vah (včetně nehlasujících podle nastavení). */
function decideYesNo(c: PollConfig, yes: number, no: number, nonVoter: number, eligibleWeight: number): Outcome {
  let y = yes;
  let n = no;
  if (c.nonVoters === 'yes') y += nonVoter;
  if (c.nonVoters === 'no') n += nonVoter;
  const base = y + n;
  switch (c.threshold.kind) {
    case 'simple':
      if (base === 0) return 'rejected';
      return y > n ? 'passed' : y === n ? 'tie' : 'rejected';
    case 'majorityOfAll':
      return y * 2 > eligibleWeight ? 'passed' : 'rejected';
    case 'twoThirds':
      return base > 0 && y * 3 >= base * 2 ? 'passed' : 'rejected';
    case 'threeQuarters':
      return base > 0 && y * 4 >= base * 3 ? 'passed' : 'rejected';
    case 'unanimous':
      return n === 0 && y > 0 ? 'passed' : 'rejected';
    case 'percent':
      return base > 0 && y * 100 >= base * (c.threshold.percent ?? 50) ? 'passed' : 'rejected';
  }
}

function emptyResult(c: PollConfig, voters: Voter[], ballots: Counted[]): PollResult {
  const eligibleWeight = totalWeight(voters);
  return {
    outcome: 'open',
    final: false,
    winners: [],
    tied: [],
    options: [],
    voted: ballots.length,
    eligible: voters.length,
    votedWeight: ballots.reduce((n, b) => n + b.voter.weight, 0),
    eligibleWeight,
    participationPercent: voters.length ? Math.round((ballots.length / voters.length) * 1000) / 10 : 0,
  };
}

function ranking(c: PollConfig, score: Map<string, number>, voters: Map<string, number>, votedWeight: number, extra?: (id: string) => Record<string, number>): OptionResult[] {
  return c.options
    .map((o) => ({ id: o.id, score: round2(score.get(o.id) ?? 0), voters: voters.get(o.id) ?? 0, share: votedWeight > 0 ? round2((score.get(o.id) ?? 0) / votedWeight) : 0, ...(extra ? { extra: extra(o.id) } : {}) }))
    .sort((a, b) => b.score - a.score || b.voters - a.voters || a.id.localeCompare(b.id));
}

function topOf(options: OptionResult[]): { winners: string[]; top: number } {
  const top = options[0]?.score ?? 0;
  return { top, winners: top > 0 ? options.filter((o) => o.score === top).map((o) => o.id) : [] };
}

/**
 * Vyhodnotí anketu z aktuálních hlasů. Dokud anketa běží, `final` je pravda jen když už výsledek nejde
 * zvrátit (všichni hlasovali, nebo zbývající hlasy nic nezmění) a anketa má povolené předčasné ukončení.
 */
export function tally(c: PollConfig, eligible: Voter[], rawBallots: Ballot[], closed: boolean): PollResult {
  const byUser = new Map(eligible.map((v) => [v.userId, v]));
  const ballots: Counted[] = [];
  for (const b of rawBallots) {
    const voter = byUser.get(b.userId);
    if (voter && validateAnswer(c, b.answer) === null) ballots.push({ voter, answer: b.answer });
  }
  const res = emptyResult(c, eligible, ballots);
  const allVoted = ballots.length === eligible.length && eligible.length > 0;
  const remaining = res.eligibleWeight - res.votedWeight;

  const finish = (patch: Partial<PollResult>, canChange: boolean): PollResult => {
    const out: PollResult = { ...res, ...patch };
    const quorum = quorumOk(c, ballots.length, eligible.length);
    out.final = closed || (c.earlyClose && (allVoted || (!canChange && quorum)));
    if (!out.final) {
      out.outcome = 'open';
    } else if (!quorum) {
      out.outcome = 'no_quorum';
      out.winners = [];
      out.tied = [];
    }
    return out;
  };

  switch (c.type) {
    case 'yesno': {
      const sum = { yes: 0, no: 0, abstain: 0 };
      const cnt = { yes: 0, no: 0, abstain: 0 };
      for (const b of ballots) {
        const v = (b.answer as { value: 'yes' | 'no' | 'abstain' }).value;
        sum[v] += b.voter.weight;
        cnt[v]++;
      }
      const options: OptionResult[] = (['yes', 'no', 'abstain'] as const).map((id) => ({ id, score: round2(sum[id]), voters: cnt[id], share: res.votedWeight > 0 ? round2(sum[id] / res.votedWeight) : 0 }));
      // nejde výsledek zvrátit zbývajícími hlasy? (všichni zbývající ano / ne / vůbec nehlasují)
      const asYes = decideYesNo(c, sum.yes + remaining, sum.no, 0, res.eligibleWeight);
      const asNo = decideYesNo(c, sum.yes, sum.no + remaining, 0, res.eligibleWeight);
      const asNone = decideYesNo(c, sum.yes, sum.no, remaining, res.eligibleWeight);
      const settled = asYes === asNo && asNo === asNone;
      const outcome: Outcome = asNone;
      const winners = outcome === 'passed' ? ['yes'] : outcome === 'rejected' ? ['no'] : [];
      return finish({ options, outcome, winners, tied: outcome === 'tie' ? ['yes', 'no'] : [] }, !settled);
    }
    case 'single':
    case 'multi': {
      const score = new Map<string, number>();
      const who = new Map<string, number>();
      for (const b of ballots) {
        const picked = b.answer.type === 'single' ? [b.answer.option] : b.answer.type === 'multi' ? b.answer.options : [];
        for (const o of picked) {
          score.set(o, (score.get(o) ?? 0) + b.voter.weight);
          who.set(o, (who.get(o) ?? 0) + 1);
        }
      }
      const options = ranking(c, score, who, res.votedWeight);
      const { winners, top } = topOf(options);
      const second = options[1]?.score ?? 0;
      let outcome: Outcome;
      if (winners.length === 0) outcome = 'rejected';
      else if (winners.length > 1) outcome = 'tie';
      else outcome = shareOk(c, top, res.votedWeight, res.eligibleWeight) ? 'passed' : 'rejected';
      // vedoucí nelze předběhnout, když náskok je větší než všechny zbývající hlasy (jen pro jednu volbu)
      const safe = c.type === 'single' && top - second > remaining;
      return finish({ options, outcome, winners: outcome === 'passed' ? winners : [], tied: outcome === 'tie' ? winners : [] }, !safe);
    }
    case 'ranked': {
      const { winner, rounds, tied } = instantRunoff(c, ballots);
      const first = new Map<string, number>();
      const who = new Map<string, number>();
      for (const b of ballots) {
        const o = (b.answer as { order: string[] }).order[0];
        if (o) {
          first.set(o, (first.get(o) ?? 0) + b.voter.weight);
          who.set(o, (who.get(o) ?? 0) + 1);
        }
      }
      const options = ranking(c, first, who, res.votedWeight);
      const last = rounds[rounds.length - 1];
      const finalActive = last ? Object.values(last.counts).reduce((a, b) => a + b, 0) : 0;
      const wTop = winner ? (last?.counts[winner] ?? 0) : 0;
      let outcome: Outcome = 'rejected';
      if (tied.length > 1) outcome = 'tie';
      else if (winner) outcome = shareOk(c, wTop, finalActive, res.eligibleWeight) ? 'passed' : 'rejected';
      return finish({ options, rounds, outcome, winners: outcome === 'passed' && winner ? [winner] : [], tied: outcome === 'tie' ? tied : [] }, true);
    }
    case 'rating': {
      const sum = new Map<string, number>();
      const weight = new Map<string, number>();
      const who = new Map<string, number>();
      for (const b of ballots) {
        for (const [o, s] of Object.entries((b.answer as { scores: Record<string, number> }).scores)) {
          sum.set(o, (sum.get(o) ?? 0) + s * b.voter.weight);
          weight.set(o, (weight.get(o) ?? 0) + b.voter.weight);
          who.set(o, (who.get(o) ?? 0) + 1);
        }
      }
      const avg = new Map([...sum].map(([o, v]) => [o, round2(v / (weight.get(o) || 1))]));
      const options = c.options
        .map((o) => ({ id: o.id, score: avg.get(o.id) ?? 0, voters: who.get(o.id) ?? 0, share: 0, extra: { average: avg.get(o.id) ?? 0 } }))
        .sort((a, b) => b.score - a.score || b.voters - a.voters || a.id.localeCompare(b.id));
      const { winners } = topOf(options);
      const outcome: Outcome = winners.length === 0 ? 'rejected' : winners.length > 1 ? 'tie' : 'passed';
      return finish({ options, outcome, winners: outcome === 'passed' ? winners : [], tied: outcome === 'tie' ? winners : [] }, true);
    }
    case 'schedule': {
      const score = new Map<string, number>();
      const avail = new Map<string, number>();
      const who = new Map<string, number>();
      for (const b of ballots) {
        for (const [o, s] of Object.entries((b.answer as { slots: Record<string, SlotAnswer> }).slots)) {
          if (s === 'no') continue;
          const w = s === 'yes' ? 1 : 0.5;
          score.set(o, (score.get(o) ?? 0) + w * b.voter.weight);
          avail.set(o, (avail.get(o) ?? 0) + b.voter.weight);
          who.set(o, (who.get(o) ?? 0) + 1);
        }
      }
      const options = ranking(c, score, who, res.votedWeight, (id) => ({ available: round2(avail.get(id) ?? 0) }));
      const { winners, top } = topOf(options);
      const topAvail = winners.length === 1 ? (avail.get(winners[0]!) ?? 0) : (avail.get(winners[0] ?? '') ?? 0);
      let outcome: Outcome;
      if (winners.length === 0) outcome = 'rejected';
      else if (winners.length > 1) outcome = 'tie';
      else outcome = shareOk(c, topAvail, res.votedWeight, res.eligibleWeight) && top > 0 ? 'passed' : 'rejected';
      return finish({ options, outcome, winners: outcome === 'passed' ? winners : [], tied: outcome === 'tie' ? winners : [] }, true);
    }
    case 'text': {
      const texts = ballots.map((b) => ({ userId: c.anonymity === 'public' ? b.voter.userId : null, text: (b.answer as { text: string }).text }));
      return finish({ outcome: 'passed', texts }, true);
    }
  }
}

/** Okamžitý rozstřel (instant-runoff): vždy vypadne možnost s nejméně prvními preferencemi. */
function instantRunoff(c: PollConfig, ballots: Counted[]): { winner: string | null; tied: string[]; rounds: { eliminated: string | null; counts: Record<string, number> }[] } {
  const active = new Set(c.options.map((o) => o.id));
  const rounds: { eliminated: string | null; counts: Record<string, number> }[] = [];
  if (ballots.length === 0) return { winner: null, tied: [], rounds };
  const mentions = new Map<string, number>();
  for (const b of ballots) for (const o of (b.answer as { order: string[] }).order) mentions.set(o, (mentions.get(o) ?? 0) + 1);
  for (let guard = 0; guard < 100; guard++) {
    const counts: Record<string, number> = Object.fromEntries([...active].map((id) => [id, 0]));
    let total = 0;
    for (const b of ballots) {
      const pick = (b.answer as { order: string[] }).order.find((o) => active.has(o));
      if (pick) {
        counts[pick] = (counts[pick] ?? 0) + b.voter.weight;
        total += b.voter.weight;
      }
    }
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [lead] = entries;
    if (!lead || total === 0) {
      rounds.push({ eliminated: null, counts });
      return { winner: null, tied: [], rounds };
    }
    if (lead[1] * 2 > total || active.size === 1) {
      rounds.push({ eliminated: null, counts });
      return { winner: lead[0], tied: [], rounds };
    }
    const min = Math.min(...entries.map((e) => e[1]));
    const lowest = entries.filter((e) => e[1] === min).map((e) => e[0]);
    if (lowest.length === active.size) {
      // všichni zbývající mají stejně: remíza
      rounds.push({ eliminated: null, counts });
      return { winner: null, tied: [...active].sort(), rounds };
    }
    // při shodě vypadne ten, kdo se na lístcích objevil méně často, pak podle id (deterministicky)
    const out = lowest.sort((a, b) => (mentions.get(a) ?? 0) - (mentions.get(b) ?? 0) || a.localeCompare(b))[0]!;
    rounds.push({ eliminated: out, counts });
    active.delete(out);
  }
  return { winner: null, tied: [], rounds };
}

// ---------- remíza ----------

export type TieResolution = { winner: string } | { needs: 'founder' | 'extend' };

/**
 * Rozhodne remízu podle nastavení: los (zadaný generátor), nejvýše postavená role (její volba), nebo
 * vrátí, že rozhodnout musí zakladatel / prodloužit anketu.
 */
export function resolveTie(c: PollConfig, tied: string[], eligible: Voter[], ballots: Ballot[], rng: () => number): TieResolution {
  if (tied.length === 0) return { needs: 'founder' };
  if (c.tie === 'founder') return { needs: 'founder' };
  if (c.tie === 'extend') return { needs: 'extend' };
  const random = () => ({ winner: tied[Math.min(tied.length - 1, Math.floor(rng() * tied.length))]! });
  if (c.tie === 'random') return random();
  const power = new Map(eligible.map((v) => [v.userId, v.power ?? 0]));
  const ordered = [...ballots].filter((b) => power.has(b.userId)).sort((a, b) => (power.get(b.userId) ?? 0) - (power.get(a.userId) ?? 0));
  const top = ordered[0];
  if (!top) return random();
  const topPower = power.get(top.userId) ?? 0;
  // volba nejmocnější role; při shodě sil rozhodne los mezi jejich volbami
  const picks = ordered.filter((b) => (power.get(b.userId) ?? 0) === topPower).map((b) => preferred(b.answer, tied)).filter((x): x is string => !!x);
  if (picks.length === 0) return random();
  return { winner: picks[Math.min(picks.length - 1, Math.floor(rng() * picks.length))]! };
}

function preferred(a: Answer, tied: string[]): string | null {
  switch (a.type) {
    case 'single':
      return tied.includes(a.option) ? a.option : null;
    case 'multi':
      return a.options.find((o) => tied.includes(o)) ?? null;
    case 'ranked':
      return a.order.find((o) => tied.includes(o)) ?? null;
    case 'rating': {
      const best = Math.max(...tied.map((o) => a.scores[o] ?? 0));
      return best > 0 ? (tied.find((o) => (a.scores[o] ?? 0) === best) ?? null) : null;
    }
    case 'schedule': {
      const val = (o: string) => (a.slots[o] === 'yes' ? 2 : a.slots[o] === 'maybe' ? 1 : 0);
      const best = Math.max(...tied.map(val));
      return best > 0 ? (tied.find((o) => val(o) === best) ?? null) : null;
    }
    default:
      return null;
  }
}
