import { rate } from 'openskill';

/**
 * Herní rating (čisté funkce). Základem je OpenSkill (Weng-Lin, model Plackett-Luce): každý hráč má odhad
 * síly μ a nejistotu σ. Zobrazuje se konzervativní odhad `μ − k·σ` přepočtený na stupnici kolem 1500.
 * K tomu přichází přímá výměna bodů při vyřazení (nulový součet) a váhy podle velikosti pole a délky hry.
 */

export interface RatingParams {
  mu0: number;
  sigma0: number;
  /** Násobek nejistoty v konzervativním odhadu. */
  k: number;
  /** Kolik bodů zobrazovaného ratingu odpovídá jednomu bodu μ. */
  scale: number;
  /** Zobrazovaný rating nového hráče. */
  base: number;
}

export interface Skill {
  mu: number;
  sigma: number;
}

export const newSkill = (p: RatingParams): Skill => ({ mu: p.mu0, sigma: p.sigma0 });

/** Zobrazovaný rating; nový hráč má vždy `base`, ať jsou μ0, σ0 a k nastaveny jakkoli. */
export function displayRating(s: Skill, p: RatingParams): number {
  return Math.round(p.base + p.scale * (s.mu - p.k * s.sigma - (p.mu0 - p.k * p.sigma0)));
}

/** Nejistota po období bez hraní: roste (síla μ se nemění), nejvýš na počáteční σ0. */
export function inactiveSkill(s: Skill, daysInactive: number, graceDays: number, growthPer30Days: number, p: RatingParams): Skill {
  const over = daysInactive - graceDays;
  if (over <= 0 || growthPer30Days <= 0) return s;
  const add = growthPer30Days * (over / 30);
  return { mu: s.mu, sigma: Math.min(p.sigma0, Math.sqrt(s.sigma * s.sigma + add * add)) };
}

/** Měkký reset sezóny: μ se přiblíží k průměru o dané procento, σ se zvýší o dané procento rozdílu k σ0. */
export function softReset(s: Skill, muPercent: number, sigmaPercent: number, p: RatingParams): Skill {
  const mu = s.mu + (p.mu0 - s.mu) * (muPercent / 100);
  const sigma = s.sigma + (p.sigma0 - s.sigma) * (sigmaPercent / 100);
  return { mu, sigma: Math.min(p.sigma0, sigma) };
}

// ---------- váhy ----------

/** Turnaj s menším polem ovlivní rating méně: plná váha od `fullField` hráčů. */
export function fieldFactor(field: number, fullField: number): number {
  if (fullField <= 2) return 1;
  return Math.max(0, Math.min(1, (field - 1) / (fullField - 1)));
}

/** Rychlé (turbo) turnaje váží méně než dlouhé: podle cílové délky, nejméně `minFactor`. */
export function lengthFactor(targetMinutes: number, refMinutes: number, minFactor: number): number {
  if (!targetMinutes || !refMinutes) return 1;
  return Math.max(minFactor, Math.min(1, targetMinutes / refMinutes));
}

// ---------- turnaj ----------

export interface TournamentPlayer {
  userId: string;
  place: number;
  skill: Skill;
  rebuys: number;
}

export interface Elimination {
  victimId: string;
  /** `equity` je šance vyřazujícího v okamžiku all-inu (jen heads-up), pro EV korekci. */
  killers: { userId: string; weight: number; equity?: number | null }[];
}

export interface TournamentRatingOptions {
  /** Podíl výměny bodů při vyřazení na celkové změně (v %). */
  knockoutWeightPercent: number;
  /** Body ratingu, které by při stejné síle soupeřů (očekávání 0,5) výměna při vyřazení přenesla před vahou. */
  knockoutK: number;
  /** Vliv rebuyů: o kolik % se sníží zisk za každý rebuy. */
  rebuyPenaltyPercent: number;
  /** Součin vah pole, délky turnaje a opakování dvojic (0 až 1). */
  weight: number;
  /** Jak velká část výměny za vyřazení se počítá podle očekávané hodnoty (šance při all-inu) místo skutečného výsledku (v %). */
  evSharePercent?: number;
}

export interface TournamentBreakdown {
  /** Změna zobrazovaného ratingu za umístění. */
  placement: number;
  knockouts: { userId: string; points: number }[];
  knockedOutBy: { userId: string; points: number }[];
  weight: number;
  rebuyPenalty: boolean;
}

export interface RatingChange {
  userId: string;
  before: Skill;
  after: Skill;
  displayBefore: number;
  displayAfter: number;
  breakdown: TournamentBreakdown;
}

/** Rozdělí číslo podle vah tak, aby součet dílů byl přesně `total` (desetinná čísla). */
function shares(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  return weights.map((w) => (total * w) / sum);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Vypočítá novou sílu všech hráčů po turnaji z konečného pořadí a vyřazení.
 * Změny z umístění jsou váženy poli/délkou/rebuye, výměna při vyřazení je nulový součet.
 */
export function rateTournament(players: TournamentPlayer[], eliminations: Elimination[], o: TournamentRatingOptions, p: RatingParams): RatingChange[] {
  if (players.length < 2) return [];
  const sorted = [...players].sort((a, b) => a.place - b.place);
  const result = rate(
    sorted.map((x) => [{ mu: x.skill.mu, sigma: x.skill.sigma }]),
    { rank: sorted.map((x) => x.place) },
  );
  const koShare = Math.max(0, Math.min(100, o.knockoutWeightPercent)) / 100;
  const byId = new Map(sorted.map((x, i) => [x.userId, { p: x, os: result[i]![0]! }]));
  const before = new Map(sorted.map((x) => [x.userId, displayRating(x.skill, p)]));

  // výměna bodů při vyřazení podle očekávání z rozdílu ratingů před turnajem (nulový součet)
  const koGain = new Map<string, { userId: string; points: number }[]>();
  const koLoss = new Map<string, { userId: string; points: number }[]>();
  const delta = new Map<string, number>(); // body zobrazovaného ratingu z výměn
  for (const e of eliminations) {
    const victim = byId.get(e.victimId);
    const killers = e.killers.filter((k) => byId.has(k.userId) && k.userId !== e.victimId);
    if (!victim || killers.length === 0) continue;
    const rv = before.get(e.victimId)!;
    const parts = shares(1, killers.map((k) => k.weight));
    killers.forEach((k, i) => {
      const rk = before.get(k.userId)!;
      const expected = 1 / (1 + Math.pow(10, (rv - rk) / 400));
      // EV korekce: kdo vyřadil soupeře jen díky štěstí v all-inu, získá méně, kdo prohrál jako favorit, ztratí méně
      const ev = Math.max(0, Math.min(100, o.evSharePercent ?? 0)) / 100;
      const luck = k.equity == null ? 1 : 1 - ev + ev * k.equity;
      const points = o.knockoutK * koShare * (1 - expected) * o.weight * parts[i]! * 2 * luck;
      if (points === 0) return;
      delta.set(k.userId, (delta.get(k.userId) ?? 0) + points);
      delta.set(e.victimId, (delta.get(e.victimId) ?? 0) - points);
      (koGain.get(k.userId) ?? koGain.set(k.userId, []).get(k.userId)!).push({ userId: e.victimId, points: round2(points) });
      (koLoss.get(e.victimId) ?? koLoss.set(e.victimId, []).get(e.victimId)!).push({ userId: k.userId, points: round2(points) });
    });
  }

  return sorted.map((x) => {
    const { os } = byId.get(x.userId)!;
    let w = o.weight;
    const rawGain = os.mu - x.skill.mu;
    let rebuyPenalty = false;
    if (rawGain > 0 && x.rebuys > 0 && o.rebuyPenaltyPercent > 0) {
      w *= Math.max(0.2, 1 - (x.rebuys * o.rebuyPenaltyPercent) / 100);
      rebuyPenalty = true;
    }
    const placementMu = (1 - koShare) * w * rawGain;
    const mu = x.skill.mu + placementMu + (delta.get(x.userId) ?? 0) / p.scale;
    const sigma = x.skill.sigma + o.weight * (os.sigma - x.skill.sigma);
    const after: Skill = { mu, sigma };
    const placementPoints = p.scale * placementMu;
    return {
      userId: x.userId,
      before: x.skill,
      after,
      displayBefore: before.get(x.userId)!,
      displayAfter: displayRating(after, p),
      breakdown: {
        placement: round2(placementPoints),
        knockouts: koGain.get(x.userId) ?? [],
        knockedOutBy: koLoss.get(x.userId) ?? [],
        weight: round2(o.weight),
        rebuyPenalty,
      },
    };
  });
}

// ---------- cash ----------

export interface CashPlayer {
  userId: string;
  /** Výsledek sezení v big blindech na 100 hand. */
  bbPer100: number;
  skill: Skill;
}

/** Hodnocení cash sezení: hráči u téhož stolu se seřadí podle výsledku v BB/100 a upraví se OpenSkillem s danou váhou. */
export function rateCashSession(players: CashPlayer[], weight: number, p: RatingParams): RatingChange[] {
  if (players.length < 2) return [];
  const sorted = [...players].sort((a, b) => b.bbPer100 - a.bbPer100);
  // shodný výsledek = shodné pořadí
  const ranks: number[] = [];
  sorted.forEach((x, i) => ranks.push(i > 0 && x.bbPer100 === sorted[i - 1]!.bbPer100 ? ranks[i - 1]! : i + 1));
  const result = rate(
    sorted.map((x) => [{ mu: x.skill.mu, sigma: x.skill.sigma }]),
    { rank: ranks },
  );
  return sorted.map((x, i) => {
    const os = result[i]![0]!;
    const after: Skill = { mu: x.skill.mu + weight * (os.mu - x.skill.mu), sigma: x.skill.sigma + weight * (os.sigma - x.skill.sigma) };
    const displayBefore = displayRating(x.skill, p);
    const displayAfter = displayRating(after, p);
    return {
      userId: x.userId,
      before: x.skill,
      after,
      displayBefore,
      displayAfter,
      breakdown: { placement: displayAfter - displayBefore, knockouts: [], knockedOutBy: [], weight: round2(weight), rebuyPenalty: false },
    };
  });
}

// ---------- divize ----------

export interface Division {
  name: string;
  min: number;
}

export const DEFAULT_DIVISIONS = 'Bronz|0;Stříbro|1550;Zlato|1650;Platina|1800;Diamant|1950;Mistr|2100';

export function parseDivisions(text: string): { divisions: Division[]; errors: string[] } {
  const divisions: Division[] = [];
  const errors: string[] = [];
  for (const [i, raw] of text.split(/\r?\n|;/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const [name, min] = line.split('|').map((x) => x.trim());
    const m = Number(min);
    if (!name || name.length > 30 || !Number.isInteger(m) || m < 0 || m > 10_000) {
      errors.push(`Řádek ${i + 1}`);
      continue;
    }
    divisions.push({ name, min: m });
  }
  divisions.sort((a, b) => a.min - b.min);
  if (divisions.length > 0 && divisions[0]!.min !== 0) errors.push('První divize musí začínat na 0');
  return { divisions, errors };
}

export function divisionFor(display: number, text: string): Division {
  const parsed = parseDivisions(text);
  const list = parsed.errors.length === 0 && parsed.divisions.length > 0 ? parsed.divisions : parseDivisions(DEFAULT_DIVISIONS).divisions;
  let cur = list[0]!;
  for (const d of list) if (d.min <= display) cur = d;
  return cur;
}
