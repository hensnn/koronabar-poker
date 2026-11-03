import { t } from '@kb/shared';
import { LobbyPage } from './lobby';
import { TournamentsPage } from './tournaments';
import { useFeatures } from '../features';
import { lazyPage } from '../lazy';
import { Suspense } from 'react';
import { Spinner } from '../ui';

const EveningsPage = lazyPage(() => import('./evenings'), 'EveningsPage');

/** Stoly a večery: turnaje nahoře, cash game uprostřed a herní večery dole, každé ve vlastním výrazně odděleném bloku. */
export function TablesPage() {
  const features = useFeatures();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="sr-only">{t('nav.tables')}</h1>
      <section aria-label={t('tables.tournaments')} className="rounded-lg border border-line border-l-8 border-l-info p-2 sm:p-3">
        <TournamentsPage />
      </section>
      <section aria-label={t('tables.cash')} className="rounded-lg border border-line border-l-8 border-l-success p-2 sm:p-3">
        <LobbyPage />
      </section>
      {features.evenings && (
        <section aria-label={t('tables.evenings')} className="rounded-lg border border-line border-l-8 border-l-accent p-2 sm:p-3">
          <Suspense fallback={<Spinner label={t('app.loading')} />}>
            <EveningsPage />
          </Suspense>
        </section>
      )}
    </div>
  );
}
