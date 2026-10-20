import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../../api';
import { Link } from '../../router';
import { Button, Card, DataTable, NumInput, Notice, Spinner, TextInput, Td } from '../../ui';

interface Finance {
  house: number;
  funds: { id: string; balance: number }[];
  tournaments: { id: string; name: string; status: string; entries: number; gross: number; pool: number; fees: number; houseCut: number; fund: number; overlay: number; bounty: number; paidOut: number }[];
}

/** Přehled pro pokladníka: kolik turnaje vybraly, kam peníze šly, kolik má herna a kolik jsou fondy. */
export function FinancePage() {
  const [data, setData] = useState<Finance | null>(null);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState(0);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const load = useCallback(() => {
    get<Finance>('/api/admin/finance')
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  const moveHouse = async (direction: 'in' | 'out') => {
    setMsg(null);
    try {
      const r = await post<{ done: boolean }>('/api/admin/wallet/house', { direction, amount, reason });
      setMsg({ kind: 'success', text: t(r.done ? 'finance.houseDone' : 'finance.housePending') });
      setAmount(0);
      setReason('');
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    }
  };
  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;
  const sum = (k: 'gross' | 'pool' | 'fees' | 'houseCut' | 'fund' | 'overlay' | 'bounty' | 'paidOut') => data.tournaments.reduce((n, x) => n + x[k], 0);
  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-heading text-2xl font-bold">{t('finance.title')}</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        <Card title={t('finance.house')}>
          <p className="font-mono text-2xl">{data.house}</p>
          <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
            <p className="text-sm text-muted">{t('finance.houseHelp')}</p>
            <label className="flex flex-col gap-1 text-sm">
              {t('finance.houseAmount')}
              <NumInput value={amount} min={0} onChange={setAmount} />
            </label>
            <TextInput label={t('finance.houseReason')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={amount <= 0 || !reason.trim()} onClick={() => void moveHouse('in')}>{t('finance.houseIn')}</Button>
              <Button disabled={amount <= 0 || !reason.trim() || amount > data.house} onClick={() => void moveHouse('out')}>{t('finance.houseOut')}</Button>
            </div>
            {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
          </div>
        </Card>
        <Card title={t('finance.funds')}>
          <ul>
            {data.funds.map((f) => (
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
        <DataTable head={[t('finance.tournament'), t('finance.status'), t('finance.entries'), t('finance.gross'), t('finance.pool'), t('finance.fees'), t('finance.houseCut'), t('finance.fund'), t('finance.bounty'), t('finance.overlay'), t('finance.paidOut')]}>
          {data.tournaments.map((x) => (
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
