import { useEffect, useMemo, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get } from '../../api';
import { Badge, Card, DataTable, Fold, Notice, Td } from '../../ui';

interface Row {
  userId: string;
  nickname: string;
  status: string;
  balance: number;
  lastMoveAt: number | null;
}
interface Recon {
  issued: number;
  wallets: number;
  house: number;
  funds: number;
  tables: number;
  tournaments: number;
  external: number;
  issuedBy: { id: number; at: number; kind: string; note: string; amount: number; to: string }[];
  issuedTotal?: number;
  destroyedTotal?: number;
  byKind?: { kind: string; issued: number; destroyed: number; count: number }[];
}
interface Data {
  rows: Row[];
  totals: { wallets: number; house: number; players: number };
  reconciliation: Recon;
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
      <Fold className="mb-3" title={t('cashier.recon.title')}>
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">{t('cashier.recon.help')}</p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 font-mono text-sm">
            <dt className="font-bold">{t('cashier.recon.issued')}</dt>
            <dd className="text-right font-bold">{num(data.reconciliation.issued)}</dd>
            {(['wallets', 'house', 'funds', 'tables', 'tournaments', 'external'] as const).map((k) => (
              <div key={k} className="contents">
                <dt className="text-muted">= {t(`cashier.recon.${k}`)}</dt>
                <dd className="text-right">{num(data.reconciliation[k])}</dd>
              </div>
            ))}
          </dl>
          {data.reconciliation.byKind && (
            <>
              <p className="font-mono text-sm">{t('cashier.recon.mintSummary', { issued: num(data.reconciliation.issuedTotal ?? 0), destroyed: num(data.reconciliation.destroyedTotal ?? 0), net: num(data.reconciliation.issued) })}</p>
              <DataTable head={[t('wallet.kind'), t('cashier.recon.issuedCol'), t('cashier.recon.destroyedCol'), t('cashier.recon.countCol')]}>
                {data.reconciliation.byKind.map((k) => (
                  <tr key={k.kind}>
                    <Td>{t(`ledger.kind.${k.kind}`) === `ledger.kind.${k.kind}` ? k.kind : t(`ledger.kind.${k.kind}`)}</Td>
                    <Td className="font-mono">{k.issued ? num(k.issued) : ''}</Td>
                    <Td className="font-mono">{k.destroyed ? num(k.destroyed) : ''}</Td>
                    <Td className="font-mono">{k.count}×</Td>
                  </tr>
                ))}
              </DataTable>
            </>
          )}
          <DataTable head={[t('wallet.when'), t('wallet.kind'), t('cashier.recon.amount'), t('cashier.recon.to'), t('wallet.note')]}>
            {data.reconciliation.issuedBy.map((m) => (
              <tr key={m.id}>
                <Td>{new Date(m.at).toLocaleString('cs-CZ')}</Td>
                <Td>{t(`ledger.kind.${m.kind}`) === `ledger.kind.${m.kind}` ? m.kind : t(`ledger.kind.${m.kind}`)}</Td>
                <Td className="font-mono">{m.amount > 0 ? `+${num(m.amount)}` : num(m.amount)}</Td>
                <Td>{m.to}</Td>
                <Td>{m.note}</Td>
              </tr>
            ))}
          </DataTable>
        </div>
      </Fold>
      <input type="search" aria-label={t('cashier.balancesSearch')} placeholder={t('cashier.balancesSearch')} value={query} onChange={(e) => setQuery(e.target.value)} className="mb-2 w-full rounded-sm border border-line bg-surface px-3 py-2 text-text" />
      <DataTable head={[t('cashier.user'), t('cashier.balanceCol'), t('cashier.statusCol'), t('cashier.lastMove')]}>
        {rows.map((r) => (
          <tr key={r.userId}>
            <Td>{r.nickname}</Td>
            <Td className={`font-mono ${r.balance < 0 ? 'text-danger' : ''}`}>{num(r.balance)}</Td>
            <Td>
              <Badge tone={r.status === 'active' ? 'success' : 'warning'}>{t(`cashier.status.${r.status}`) === `cashier.status.${r.status}` ? r.status : t(`cashier.status.${r.status}`)}</Badge>
            </Td>
            <Td>{r.lastMoveAt ? new Date(r.lastMoveAt).toLocaleString('cs-CZ') : t('cashier.noMove')}</Td>
          </tr>
        ))}
      </DataTable>
    </Card>
  );
}
