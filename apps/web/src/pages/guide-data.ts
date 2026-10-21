import { t } from '@kb/shared';

import { GUIDE_SECTIONS } from '@kb/shared';

/** Kapitoly návodu (sdílené s odpovědí asistenta z návodu). */
export const SECTIONS = GUIDE_SECTIONS;

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
