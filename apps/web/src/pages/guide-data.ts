import { t } from '@kb/shared';

/** Kapitoly návodu: id a počet odstavců (texty jsou v překladech `guide.s.<id>.<n>`). Barvy kapitol se střídají podle poradí. */
export const SECTIONS: { id: string; points: number }[] = [
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

/** Malá písmena bez diakritiky, aby „sazka“ našlo i „sázka“ (stejně jako hledání v nastavení). */
export const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

export interface GuideChapter {
  id: string;
  index: number;
  title: string;
  shown: string[];
}

/** Kapitoly návodu pro hledaný text: bez textu všechno, jinak kapitoly s odpovídajícím nadpisem (celé) nebo jen odstavci, které slovo obsahují. */
export function searchGuide(query: string): GuideChapter[] {
  const q = fold(query);
  return SECTIONS.map((s, index) => {
    const title = t(`guide.s.${s.id}.title`);
    const paragraphs = Array.from({ length: s.points }, (_, n) => t(`guide.s.${s.id}.${n + 1}`));
    const titleHit = q !== '' && fold(title).includes(q);
    const shown = q === '' || titleHit ? paragraphs : paragraphs.filter((p) => fold(p).includes(q));
    return { id: s.id, index, title, shown };
  }).filter((c) => query.trim() === '' || c.shown.length > 0);
}
