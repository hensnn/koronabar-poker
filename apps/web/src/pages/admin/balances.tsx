import { useEffect, useMemo, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get } from '../../api';
import { Badge, Card, DataTable, Notice, Td } from '../../ui';

interface Row {
  userId: string;
  nickname: string;
  status: string;
  balance: number;
  lastMoveAt: number | null;
}
interface Data {
  rows: Row[];
  totals: { wallets: number; house: number; players: number };
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const num = (n: number) => n.toLocaleString('cs-CZ');

/** Pokladník: přehled stavů účtů všech hráčů s hledáním a součty. */
export function BalancesCard({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    get<Data>('/api/admin/balances')
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, [refreshKey]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => fold(r.nickname).includes(fold(query))), [data, query]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) return null;
  return (
    <Card title={t('cashier.balances')}>
      <p className="mb-2 text-sm text-muted">{t('cashier.balancesHelp')}</p>
      <p className="mb-2 font-mono text-sm">{t('cashier.balancesTotal', { wallets: num(data.totals.wallets), house: num(data.totals.house), players: data.totals.players })}</p>
      <input type="search" aria-label={t('cashier.balancesSearch')} placeholder={t('cashier.balancesSearch')} value={query} onChange={(e) => setQuery(e.target.value)} className="mb-2 w-full rounded-sm border border-line bg-surface px-3 py-2 text-text" />
      <DataTable head={[t('cashier.user'), t('cashier.balanceCol'), t('cashier.statusCol'), t('cashier.lastMove')]}>
        {rows.map((r) => (
          <tr key={r.userId}>
            <Td>{r.nickname}</Td>
            <Td className={`font-mono ${r.balance < 0 ? 'text-danger' : ''}`}>{num(r.balance)}</Td>
            <Td>{r.status === 'active' ? '' : <Badge tone="warning">{r.status}</Badge>}</Td>
            <Td>{r.lastMoveAt ? new Date(r.lastMoveAt).toLocaleString('cs-CZ') : t('cashier.noMove')}</Td>
          </tr>
        ))}
      </DataTable>
    </Card>
  );
}
