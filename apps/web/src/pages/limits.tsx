import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post, put } from '../api';
import { Button, Card, Notice, TextInput } from '../ui';

type Fields = Record<string, number>;
interface View {
  enabled: boolean;
  limits: Fields;
  pending: Record<string, { value: number; at: number }>;
  global: Fields;
  effective: Fields;
  breakUntil: number | null;
  usage: Record<'day' | 'week' | 'month' | 'evening', { buyIns: number; loss: number }>;
  sessionMinutes: number;
  loosenDelayHours: number;
  maxBreakDays: number;
  fields: string[];
}

const when = (ms: number) => new Date(ms).toLocaleString();

/** Osobní limity: nastavení, spotřeba za období, čekající uvolnění a pauza od hry. */
export function LimitsSection() {
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [hours, setHours] = useState('24');
  const load = useCallback(() => {
    get<View>('/api/limits/me')
      .then((v) => {
        setView(v);
        setDraft(Object.fromEntries(v.fields.map((f) => [f, v.limits[f] ? String(v.limits[f]) : ''])));
      })
      .catch((e) => setMsg({ kind: 'error', text: errorText(e) }));
  }, []);
  useEffect(load, [load]);
  if (!view) return null;
  if (!view.enabled) return <Notice>{t('limits.disabled')}</Notice>;

  const save = async () => {
    try {
      const limits = Object.fromEntries(view.fields.map((f) => [f, Number(draft[f] || 0)]));
      const r = await put<{ applied: string[]; delayed: string[] }>('/api/limits/me', { limits });
      setMsg({ kind: 'success', text: r.delayed.length ? t('limits.savedDelayed', { time: when(Date.now() + view.loosenDelayHours * 3600_000) }) : t('limits.saved') });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    }
  };

  return (
    <Card title={t('limits.title')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('limits.help', { hours: view.loosenDelayHours })}</p>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          {(['day', 'week', 'month', 'evening'] as const).map((p) => (
            <div key={p} className="flex justify-between gap-3">
              <dt className="text-muted">{t(`limits.usage${p[0]!.toUpperCase()}${p.slice(1)}`)}</dt>
              <dd className="font-mono">{t('limits.usageLine', { buyIns: view.usage[p].buyIns, loss: view.usage[p].loss })}</dd>
            </div>
          ))}
          {view.sessionMinutes > 0 && <p className="text-muted">{t('limits.session', { minutes: view.sessionMinutes })}</p>}
        </dl>
        <div className="grid gap-3 sm:grid-cols-2">
          {view.fields.map((f) => (
            <div key={f} className="flex flex-col gap-1">
              <TextInput label={t(`limits.field.${f}`)} type="number" min={0} value={draft[f] ?? ''} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} />
              {view.pending[f] && <p className="text-xs text-muted">{t('limits.pending', { value: view.pending[f]!.value || '∞', time: when(view.pending[f]!.at) })}</p>}
              {view.global[f] ? <p className="text-xs text-muted">{t('limits.global', { value: view.global[f] })}</p> : null}
            </div>
          ))}
        </div>
        <div>
          <Button variant="primary" onClick={() => void save()}>
            {t('limits.save')}
          </Button>
        </div>
        <section className="flex flex-col gap-2 border-t border-line pt-3">
          <h3 className="font-bold">{t('limits.break')}</h3>
          <p className="text-sm text-muted">{t('limits.breakHelp')}</p>
          {view.breakUntil && <Notice>{t('limits.breakActive', { time: when(view.breakUntil) })}</Notice>}
          <div className="flex flex-wrap items-end gap-2">
            <TextInput label={t('limits.breakHours')} type="number" min={1} max={view.maxBreakDays * 24} value={hours} onChange={(e) => setHours(e.target.value)} />
            <Button
              variant="danger"
              onClick={async () => {
                if (!confirm(t('limits.breakConfirm', { hours }))) return;
                try {
                  await post('/api/limits/break', { hours: Number(hours) });
                  setMsg(null);
                  load();
                } catch (e) {
                  setMsg({ kind: 'error', text: errorText(e) });
                }
              }}
            >
              {t('limits.breakStart')}
            </Button>
          </div>
        </section>
      </div>
    </Card>
  );
}
