import { useState } from 'react';
import { t } from '@kb/shared';
import { Link } from '../router';
import { Card } from '../ui';
import { SECTIONS } from './guide-data';

// Celé názvy tříd, aby je Tailwind našel; barvy jsou jen tokeny motivu.
const TONES = ['border-l-success', 'border-l-info', 'border-l-warning', 'border-l-accent'] as const;

/** Podrobný návod: kapitoly se otevírají kliknutím. */
export function Guide() {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">{t('guide.intro')}</p>
      {SECTIONS.map((s, i) => (
        <details key={s.id} className={`rounded-md border border-line border-l-4 bg-surface ${TONES[i % TONES.length]}`} open={i === 0}>
          <summary className="cursor-pointer px-3 py-2 font-semibold">{t(`guide.s.${s.id}.title`)}</summary>
          <ul className="flex flex-col px-5 pb-3 pt-1 gap-1.5">
            {Array.from({ length: s.points }, (_, n) => (
              <li key={n} className="list-disc">
                {t(`guide.s.${s.id}.${n + 1}`)}
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

const HIDE_KEY = 'kb.quickStartHidden';
const read = () => {
  try {
    return window.localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
};

/** Velmi stručný start pro nového hráče na hlavní stránce; jde skrýt (pamatuje se v tomto prohlížeči). */
export function QuickStart() {
  const [hidden, setHidden] = useState(read);
  if (hidden) return null;
  const hide = () => {
    try {
      window.localStorage.setItem(HIDE_KEY, '1');
    } catch {
      /* bez uložení se karta ukáže znovu při dalším načtení */
    }
    setHidden(true);
  };
  return (
    <Card
      title={t('guide.quick.title')}
      actions={
        <button type="button" className="rounded-md px-2 text-sm text-muted underline" onClick={hide}>
          {t('guide.quick.hide')}
        </button>
      }
    >
      <ol className="flex list-decimal flex-col gap-1 pl-5">
        {[1, 2, 3, 4, 5].map((n) => (
          <li key={n}>{t(`guide.quick.${n}`)}</li>
        ))}
      </ol>
      <p className="mt-2">
        <Link to="/navod" className="underline">
          {t('guide.quick.more')}
        </Link>
      </p>
    </Card>
  );
}
