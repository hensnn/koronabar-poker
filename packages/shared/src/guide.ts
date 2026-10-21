import { t } from './i18n/cs.js';

/** Kapitoly návodu: id a počet odstavců (texty jsou v překladech `guide.s.<id>.<n>`). */
export const GUIDE_SECTIONS: { id: string; points: number }[] = [
  { id: 'start', points: 4 },
  { id: 'cash', points: 5 },
  { id: 'tournament', points: 6 },
  { id: 'table', points: 6 },
  { id: 'special', points: 15 },
  { id: 'panels', points: 5 },
  { id: 'comm', points: 3 },
  { id: 'social', points: 3 },
  { id: 'settings', points: 4 },
  { id: 'admin', points: 3 },
];

/** Malá písmena bez diakritiky, aby „sazka“ našlo i „sázka“. */
export const foldText = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

const STOP = new Set(
  'jak jaky jaka jake jaké co kdo kde kdy proc proč jsou bude budu muzu mohu mam mate maji lze jede jde tohle toto tuto tento tahle tady nejak nejaky prosim chci chtel chtela potrebuji vysvetli vysvetlit rekni reknete znamena znamenaji funguje fungovat delat dela pouzit pouziva pouziju'.split(' ').map(foldText),
);
// Slovesa změny: takové žádosti patří modelu (návrh se musí potvrdit), ne odpovědi z návodu.
const ACTION = /\b(nastav|zmen|vytvor|zaloz|pridej|odstran|smaz|zapni|vypni|uprav|zrus|prejmenuj|napis|vygeneruj)/;

export interface GuideAnswer {
  chapter: string;
  paragraphs: string[];
}

/**
 * Odpověď z návodu bez volání AI: najde odstavce, které obsahují všechna významná slova otázky (shoda podle začátku slova,
 * aby fungovaly české koncovky). Vrací null, když je otázka žádostí o změnu, příliš obecná (víc než tři odstavce) nebo nic nenajde.
 */
export function answerFromGuide(question: string): GuideAnswer | null {
  const q = foldText(question);
  if (q.length < 4 || q.length > 160 || ACTION.test(q)) return null;
  const words = [...new Set(q.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)))].slice(0, 4);
  if (words.length === 0) return null;
  const stems = words.map((w) => w.slice(0, Math.max(4, Math.min(w.length - 1, 6))));
  const hits: { chapter: string; text: string }[] = [];
  for (const s of GUIDE_SECTIONS) {
    const title = t(`guide.s.${s.id}.title`);
    for (let n = 1; n <= s.points; n++) {
      const text = t(`guide.s.${s.id}.${n}`);
      const folded = foldText(text);
      if (stems.every((st) => folded.includes(st))) hits.push({ chapter: title, text });
    }
  }
  if (hits.length === 0 || hits.length > 3) return null;
  return { chapter: hits[0]!.chapter, paragraphs: hits.map((h) => h.text) };
}
