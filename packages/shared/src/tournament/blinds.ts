/** Struktura blindů turnaje: zápis, rozbor a automatický generátor podle cílové délky. */

export interface Level {
  smallBlind: number;
  bigBlind: number;
  ante: number;
}

export class StructureError extends Error {
  constructor(
    public readonly code: 'EMPTY' | 'SYNTAX' | 'NOT_INCREASING' | 'TOO_MANY',
    public readonly line?: string,
  ) {
    super(line ? `${code}: ${line}` : code);
  }
}

const MAX_LEVELS = 200;

/** Rozbor textu „25/50, 50/100/10“ (oddělovač čárka nebo nový řádek, volitelné ante). */
export function parseStructure(text: string): Level[] {
  const parts = text
    .split(/[\n,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new StructureError('EMPTY');
  if (parts.length > MAX_LEVELS) throw new StructureError('TOO_MANY');
  const levels: Level[] = [];
  for (const part of parts) {
    const m = /^(\d+)\s*\/\s*(\d+)(?:\s*\/\s*(\d+))?$/.exec(part);
    if (!m) throw new StructureError('SYNTAX', part);
    const level: Level = { smallBlind: Number(m[1]), bigBlind: Number(m[2]), ante: m[3] ? Number(m[3]) : 0 };
    if (level.smallBlind < 1 || level.bigBlind < level.smallBlind || level.ante > level.bigBlind) throw new StructureError('SYNTAX', part);
    const prev = levels[levels.length - 1];
    if (prev && level.bigBlind < prev.bigBlind) throw new StructureError('NOT_INCREASING', part);
    levels.push(level);
  }
  return levels;
}

export const formatStructure = (levels: Level[]): string => levels.map((l) => `${l.smallBlind}/${l.bigBlind}${l.ante ? `/${l.ante}` : ''}`).join(', ');

/** Žebříček „hezkých“ velkých blindů (vše sudé, takže malý blind je vždy celé číslo). */
function bigBlindLadder(max: number): number[] {
  const mantissas = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
  const out = new Set<number>([2, 4, 6, 8]);
  for (let mag = 1; mag <= 1e10; mag *= 10) {
    for (const m of mantissas) {
      const v = Math.round(m * mag);
      if (v >= 2 && v % 2 === 0) out.add(v);
    }
    if (mag * 10 > max * 20) break;
  }
  return [...out].sort((a, b) => a - b);
}

export interface GenerateOptions {
  startingStack: number;
  targetMinutes: number;
  /** Délka levelu v minutách (u levelů podle hand se přepočítá odhadem). */
  levelMinutes: number;
  /** Odhad počtu hráčů (určuje celkový počet žetonů, tedy konečný blind). */
  players?: number;
  /** Od kterého levelu se přidává ante (0 = nikdy). */
  anteFromLevel?: number;
}

/**
 * Vygeneruje rostoucí strukturu tak, aby poslední level měl velký blind zhruba 1/20 celkových žetonů
 * (tam turnaj typicky končí, viz odhad délky) a levelů bylo tolik, kolik se vejde do cílové délky.
 * Kdyby hra trvala déle, blindy se za posledním levelem dál zdvojnásobují.
 */
export function generateStructure(o: GenerateOptions): Level[] {
  const count = Math.max(2, Math.min(MAX_LEVELS, Math.round(o.targetMinutes / Math.max(1, o.levelMinutes))));
  const players = Math.max(2, o.players ?? 9);
  const startBb = Math.max(2, o.startingStack / 100);
  const endBb = Math.max(startBb * 2, (o.startingStack * players) / 20);
  const ladder = bigBlindLadder(endBb);
  const nearest = (x: number): number => ladder.reduce((best, v) => (Math.abs(Math.log(v / x)) < Math.abs(Math.log(best / x)) ? v : best), ladder[0]!);
  const ratio = Math.pow(endBb / startBb, 1 / (count - 1));
  const anteFrom = o.anteFromLevel ?? Math.ceil(count / 2);
  const levels: Level[] = [];
  let lastIdx = -1;
  for (let i = 0; i < count; i++) {
    let bb = nearest(startBb * Math.pow(ratio, i));
    let idx = ladder.indexOf(bb);
    if (idx <= lastIdx) idx = lastIdx + 1;
    bb = ladder[idx] ?? ladder[ladder.length - 1]!;
    lastIdx = idx;
    const ante = anteFrom > 0 && i + 1 >= anteFrom ? Math.max(1, Math.floor(bb / 10)) : 0;
    levels.push({ smallBlind: bb / 2, bigBlind: bb, ante });
  }
  // Nikdy dvakrát stejný level (na konci žebříčku).
  return levels.filter((l, i) => i === 0 || l.bigBlind > levels[i - 1]!.bigBlind);
}

/** Předvolby tempa turnaje: délka levelu a cílová délka; samotné blindy se z nich dopočítají podle stacku a počtu hráčů. */
export const STRUCTURE_PRESETS: { id: 'slow' | 'standard' | 'turbo' | 'hyper'; levelMinutes: number; targetMinutes: number }[] = [
  { id: 'slow', levelMinutes: 20, targetMinutes: 240 },
  { id: 'standard', levelMinutes: 15, targetMinutes: 150 },
  { id: 'turbo', levelMinutes: 6, targetMinutes: 60 },
  { id: 'hyper', levelMinutes: 3, targetMinutes: 30 },
];

/**
 * Přepočítá uloženou strukturu na jiný startovní stack (poměr nového a původního stacku):
 * blindy se zaokrouhlí na „hezké“ hodnoty ze žebříčku, ante na desetinu velkého blindu, levely zůstávají rostoucí.
 */
export function scaleStructure(levels: Level[], factor: number): Level[] {
  if (!Number.isFinite(factor) || factor <= 0 || levels.length === 0) return levels;
  const maxBb = Math.max(...levels.map((l) => l.bigBlind)) * factor;
  const ladder = bigBlindLadder(maxBb);
  const nearest = (x: number): number => ladder.reduce((best, v) => (Math.abs(Math.log(v / x)) < Math.abs(Math.log(best / x)) ? v : best), ladder[0]!);
  const out: Level[] = [];
  let lastIdx = -1;
  for (const l of levels) {
    let idx = ladder.indexOf(nearest(l.bigBlind * factor));
    if (idx <= lastIdx) idx = lastIdx + 1;
    const bb = ladder[idx] ?? ladder[ladder.length - 1]!;
    lastIdx = idx;
    out.push({ smallBlind: bb / 2, bigBlind: bb, ante: l.ante > 0 ? Math.max(1, Math.floor(bb / 10)) : 0 });
  }
  return out.filter((l, i) => i === 0 || l.bigBlind > out[i - 1]!.bigBlind);
}
