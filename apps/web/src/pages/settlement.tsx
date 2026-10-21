import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get } from '../api';
import { Button, Card, DataTable, Notice, Spinner, Td } from '../ui';

type Parts = Partial<Record<string, number>>;
/** Pořadí složek ve sloupcích, shodné s tabulkou výsledků turnaje (Buy-in, Rebuy, Add-on, Výhra, Bounty). */
const PART_ORDER = ['cashBuyIn', 'cashOut', 'buyIn', 'rebuy', 'addon', 'payout', 'bounty', 'refund', 'other'] as const;

interface Settlement {
  from: number;
  to: number;
  players: { userId: string; cash: number; tournament: number; total: number; parts: Parts }[];
  games: { id: string; name: string; kind: 'cash' | 'tournament'; results: Record<string, number>; parts: Record<string, Parts> }[];
  transfers: { from: string; to: string; amount: number }[];
  names: Record<string, string>;
  house: number | null;
  note: string;
}

const HOUR = 3600_000;
const startOfToday = (): number => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** Hodnota pro <input type="datetime-local"> v místním čase. */
const toLocalInput = (ms: number): string => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};
const signed = (v: number): string => (v > 0 ? `+${v}` : String(v));
const tone = (v: number): string => (v > 0 ? 'text-success' : v < 0 ? 'text-danger' : '');

/** Tabulka rozpadu: řádek na hráče, sloupce podle složek (prázdné se skrývají) a Výsledek jako jejich součet. */
function PartsTable({ rows, names, withSum }: { rows: { userId: string; parts: Parts; total: number }[]; names: Record<string, string>; withSum: boolean }) {
  const used = PART_ORDER.filter((k) => rows.some((r) => (r.parts[k] ?? 0) !== 0));
  const sumOf = (k: string) => rows.reduce((n, r) => n + (r.parts[k] ?? 0), 0);
  return (
    <DataTable head={[t('settlement.player'), ...used.map((k) => t(`settlement.part.${k}`)), t('settlement.result')]}>
      {rows.map((r) => (
        <tr key={r.userId}>
          <Td>{names[r.userId] ?? r.userId}</Td>
          {used.map((k) => (
            <Td key={k} className={`font-mono ${tone(r.parts[k] ?? 0)}`}>
              {signed(r.parts[k] ?? 0)}
            </Td>
          ))}
          <Td className={`font-mono font-medium ${tone(r.total)}`}>{signed(r.total)}</Td>
        </tr>
      ))}
      {withSum && (
        <tr className="font-medium">
          <Td>{t('settlement.sum')}</Td>
          {used.map((k) => (
            <Td key={k} className="font-mono">
              {signed(sumOf(k))}
            </Td>
          ))}
          <Td className="font-mono">{signed(rows.reduce((n, r) => n + r.total, 0))}</Td>
        </tr>
      )}
    </DataTable>
  );
}

/** Vyúčtování večera nebo období: cash a turnaje zvlášť i dohromady, rozpad po hrách a minimální převody. */
export function SettlementPanel() {
  const [from, setFrom] = useState(startOfToday());
  const [to, setTo] = useState(Date.now());
  const [data, setData] = useState<Settlement | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setData(null);
    get<Settlement>(`/api/settlement?from=${from}&to=${to}`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, [from, to]);
  useEffect(load, [load]);

  const preset = (start: number) => {
    setFrom(start);
    setTo(Date.now());
  };
  return (
    <Card title={t('settlement.periodTitle')}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-sm">
            {t('settlement.from')}
            <input type="datetime-local" className="rounded-sm border border-line bg-surface px-2 py-1" value={toLocalInput(from)} onChange={(e) => e.target.value && setFrom(new Date(e.target.value).getTime())} />
          </label>
          <label className="flex flex-col text-sm">
            {t('settlement.to')}
            <input type="datetime-local" className="rounded-sm border border-line bg-surface px-2 py-1" value={toLocalInput(to)} onChange={(e) => e.target.value && setTo(new Date(e.target.value).getTime())} />
          </label>
          <Button onClick={() => preset(startOfToday())}>{t('settlement.today')}</Button>
          <Button onClick={() => preset(Date.now() - 24 * HOUR)}>{t('settlement.last24')}</Button>
          <Button onClick={() => preset(Date.now() - 7 * 24 * HOUR)}>{t('settlement.last7')}</Button>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        {!data && !error && <Spinner label={t('app.loading')} />}
        {data && (
          <>
            {data.players.length === 0 ? (
              <p className="text-muted">{t('settlement.emptyPeriod')}</p>
            ) : (
              <>
                <PartsTable rows={data.players} names={data.names} withSum />
                <p className="text-sm text-muted">{t('settlement.partsHelp')}</p>
              </>
            )}
            {data.house !== null && data.players.length > 0 && (
              <p className="text-sm text-muted">{t('settlement.house', { amount: data.house })}</p>
            )}
            {data.games.length > 0 && (
              <details open>
                <summary className="cursor-pointer">{t('settlement.byGame', { n: data.games.length })}</summary>
                <div className="mt-2 flex flex-col gap-4">
                  {data.games.map((g) => (
                    <section key={g.id} className="flex flex-col gap-1">
                      <h4>
                        <strong>{g.name}</strong> <span className="text-sm text-muted">({g.kind === 'tournament' ? t('settlement.kindTournament') : t('settlement.kindCash')})</span>
                      </h4>
                      <PartsTable rows={Object.entries(g.results).map(([id, v]) => ({ userId: id, parts: g.parts[id] ?? {}, total: v }))} names={data.names} withSum={Object.keys(g.results).length > 1} />
                    </section>
                  ))}
                </div>
              </details>
            )}
            <h3 className="font-medium">{t('settlement.transfers')}</h3>
            {data.transfers.length === 0 ? (
              <p className="text-muted">{t('settlement.none')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {data.transfers.map((x, i) => (
                  <li key={i}>{t('settlement.transfer', { from: data.names[x.from] ?? x.from, to: data.names[x.to] ?? x.to, amount: x.amount })}</li>
                ))}
              </ul>
            )}
            <p className="text-sm text-muted">{data.note}</p>
          </>
        )}
      </div>
    </Card>
  );
}
