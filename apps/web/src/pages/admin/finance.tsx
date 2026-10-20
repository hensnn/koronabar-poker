import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get } from '../../api';
import { HouseCard } from './house';
import { Link } from '../../router';
import { Card, DataTable, Notice, Spinner, Td } from '../../ui';
import { useSort } from '../../sort';

type TourRow = Finance['tournaments'][number];
type TourKey = 'name' | 'status' | 'entries' | 'gross' | 'pool' | 'fees' | 'houseCut' | 'fund' | 'bounty' | 'overlay' | 'paidOut';
interface Finance {
  house: number;
  funds: { id: string; balance: number }[];
  tournaments: { id: string; name: string; status: string; entries: number; gross: number; pool: number; fees: number; houseCut: number; fund: number; overlay: number; bounty: number; paidOut: number }[];
}

/** Přehled pro pokladníka: kolik turnaje vybraly, kam peníze šly, kolik má herna a kolik jsou fondy. */
export function FinancePage() {
  const [data, setData] = useState<Finance | null>(null);
  const [error, setError] = useState('');
  const tours = useSort<TourRow, TourKey>(
    { key: 'name', dir: 'asc' },
    { name: (x) => x.name, status: (x) => t(`tournament.status.${x.status}`), entries: (x) => x.entries, gross: (x) => x.gross, pool: (x) => x.pool, fees: (x) => x.fees, houseCut: (x) => x.houseCut, fund: (x) => x.fund, bounty: (x) => x.bounty, overlay: (x) => x.overlay, paidOut: (x) => x.paidOut },
  );
  const funds = useSort<{ id: string; balance: number }, 'id' | 'balance'>({ key: 'balance', dir: 'desc' }, { id: (f) => f.id, balance: (f) => f.balance });
  const load = useCallback(() => {
    get<Finance>('/api/admin/finance')
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;
  const sum = (k: 'gross' | 'pool' | 'fees' | 'houseCut' | 'fund' | 'overlay' | 'bounty' | 'paidOut') => data.tournaments.reduce((n, x) => n + x[k], 0);
  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-heading text-2xl font-bold">{t('finance.title')}</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        <HouseCard onChange={load} />
        <Card title={t('finance.funds')}>
          <ul>
            <li className="flex justify-between text-sm text-muted">
              <span>{funds.head('id', t('finance.fundName'))}</span>
              <span>{funds.head('balance', t('finance.fundBalance'))}</span>
            </li>
            {funds.sorted(data.funds).map((f) => (
              <li key={f.id} className="flex justify-between">
                <span>{f.id}</span>
                <span className="font-mono">{f.balance}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {data.tournaments.length === 0 ? (
        <Notice>{t('finance.empty')}</Notice>
      ) : (
        <DataTable head={[tours.head('name', t('finance.tournament')), tours.head('status', t('finance.status')), tours.head('entries', t('finance.entries')), tours.head('gross', t('finance.gross')), tours.head('pool', t('finance.pool')), tours.head('fees', t('finance.fees')), tours.head('houseCut', t('finance.houseCut')), tours.head('fund', t('finance.fund')), tours.head('bounty', t('finance.bounty')), tours.head('overlay', t('finance.overlay')), tours.head('paidOut', t('finance.paidOut'))]}>
          {tours.sorted(data.tournaments).map((x) => (
            <tr key={x.id}>
              <Td>
                <Link to={`/turnaj/${x.id}`} className="underline">
                  {x.name}
                </Link>
              </Td>
              <Td>{t(`tournament.status.${x.status}`)}</Td>
              <Td className="font-mono">{x.entries}</Td>
              <Td className="font-mono">{x.gross}</Td>
              <Td className="font-mono">{x.pool}</Td>
              <Td className="font-mono">{x.fees}</Td>
              <Td className="font-mono">{x.houseCut}</Td>
              <Td className="font-mono">{x.fund}</Td>
              <Td className="font-mono">{x.bounty}</Td>
              <Td className="font-mono">{x.overlay}</Td>
              <Td className="font-mono">{x.paidOut}</Td>
            </tr>
          ))}
          <tr className="font-medium">
            <Td>{t('finance.totals')}</Td>
            <Td />
            <Td />
            <Td className="font-mono">{sum('gross')}</Td>
            <Td className="font-mono">{sum('pool')}</Td>
            <Td className="font-mono">{sum('fees')}</Td>
            <Td className="font-mono">{sum('houseCut')}</Td>
            <Td className="font-mono">{sum('fund')}</Td>
            <Td className="font-mono">{sum('bounty')}</Td>
            <Td className="font-mono">{sum('overlay')}</Td>
            <Td className="font-mono">{sum('paidOut')}</Td>
          </tr>
        </DataTable>
      )}
      <p className="text-sm text-muted">{t('finance.note')}</p>
    </div>
  );
}
