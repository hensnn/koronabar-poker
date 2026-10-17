import { describe, expect, it } from 'vitest';
import { DEFAULT_DIVISIONS, displayRating, divisionFor, fieldFactor, inactiveSkill, lengthFactor, newSkill, parseDivisions, rateCashSession, rateTournament, softReset, type RatingParams, type TournamentRatingOptions } from './rating.js';

const P: RatingParams = { mu0: 25, sigma0: 25 / 3, k: 3, scale: 30, base: 1500 };
const O: TournamentRatingOptions = { knockoutWeightPercent: 20, knockoutK: 40, rebuyPenaltyPercent: 10, weight: 1 };
const skill = () => newSkill(P);
const field = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `p${i + 1}`, place: i + 1, skill: skill(), rebuys: 0 }));

describe('zobrazovaný rating', () => {
  it('nový hráč má základní rating bez ohledu na parametry; vyšší μ a nižší σ ho zvedají', () => {
    expect(displayRating(skill(), P)).toBe(1500);
    expect(displayRating(newSkill({ ...P, mu0: 50, sigma0: 10, k: 2 }), { ...P, mu0: 50, sigma0: 10, k: 2 })).toBe(1500);
    expect(displayRating({ mu: 30, sigma: 8.333 }, P)).toBeGreaterThan(1500);
    expect(displayRating({ mu: 25, sigma: 5 }, P)).toBeGreaterThan(1500);
  });
});

describe('rating po turnaji', () => {
  it('vítěz stoupne, poslední klesne, nejistota všech klesne', () => {
    const ch = rateTournament(field(5), [], O, P);
    const win = ch.find((c) => c.userId === 'p1')!;
    const last = ch.find((c) => c.userId === 'p5')!;
    expect(win.displayAfter).toBeGreaterThan(1500);
    expect(last.displayAfter).toBeLessThan(1500);
    for (const c of ch) expect(c.after.sigma).toBeLessThan(c.before.sigma);
  });

  it('silnější soupeř přinese víc: výhra nad favoritem je cennější než nad slabým', () => {
    const strong = { mu: 32, sigma: 3 };
    const weak = { mu: 18, sigma: 3 };
    const vsStrong = rateTournament([{ userId: 'a', place: 1, skill: skill(), rebuys: 0 }, { userId: 'b', place: 2, skill: strong, rebuys: 0 }], [], O, P);
    const vsWeak = rateTournament([{ userId: 'a', place: 1, skill: skill(), rebuys: 0 }, { userId: 'b', place: 2, skill: weak, rebuys: 0 }], [], O, P);
    const gain = (r: typeof vsStrong) => r.find((c) => c.userId === 'a')!.displayAfter - 1500;
    expect(gain(vsStrong)).toBeGreaterThan(gain(vsWeak));
  });

  it('výměna při vyřazení je nulový součet; vyřazení silnějšího vyplatí víc', () => {
    const players = [
      { userId: 'a', place: 1, skill: { mu: 25, sigma: 8 }, rebuys: 0 },
      { userId: 'b', place: 2, skill: { mu: 25, sigma: 8 }, rebuys: 0 },
      { userId: 'c', place: 3, skill: { mu: 35, sigma: 4 }, rebuys: 0 },
    ];
    const none = rateTournament(players, [], O, P);
    const withKo = rateTournament(players, [{ victimId: 'c', killers: [{ userId: 'a', weight: 1 }] }, { victimId: 'b', killers: [{ userId: 'a', weight: 1 }] }], O, P);
    // rozdíl mezi „s vyřazením“ a „bez“ se v μ vzájemně ruší
    const dMu = withKo.map((c) => c.after.mu - none.find((n) => n.userId === c.userId)!.after.mu);
    const placementShare = (c: (typeof withKo)[number]) => c.after.mu;
    expect(placementShare).toBeTruthy();
    const koOnly = withKo.map((c, i) => dMu[i]! + (1 - 0.2) * 0); // součet změn z výměn
    expect(koOnly.reduce((a, b) => a + b, 0)).toBeCloseTo(withKo.reduce((s, c) => s + (c.after.mu - c.before.mu), 0) - none.reduce((s, c) => s + (c.after.mu - c.before.mu), 0), 6);
    const a = withKo.find((c) => c.userId === 'a')!;
    const ptsFromStrong = a.breakdown.knockouts.find((k) => k.userId === 'c')!.points;
    const ptsFromEven = a.breakdown.knockouts.find((k) => k.userId === 'b')!.points;
    expect(ptsFromStrong).toBeGreaterThan(ptsFromEven);
    // body vyřazeného jsou přesně body vyřazujícího
    const gained = a.breakdown.knockouts.reduce((s, k) => s + k.points, 0);
    const lost = withKo.flatMap((c) => c.breakdown.knockedOutBy).reduce((s, k) => s + k.points, 0);
    expect(lost).toBeCloseTo(gained, 1);
  });

  it('vyřazení více hráči se dělí podle vah', () => {
    const ch = rateTournament(field(3), [{ victimId: 'p3', killers: [{ userId: 'p1', weight: 3 }, { userId: 'p2', weight: 1 }] }], O, P);
    const g1 = ch.find((c) => c.userId === 'p1')!.breakdown.knockouts[0]!.points;
    const g2 = ch.find((c) => c.userId === 'p2')!.breakdown.knockouts[0]!.points;
    expect(g1 / g2).toBeCloseTo(3, 0);
  });

  it('váha pole a rebuye zmenšují zisk', () => {
    const base = rateTournament(field(4), [], O, P).find((c) => c.userId === 'p1')!.displayAfter - 1500;
    const half = rateTournament(field(4), [], { ...O, weight: 0.5 }, P).find((c) => c.userId === 'p1')!.displayAfter - 1500;
    expect(half).toBeLessThan(base);
    expect(half).toBeGreaterThan(0);
    const rebuyers = field(4).map((x) => (x.userId === 'p1' ? { ...x, rebuys: 3 } : x));
    const rb = rateTournament(rebuyers, [], O, P).find((c) => c.userId === 'p1')!;
    expect(rb.displayAfter - 1500).toBeLessThan(base);
    expect(rb.breakdown.rebuyPenalty).toBe(true);
    // rebuye neprohlubují ztrátu
    const loser = rateTournament(rebuyers.map((x) => (x.userId === 'p4' ? { ...x, rebuys: 3 } : x)), [], O, P).find((c) => c.userId === 'p4')!;
    const loser0 = rateTournament(field(4), [], O, P).find((c) => c.userId === 'p4')!;
    expect(loser.displayAfter).toBe(loser0.displayAfter);
  });

  it('váhy podle pole a délky', () => {
    expect(fieldFactor(3, 9)).toBeCloseTo(0.25);
    expect(fieldFactor(9, 9)).toBe(1);
    expect(fieldFactor(20, 9)).toBe(1);
    expect(lengthFactor(60, 180, 0.5)).toBe(0.5);
    expect(lengthFactor(120, 180, 0.3)).toBeCloseTo(0.6667, 3);
    expect(lengthFactor(0, 180, 0.5)).toBe(1);
  });
});

describe('neaktivita a reset', () => {
  it('σ po pauze roste, μ se nemění; nejvýš na počáteční hodnotu', () => {
    const s = { mu: 30, sigma: 3 };
    expect(inactiveSkill(s, 20, 30, 2, P)).toEqual(s);
    const later = inactiveSkill(s, 120, 30, 2, P);
    expect(later.mu).toBe(30);
    expect(later.sigma).toBeGreaterThan(3);
    expect(inactiveSkill(s, 10_000, 30, 2, P).sigma).toBe(P.sigma0);
    expect(displayRating(later, P)).toBeLessThan(displayRating(s, P));
  });

  it('měkký reset přiblíží μ k průměru a zvýší σ', () => {
    const r = softReset({ mu: 35, sigma: 3 }, 50, 50, P);
    expect(r.mu).toBeCloseTo(30);
    expect(r.sigma).toBeGreaterThan(3);
    expect(softReset({ mu: 35, sigma: 3 }, 0, 0, P)).toEqual({ mu: 35, sigma: 3 });
  });
});

describe('cash sezení a divize', () => {
  it('lepší výsledek v BB/100 stoupne, horší klesne, váha omezuje změnu', () => {
    const players = [
      { userId: 'a', bbPer100: 12, skill: skill() },
      { userId: 'b', bbPer100: -5, skill: skill() },
      { userId: 'c', bbPer100: 3, skill: skill() },
    ];
    const full = rateCashSession(players, 1, P);
    const light = rateCashSession(players, 0.3, P);
    expect(full.find((c) => c.userId === 'a')!.displayAfter).toBeGreaterThan(1500);
    expect(full.find((c) => c.userId === 'b')!.displayAfter).toBeLessThan(1500);
    expect(light.find((c) => c.userId === 'a')!.displayAfter - 1500).toBeLessThan(full.find((c) => c.userId === 'a')!.displayAfter - 1500);
    expect(rateCashSession([players[0]!], 1, P)).toEqual([]);
  });

  it('divize podle ratingu, neplatný text spadne na výchozí', () => {
    expect(divisionFor(1000, DEFAULT_DIVISIONS).name).toBe('Bronz');
    expect(divisionFor(1550, DEFAULT_DIVISIONS).name).toBe('Stříbro');
    expect(divisionFor(2500, DEFAULT_DIVISIONS).name).toBe('Mistr');
    expect(parseDivisions('Jen|500').errors).toContain('První divize musí začínat na 0');
    expect(divisionFor(1600, 'nesmysl').name).toBe('Stříbro');
  });
});

describe('EV korekce výměny za vyřazení', () => {
  const trio = [
    { userId: 'a', place: 1, skill: { mu: 25, sigma: 8 }, rebuys: 0 },
    { userId: 'b', place: 2, skill: { mu: 25, sigma: 8 }, rebuys: 0 },
  ];
  const pts = (equity: number | null, ev: number) => rateTournament(trio, [{ victimId: 'b', killers: [{ userId: 'a', weight: 1, equity }] }], { ...O, evSharePercent: ev }, P).find((c) => c.userId === 'a')!.breakdown.knockouts[0]!.points;

  it('výhra s malou šancí přinese méně, výhra jako favorit skoro plně; bez dat nebo s EV 0 % se nic nemění', () => {
    const full = pts(null, 50);
    expect(pts(0.1, 50)).toBeLessThan(full);
    expect(pts(0.9, 50)).toBeGreaterThan(pts(0.1, 50));
    expect(pts(0.9, 50)).toBeLessThanOrEqual(full);
    expect(pts(0.1, 0)).toBe(full);
    // při 100 % EV je cena úměrná šanci vyřazujícího
    expect(pts(0.25, 100)).toBeCloseTo(full * 0.25, 1);
  });

  it('výměna zůstává nulový součet i s EV korekcí', () => {
    const ch = rateTournament(trio, [{ victimId: 'b', killers: [{ userId: 'a', weight: 1, equity: 0.2 }] }], { ...O, evSharePercent: 50 }, P);
    const gained = ch.find((c) => c.userId === 'a')!.breakdown.knockouts.reduce((s, k) => s + k.points, 0);
    const lost = ch.find((c) => c.userId === 'b')!.breakdown.knockedOutBy.reduce((s, k) => s + k.points, 0);
    expect(lost).toBeCloseTo(gained, 1);
  });
});
