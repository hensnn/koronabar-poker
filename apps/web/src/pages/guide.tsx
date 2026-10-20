import { useState } from 'react';
import { t } from '@kb/shared';
import { searchGuide } from './guide-data';

// Celé názvy tříd, aby je Tailwind našel; barvy jsou jen tokeny motivu.
const TONES = ['border-l-success', 'border-l-info', 'border-l-warning', 'border-l-accent'] as const;

/** Podrobný návod: kapitoly se otevírají kliknutím; políčko nahoře vyhledává v nadpisech i odstavcích. */
export function Guide() {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const chapters = searchGuide(query);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">{t('guide.intro')}</p>
      <input
        type="search"
        aria-label={t('guide.search')}
        placeholder={t('guide.searchHint')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full rounded-sm border border-line bg-surface px-3 py-2 text-text"
      />
      {q !== '' && <p className="text-sm text-muted">{chapters.length > 0 ? t('guide.results', { n: chapters.length }) : t('guide.noResults')}</p>}
      {chapters.map(({ id, index, title, shown }) => (
        <details key={id + (q ? 'q' : '')} className={`rounded-md border border-line border-l-4 bg-surface ${TONES[index % TONES.length]}`} open={q !== '' || index === 0}>
          <summary className="cursor-pointer px-3 py-2 font-semibold">{title}</summary>
          <ul className="flex flex-col px-5 pb-3 pt-1 gap-1.5">
            {shown.map((p, n) => (
              <li key={n} className="list-disc">
                {p}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

export function GuidePage() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-heading text-2xl font-bold">{t('guide.title')}</h1>
      <Guide />
    </div>
  );
}
