export interface BreakPlanInput {
  /** Přestávka po každých N levelech (0 = bez přestávek). */
  every: number;
  /** Opakovat po každých N levelech; jinak jen jednou po N-tém. */
  repeat: boolean;
  levelNumber: number;
  onBreak: boolean;
  mode: 'time' | 'hands';
  levelMinutes: number;
  levelHands: number;
  handsInLevel: number;
  /** Zbývající čas aktuálního levelu (ms); null, když hodiny neběží. */
  clockMs: number | null;
  breakMinutes: number;
}

export interface BreakPlan {
  /** Přestávka bude po tomto levelu. */
  afterLevel: number;
  /** Kolik levelů zbývá do jejího začátku včetně rozehraného (1 = po tomto levelu). */
  levelsLeft: number;
  /** Za jak dlouho (ms) začne, při časových levelech; jinak null. */
  inMs: number | null;
  /** Kolik hand zbývá do začátku, při levelech podle hand; jinak null. */
  handsLeft: number | null;
  minutes: number;
}

/** Nejbližší plánovaná přestávka (null: žádná nebude, nebo právě probíhá). Čistá funkce; nepočítá se s pauzami turnaje. */
export function nextBreakPlan(i: BreakPlanInput): BreakPlan | null {
  if (i.every <= 0 || i.onBreak || i.breakMinutes <= 0) return null;
  const afterLevel = i.repeat ? Math.ceil(i.levelNumber / i.every) * i.every : i.levelNumber <= i.every ? i.every : null;
  if (afterLevel === null) return null;
  const further = afterLevel - i.levelNumber;
  if (i.mode === 'hands') {
    const handsLeft = Math.max(0, i.levelHands - i.handsInLevel) + further * i.levelHands;
    return { afterLevel, levelsLeft: further + 1, inMs: null, handsLeft, minutes: i.breakMinutes };
  }
  return { afterLevel, levelsLeft: further + 1, inMs: i.clockMs === null ? null : i.clockMs + further * i.levelMinutes * 60_000, handsLeft: null, minutes: i.breakMinutes };
}
