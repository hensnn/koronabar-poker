import { useEffect, useState } from 'react';
import { CATEGORY_GROUPS, t, type CategoryGroup, type CategoryResult } from '@kb/shared';
import { errorText, get } from '../api';
import { Card, Notice, Spinner } from '../ui';

const MEDALS = ['🥇', '🥈', '🥉'];
const PERCENT = ['winRate', 'itmRate'];
const SIGNED = ['total', 'tournamentNet', 'cashNet', 'bounty'];

function format(id: string, v: number): string {
  if (PERCENT.includes(id)) return `${v.toLocaleString('cs-CZ')} %`;
  if (id === 'avgPlace') return v.toFixed(1);
  const n = Math.round(v).toLocaleString('cs-CZ');
  return SIGNED.includes(id) && v > 0 ? `+${n}` : n;
}

/** Jeden řádek s pruhem: délka pruhu je podíl na nejlepší hodnotě v kategorii (u „nižší je lepší“ obráceně). */
function Bar({ ratio, className }: { ratio: number; className: string }) {
  const w = Math.max(2, Math.round(Math.min(1, Math.max(0, ratio)) * 100));
  return (
    <svg viewBox="0 0 100 6" preserveAspectRatio="none" className={`h-1.5 w-full ${className}`} aria-hidden="true">
      <rect width="100" height="6" rx="2" className="fill-line" />
      <rect width={w} height="6" rx="2" fill="currentColor" />
    </svg>
  );
}

function CategoryCard({ c, meId }: { c: CategoryResult; meId: string }) {
  const values = c.entries.map((e) => e.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const ratio = (v: number): number => {
    if (hi === lo) return 1;
    // nejlepší hodnota = plný pruh, ostatní podle vzdálenosti od nejhorší zobrazené
    return c.best === 'high' ? (v - lo) / (hi - lo) : (hi - v) / (hi - lo);
  };
  return (
    <Card title={t(`cat.${c.id}`)}>
      <p className="mb-2 text-xs text-muted">{t(`cat.${c.id}.help`)}</p>
      <ol className="flex flex-col gap-2">
        {c.entries.map((e, i) => (
          <li key={e.userId} className={e.userId === meId ? 'rounded-sm bg-raised px-1' : 'px-1'}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate">
                <span aria-hidden="true">{MEDALS[i] ?? `${i + 1}.`}</span> <strong>{e.nickname}</strong>
              </span>
              <span className="font-mono">{format(c.id, e.value)}</span>
            </div>
            <Bar ratio={i === 0 ? 1 : Math.max(0.05, ratio(e.value))} className={i === 0 ? 'text-success' : 'text-primary'} />
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Statistiky → Přehled hráčů: „kdo je v čem nejlepší“ – pořadí nejlepších hráčů v každé kategorii. */
export function CategoriesView({ meId }: { meId: string }) {
  const [cats, setCats] = useState<CategoryResult[] | null>(null);
  const [error, setError] = useState('');
  const [group, setGroup] = useState<CategoryGroup | 'all'>('all');
  useEffect(() => {
    get<{ categories: CategoryResult[] }>('/api/stats/categories')
      .then((d) => setCats(d.categories))
      .catch((e) => setError(errorText(e)));
  }, []);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!cats) return <Spinner label={t('app.loading')} />;
  const firsts = cats.filter((c) => c.entries[0]?.userId === meId).length;
  const shown = cats.filter((c) => group === 'all' || c.group === group);
  return (
    <section className="flex flex-col gap-3" aria-label={t('cat.title')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-lg font-bold">{t('cat.title')}</h2>
        <div role="tablist" className="flex flex-wrap gap-1">
          {(['all', ...CATEGORY_GROUPS] as const).map((g) => (
            <button key={g} role="tab" aria-selected={group === g} onClick={() => setGroup(g)} className={`rounded-md border border-line px-2 py-0.5 text-sm ${group === g ? 'bg-primary text-on-primary' : 'bg-surface'}`}>
              {t(`cat.group.${g}`)}
            </button>
          ))}
        </div>
      </div>
      {cats.length === 0 ? (
        <Notice>{t('cat.empty')}</Notice>
      ) : (
        <>
          <p className="text-sm text-muted">{t('cat.mine', { n: firsts, total: cats.length })}</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((c) => (
              <CategoryCard key={c.id} c={c} meId={meId} />
            ))}
          </div>
          <p className="text-xs text-muted">{t('cat.note')}</p>
        </>
      )}
    </section>
  );
}
