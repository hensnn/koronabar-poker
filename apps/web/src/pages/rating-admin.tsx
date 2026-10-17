import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../api';
import { can, useSession } from '../session';
import { Badge, Button, Card, DataTable, Notice, Td } from '../ui';

interface XpReport {
  changed: number;
  hands: number;
  tournaments: number;
  rows: { nickname: string; before: number; after: number; levelBefore: number; levelAfter: number }[];
}
interface RatingReport {
  tournaments: number;
  cashDays: number;
  resets: number;
  changed: number;
  rows: { nickname: string; scope: string; before: number; after: number }[];
}
interface Flag {
  id: number;
  kind: string;
  from: string;
  to: string;
  detail: Record<string, number>;
  status: string;
  note: string | null;
  createdAt: number;
}

const sign = (n: number) => (n > 0 ? `+${n}` : String(n));

/** Zpětný přepočet XP a ratingu z historie s náhledem dopadu před potvrzením. */
function RecomputePanel() {
  const [report, setReport] = useState<{ xp?: XpReport; rating?: RatingReport } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const run = async (preview: boolean) => {
    setBusy(true);
    setMsg('');
    try {
      const r = await post<{ xp?: XpReport; rating?: RatingReport }>('/api/recompute', { what: 'both', preview });
      if (preview) setReport(r);
      else {
        setReport(null);
        setMsg(t('rating.recomputeDone'));
      }
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const nothing = report && (report.xp?.changed ?? 0) === 0 && (report.rating?.changed ?? 0) === 0;
  return (
    <Card title={t('rating.recompute')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('rating.recomputeHelp')}</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void run(true)}>
            {t('rating.recomputePreview')}
          </Button>
          {report && !nothing && (
            <Button variant="primary" disabled={busy} onClick={() => confirm(t('rating.recomputeHelp')) && void run(false)}>
              {t('rating.recomputeApply')}
            </Button>
          )}
        </div>
        {msg && <Notice>{msg}</Notice>}
        {nothing && <Notice>{t('rating.recomputeNone')}</Notice>}
        {report?.xp && report.xp.changed > 0 && (
          <section className="flex flex-col gap-1">
            <strong>{t('rating.recomputeXp', { n: report.xp.changed, h: report.xp.hands, t: report.xp.tournaments })}</strong>
            <DataTable head={[t('stats.player'), 'XP', 'Level']}>
              {report.xp.rows.map((r, i) => (
                <tr key={i}>
                  <Td>{r.nickname}</Td>
                  <Td className="font-mono">
                    {r.before} → {r.after} ({sign(r.after - r.before)})
                  </Td>
                  <Td className="font-mono">
                    {r.levelBefore} → {r.levelAfter}
                  </Td>
                </tr>
              ))}
            </DataTable>
          </section>
        )}
        {report?.rating && report.rating.changed > 0 && (
          <section className="flex flex-col gap-1">
            <strong>{t('rating.recomputeRating', { n: report.rating.changed, t: report.rating.tournaments, d: report.rating.cashDays, r: report.rating.resets })}</strong>
            <DataTable head={[t('stats.player'), t('rating.title'), '']}>
              {report.rating.rows.map((r, i) => (
                <tr key={i}>
                  <Td>{r.nickname}</Td>
                  <Td>{r.scope === 'cash' ? t('rating.cash') : t('rating.tournament')}</Td>
                  <Td className="font-mono">
                    {r.before} → {r.after} ({sign(r.after - r.before)})
                  </Td>
                </tr>
              ))}
            </DataTable>
          </section>
        )}
      </div>
    </Card>
  );
}

/** Podezření na zneužití ratingu ke kontrole (opakované heads-upy, jednosměrný tok žetonů). */
function FlagsPanel() {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    get<{ flags: Flag[] }>('/api/rating/flags').then((d) => setFlags(d.flags)).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  const resolve = async (id: number, status: 'dismissed' | 'confirmed') => {
    const note = status === 'confirmed' ? (prompt(t('rating.flagNote')) ?? '') : '';
    try {
      await post(`/api/rating/flags/${id}`, { status, note });
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Card title={t('rating.flags')}>
      {error && <Notice kind="error">{error}</Notice>}
      {flags.length === 0 ? (
        <p className="text-sm text-muted">{t('rating.flagsEmpty')}</p>
      ) : (
        <DataTable head={[t('rating.flagFrom'), t('rating.flagTo'), t('rating.why'), t('rating.flagStatus'), '']}>
          {flags.map((f) => (
            <tr key={f.id}>
              <Td>{f.from}</Td>
              <Td>{f.to}</Td>
              <Td className="text-sm">{f.kind === 'heads_up_pair' ? t('rating.flag.pair', { n: f.detail.count ?? 0 }) : t('rating.flag.flow', { bb: f.detail.bb ?? 0, ratio: f.detail.ratio ?? 0, hands: f.detail.hands ?? 0 })}</Td>
              <Td>
                <Badge tone={f.status === 'open' ? 'warning' : f.status === 'confirmed' ? 'danger' : 'muted'}>{t(`rating.flagState.${f.status}`)}</Badge>
                {f.note && <div className="text-xs text-muted">{f.note}</div>}
              </Td>
              <Td>
                {f.status === 'open' && (
                  <div className="flex gap-1">
                    <Button onClick={() => void resolve(f.id, 'dismissed')}>{t('rating.flagDismiss')}</Button>
                    <Button variant="danger" onClick={() => void resolve(f.id, 'confirmed')}>
                      {t('rating.flagConfirm')}
                    </Button>
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </DataTable>
      )}
    </Card>
  );
}

export function RatingAdmin() {
  const { me } = useSession();
  if (!can(me, 'statistiky.sezony')) return null;
  return (
    <>
      <FlagsPanel />
      <RecomputePanel />
    </>
  );
}
