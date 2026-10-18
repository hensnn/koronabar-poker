import { useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get } from '../api';
import { onSocket } from '../net';
import { rankColorClass } from '../progress-client';
import { Card, DataTable, Notice, Spinner, Td } from '../ui';
import { AchievementAdmin, AchievementShowcase } from './achievements';
import { RatingSection } from './rating';
import { useFeatures } from '../features';
import { RatingAdmin } from './rating-admin';

interface Me {
  xp: number;
  level: number;
  into: number;
  need: number;
  rank: { name: string; icon: string; color: string; minLevel: number };
  recent: { source: string; amount: number; day: string; ref: string }[];
}
interface LevelRow {
  level: number;
  need: number;
  total: number;
  rank: string;
}

export function ProgressPage() {
  const features = useFeatures();
  const [me, setMe] = useState<Me | null>(null);
  const [levels, setLevels] = useState<LevelRow[]>([]);
  const [error, setError] = useState('');
  const load = () => {
    get<Me>('/api/progress/me').then(setMe).catch((e) => setError(errorText(e)));
    get<{ levels: LevelRow[] }>('/api/progress/table?count=30').then((d) => setLevels(d.levels)).catch(() => undefined);
  };
  useEffect(() => {
    load();
    return onSocket('progress:level', load);
  }, []);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!me) return <Spinner label={t('app.loading')} />;
  const pct = Math.min(100, Math.round((me.into / me.need) * 100));
  return (
    <main className="flex flex-col gap-3">
      <h1 className="font-heading text-2xl font-bold">{t('xp.title')}</h1>
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <span className={`text-5xl ${rankColorClass(me.rank.color)}`} aria-hidden>
            {me.rank.icon}
          </span>
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <strong className="text-xl">
              {me.rank.name} · {t('xp.level', { n: me.level })}
            </strong>
            <progress className="w-full" max={me.need} value={me.into} aria-label={t('xp.toNext', { n: me.need - me.into })} />
            <span className="text-sm text-muted">
              {t('xp.toNext', { n: me.need - me.into })} ({pct} %) · {t('xp.total', { n: me.xp })}
            </span>
          </div>
        </div>
      </Card>
      {features.rating && <RatingSection />}
      <AchievementShowcase />
      <Card title={t('xp.recent')}>
        {me.recent.length === 0 ? (
          <p className="text-muted">{t('xp.none')}</p>
        ) : (
          <DataTable head={[t('stats.when'), t('xp.title'), 'XP']}>
            {me.recent.map((r, i) => (
              <tr key={i}>
                <Td>{r.day}</Td>
                <Td>{t(`xp.src.${r.source}`)}</Td>
                <Td className="font-mono">+{r.amount}</Td>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>
      <Card title={t('xp.preview')}>
        <DataTable head={[t('xp.level', { n: '' }).trim(), 'XP', 'Σ XP', t('xp.title')]}>
          {levels.map((l) => (
            <tr key={l.level} className={l.level === me.level ? 'font-bold' : ''}>
              <Td>{l.level}</Td>
              <Td className="font-mono">{l.need}</Td>
              <Td className="font-mono">{l.total}</Td>
              <Td>{l.rank}</Td>
            </tr>
          ))}
        </DataTable>
      </Card>
      <AchievementAdmin />
      <RatingAdmin />
    </main>
  );
}
