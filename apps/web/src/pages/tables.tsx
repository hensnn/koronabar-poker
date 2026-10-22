import { t } from '@kb/shared';
import { LobbyPage } from './lobby';
import { TournamentsPage } from './tournaments';

/** Stoly: turnaje nahoře, cash game dole, každé ve vlastním výrazně odděleném bloku. */
export function TablesPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="sr-only">{t('nav.tables')}</h1>
      <section aria-label={t('tables.tournaments')} className="rounded-lg border border-line border-l-8 border-l-info p-2 sm:p-3">
        <TournamentsPage />
      </section>
      <section aria-label={t('tables.cash')} className="rounded-lg border border-line border-l-8 border-l-success p-2 sm:p-3">
        <LobbyPage />
      </section>
    </div>
  );
}
