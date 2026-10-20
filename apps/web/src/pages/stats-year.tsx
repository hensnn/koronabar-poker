import { useCallback, useEffect, useState } from 'react';
import { currencyFormsOf, currencyWord, t, type YearField, type YearStats } from '@kb/shared';
import { errorText, get, post } from '../api';
import { useSettings } from '../settings';
import { Button, Card, Notice, Select, Spinner } from '../ui';
import { BarChart } from './charts';

interface Payload {
  stats: Partial<YearStats> & { year: number };
  years: number[];
  fields: YearField[];
}

const SIGNED: YearField[] = ['net', 'tournamentNet', 'cashNet', 'liveNet', 'won', 'lost'];
const COUNTS: YearField[] = ['hands', 'tournaments'];

/** Statistiky → Rok: výdělek v kalendářním roce, nabité a strhnuté žetony, zůstatky a graf po měsících (jen povolené údaje). */
export function YearView() {
  const settings = useSettings();
  const forms = currencyFormsOf(settings.values);
  const [year, setYear] = useState<number | null>(null);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const load = useCallback((y: number | null) => {
    get<Payload>(`/api/stats/year${y ? `?year=${y}` : ''}`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => load(year), [load, year]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) return <Spinner label={t('app.loading')} />;
  const s = data.stats;
  const shown = data.fields.filter((f) => f !== 'monthly' && s[f] !== undefined);
  const value = (f: YearField): string => {
    const v = Number(s[f]);
    const n = `${SIGNED.includes(f) && v > 0 ? '+' : ''}${v.toLocaleString('cs-CZ')}`;
    return COUNTS.includes(f) ? n : `${n} ${currencyWord(v, forms)}`;
  };
  const tone = (f: YearField): string => {
    const v = Number(s[f]);
    return SIGNED.includes(f) ? (v > 0 ? 'text-success' : v < 0 ? 'text-danger' : '') : '';
  };
  const sendMail = async () => {
    setMsg(null);
    try {
      await post('/api/stats/year/email', { year: data.stats.year });
      setMsg({ kind: 'success', text: t('year.emailSent') });
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    }
  };
  const monthly = data.fields.includes('monthly') && s.monthly ? s.monthly : null;
  return (
    <section className="flex flex-col gap-3" aria-label={t('year.title')}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="font-heading text-lg font-bold">{t('year.title')}</h2>
        <div className="flex items-end gap-2">
          <Select label={t('year.pick')} value={String(data.stats.year)} onChange={(e) => setYear(Number(e.target.value))}>
            {data.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
          <Button onClick={() => void sendMail()}>{t('year.sendEmail')}</Button>
        </div>
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {shown.length === 0 && !monthly ? (
        <Notice>{t('year.empty')}</Notice>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {shown.map((f) => (
            <div key={f} className="rounded-md border border-line bg-surface p-3" title={t(`year.field.${f}.help`) === `year.field.${f}.help` ? undefined : t(`year.field.${f}.help`)}>
              <div className="text-xs text-muted">{t(`year.field.${f}`)}</div>
              <div className={`font-mono text-lg font-bold ${tone(f)}`}>{value(f)}</div>
            </div>
          ))}
        </div>
      )}
      {monthly && (
        <Card title={t('year.field.monthly')}>
          <BarChart
            bars={monthly.map((v, i) => ({ x: Date.UTC(data.stats.year, i, 15), v, tip: `${t(`year.month.${i + 1}`)}: ${v > 0 ? '+' : ''}${v.toLocaleString('cs-CZ')} ${currencyWord(v, forms)}` }))}
            label={t('year.monthly.help')}
          />
        </Card>
      )}
      <p className="text-xs text-muted">{t('year.note')}</p>
    </section>
  );
}
