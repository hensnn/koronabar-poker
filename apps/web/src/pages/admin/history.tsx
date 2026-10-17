import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get, post } from '../../api';
import { navigate } from '../../router';
import { Badge, Button, Card, DataTable, Notice, NumInput, Td } from '../../ui';

type Kind = 'tournament' | 'cashTable' | 'liveCash' | 'poll' | 'evening' | 'sharedHand';
interface Item {
  kind: Kind;
  id: string;
  name: string;
  status: string;
  at: number;
  detail: string;
}
interface Overview {
  items: Item[];
  hands: { total: number; oldest: number | null };
}

const KINDS: Kind[] = ['tournament', 'cashTable', 'liveCash', 'poll', 'evening', 'sharedHand'];
const LINK: Partial<Record<Kind, (id: string) => string>> = { tournament: (id) => `/turnaj/${id}`, poll: (id) => `/ankety/${id}`, evening: (id) => `/vecery/${id}`, liveCash: (id) => `/zivy-cash/${id}` };

/** Správa → Historie: vše uložené, co už skončilo, s možností nevratně smazat (oprávnění historie.spravovat). */
export function HistoryPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [days, setDays] = useState(90);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const reload = useCallback(() => {
    get<Overview>('/api/admin/history')
      .then(setData)
      .catch((e) => setMsg({ kind: 'error', text: errorText(e) }));
  }, []);
  useEffect(reload, [reload]);
  const remove = async (x: Item) => {
    if (!confirm(t('history.deleteConfirm', { name: x.name }))) return;
    try {
      await del(`/api/admin/history/${x.kind}/${encodeURIComponent(x.id)}`);
      reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    }
  };
  const purge = async () => {
    if (!confirm(t('history.purgeConfirm', { days }))) return;
    try {
      const r = await post<{ deleted: number }>('/api/admin/history/purge-hands', { olderThanDays: days });
      setMsg({ kind: 'success', text: t('history.purged', { n: r.deleted }) });
      reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    }
  };
  const items = (data?.items ?? []).filter((x) => kind === 'all' || x.kind === kind);
  const count = (k: Kind) => (data?.items ?? []).filter((x) => x.kind === k).length;
  return (
    <div className="flex flex-col gap-3">
      <Notice>{t('history.info')}</Notice>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div role="tablist" className="flex flex-wrap gap-2">
        <button role="tab" aria-selected={kind === 'all'} onClick={() => setKind('all')} className={`rounded-md border border-line px-3 py-1 ${kind === 'all' ? 'bg-primary text-on-primary' : 'bg-surface'}`}>
          {t('history.all')} ({data?.items.length ?? 0})
        </button>
        {KINDS.map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)} className={`rounded-md border border-line px-3 py-1 ${kind === k ? 'bg-primary text-on-primary' : 'bg-surface'}`}>
            {t(`history.kind.${k}`)} ({count(k)})
          </button>
        ))}
      </div>
      {items.length === 0 && <Notice>{t('history.empty')}</Notice>}
      {items.length > 0 && (
        <DataTable head={[t('history.type'), t('templates.name'), t('admin.status'), t('history.when'), t('history.detail'), '']}>
          {items.map((x) => (
            <tr key={`${x.kind}:${x.id}`}>
              <Td>
                <Badge>{t(`history.kind.${x.kind}`)}</Badge>
              </Td>
              <Td>
                <strong>{x.name}</strong>
              </Td>
              <Td>{t(`history.status.${x.status}`)}</Td>
              <Td className="text-sm">{new Date(x.at).toLocaleString('cs-CZ')}</Td>
              <Td className="text-sm">{x.detail}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {LINK[x.kind] && <Button onClick={() => navigate(LINK[x.kind]!(x.id))}>{t('tournament.open')}</Button>}
                  <Button variant="danger" onClick={() => void remove(x)}>
                    {t('history.delete')}
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </DataTable>
      )}
      <Card title={t('history.handsTitle')}>
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">{t('history.handsInfo', { total: data?.hands.total ?? 0, oldest: data?.hands.oldest ? new Date(data.hands.oldest).toLocaleDateString('cs-CZ') : '–' })}</p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
              {t('history.olderThan')}
              <NumInput className="w-24" min={0} value={days} onChange={setDays} />
              {t('unit.d')}
            </label>
            <Button variant="danger" onClick={() => void purge()}>
              {t('history.purge')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
