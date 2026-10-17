import type { SettingValues } from '../settings/types.js';
import { generateStructure, parseStructure, type Level } from './blinds.js';

export interface Estimate {
  /** Odhad délky v minutách, null = struktura se nedá rozebrat. */
  minutes: number | null;
  /** Kratší a delší varianta (rychlejší / pomalejší průběh). */
  range: [number, number] | null;
  /** Kolem kterého levelu turnaj skončí. */
  levels: number | null;
}

export interface EstimateOptions {
  players: number;
}

const num = (s: SettingValues, k: string) => Number(s[k] ?? 0);

/**
 * Orientační odhad délky turnaje podle struktury blindů a počtu žetonů ve hře (jako v klubových kalkulačkách):
 * turnaj typicky končí na levelu, kde velký blind dosáhne zhruba 1/20 všech žetonů (heads-up má každý ~10 BB).
 * Rychlejší varianta počítá s 1/30, pomalejší s 1/12. Rebuy a add-on žetony přidávají (odhad: polovina hráčů jednou).
 * Levely po handách se počítají jako jedna handa ≈ 1 minuta.
 */
export function estimateTournament(settings: SettingValues, opt: EstimateOptions): Estimate {
  const players = Math.max(2, opt.players);
  const stack = num(settings, 'tournament.startingStack');
  const byHands = settings['tournament.levelMode'] === 'hands';
  const levelMinutes = byHands ? Math.max(1, num(settings, 'tournament.levelHands')) : Math.max(1, num(settings, 'tournament.levelMinutes'));
  let levels: Level[];
  try {
    const custom = String(settings['tournament.structure'] ?? '').trim();
    levels = custom ? parseStructure(custom) : generateStructure({ startingStack: stack, targetMinutes: num(settings, 'tournament.targetMinutes'), levelMinutes, players });
  } catch {
    return { minutes: null, range: null, levels: null };
  }
  if (levels.length === 0 || stack <= 0) return { minutes: null, range: null, levels: null };

  let chips = stack * players;
  if (settings['tournament.rebuyEnabled']) chips += Math.ceil(players / 2) * num(settings, 'tournament.rebuyChips');
  if (settings['tournament.addonEnabled']) chips += Math.ceil(players / 2) * num(settings, 'tournament.addonChips');

  const breakEvery = num(settings, 'tournament.breakEveryLevels');
  const breakMinutes = num(settings, 'tournament.breakMinutes');
  // Po posledním zadaném levelu se blindy dál zdvojnásobují (turnaj nikdy nezůstane stát).
  const bbAt = (i: number): number => (i < levels.length ? levels[i]!.bigBlind : levels[levels.length - 1]!.bigBlind * 2 ** (i - levels.length + 1));
  const endAt = (targetBb: number): { minutes: number; level: number } => {
    let i = 0;
    while (bbAt(i) < targetBb && i < 500) i++;
    // Zlomek levelu podle logaritmické interpolace mezi předchozím a tímto blindem.
    let frac = i;
    if (i > 0 && bbAt(i) > bbAt(i - 1)) frac = i - 1 + Math.log(targetBb / bbAt(i - 1)) / Math.log(bbAt(i) / bbAt(i - 1));
    frac = Math.max(0.5, frac);
    const repeat = settings['tournament.breakRepeat'] !== false;
    const breaks = breakEvery > 0 ? (repeat ? Math.floor(frac / breakEvery) : frac >= breakEvery ? 1 : 0) * breakMinutes : 0;
    return { minutes: frac * levelMinutes + breaks, level: Math.min(levels.length, Math.max(1, Math.ceil(frac))) };
  };
  const mid = endAt(chips / 20);
  const fast = endAt(chips / 30);
  const slow = endAt(chips / 12);
  return { minutes: Math.round(mid.minutes), range: [Math.round(fast.minutes), Math.round(slow.minutes)], levels: mid.level };
}
