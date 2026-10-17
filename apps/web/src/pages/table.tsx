import { useEffect, useState } from 'react';
import { TablePolls } from './polls';
import { PollEditor } from './poll-editor';
import { navigate } from '../router';
import { can, useSession } from '../session';
import { ShareToChat } from './chat-extras';
import { t } from '@kb/shared';
import { errorText, get } from '../api';
import { loadChannels, useChatStore } from '../chat-store';
import { onSocket, useNet } from '../net';
import { Link } from '../router';
import { useSettings } from '../settings';
import { TableScreen } from '../table/TableScreen';
import { Button, Card, DataTable, Modal, Notice, Td } from '../ui';
import { ChatPanel } from './chat';
import { DealPanel } from './deal';

/** Turnaj na více stolech: když hráče přesadí k jinému stolu, stránka ho tam sama přesměruje. */
function useFollowMyTable(tournamentId: string, tableId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const check = () =>
      get<{ me: { tableId: string | null; status: string | null } }>(`/api/tournaments/${tournamentId}`)
        .then((v) => {
          if (v.me.status === 'playing' && v.me.tableId && v.me.tableId !== tableId) navigate(`/stul/${v.me.tableId}`);
        })
        .catch(() => undefined);
    return onSocket<{ id: string }>('tournament:changed', (m) => {
      if (m.id === tournamentId) void check();
    });
  }, [tournamentId, tableId, enabled]);
}

export function TablePage({ tableId }: { tableId: string }) {
  const settings = useSettings();
  const store = useChatStore();
  const [showSettlement, setShowSettlement] = useState(false);
  useEffect(() => {
    void loadChannels().catch(() => undefined);
  }, [tableId]);
  const tableInfo = useNet().views[tableId]?.info;
  const isTournament = tableInfo?.tournament === true;
  // U turnaje na více stolech patří chat, dohoda a hlasování celému turnaji.
  const tournamentId = tableInfo?.tournamentId ?? tableId;
  const channel = store.channels.find((c) => c.key === `table:${tournamentId}`);
  useFollowMyTable(tournamentId, tableId, isTournament);
  const { me } = useSession();
  const [pollOpen, setPollOpen] = useState(false);
  return (
    <div className="tk-tablepage">
      <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={isTournament ? `/turnaj/${tournamentId}` : '/'} className="underline">
          {isTournament ? t('tournament.backToTournament') : t('table.backToLobby')}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {!isTournament && <ShareToChat kind="stul" id={tableId} />}
          {!isTournament && <Button onClick={() => setShowSettlement(true)}>{t('table.settlement')}</Button>}
          {can(me, 'anketa.vytvorit') && <Button onClick={() => setPollOpen(true)}>{t('polls.tableCreate')}</Button>}
        </div>
      </div>
      <TablePolls tableId={tableId} alsoIds={tournamentId !== tableId ? [tournamentId] : []} />
      {pollOpen && (
        <PollEditor
          table={{ id: tableId }}
          onClose={() => setPollOpen(false)}
          onCreated={(id) => {
            setPollOpen(false);
            navigate(`/ankety/${id}`);
          }}
        />
      )}
      {isTournament && <DealPanel id={tournamentId} onlyOpen />}
      <TableScreen tableId={tableId} inBb={Boolean(settings.values['ui.showInBb'])} quickPost={String(settings.values['ui.quickBetsPostflop'])} quickPre={String(settings.values['ui.quickBetsPreflop'])} />
      </div>
      {channel && (
        <Card title={t('table.chat')}>
          <ChatPanel channel={channel} compact />
        </Card>
      )}
      {showSettlement && <SettlementDialog tableId={tableId} onClose={() => setShowSettlement(false)} />}
    </div>
  );
}

interface Settlement {
  balances: Record<string, number>;
  transfers: { from: string; to: string; amount: number }[];
  names: Record<string, string>;
  note: string;
}

function SettlementDialog({ tableId, onClose }: { tableId: string; onClose: () => void }) {
  const [data, setData] = useState<Settlement | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    get<Settlement>(`/api/tables/${tableId}/settlement`).then(setData).catch((e) => setError(errorText(e)));
  }, [tableId]);
  return (
    <Modal title={t('table.settlement')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <Notice kind="error">{error}</Notice>}
        {data && (
          <>
            <DataTable head={[t('settlement.player'), t('settlement.result')]}>
              {Object.entries(data.balances).map(([id, v]) => (
                <tr key={id}>
                  <Td>{data.names[id] ?? id}</Td>
                  <Td className={`font-mono ${v >= 0 ? 'text-success' : 'text-danger'}`}>{v > 0 ? `+${v}` : v}</Td>
                </tr>
              ))}
            </DataTable>
            <h3 className="font-medium">{t('settlement.transfers')}</h3>
            {data.transfers.length === 0 ? (
              <p className="text-muted">{t('settlement.none')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {data.transfers.map((x, i) => (
                  <li key={i}>
                    {t('settlement.transfer', { from: data.names[x.from] ?? x.from, to: data.names[x.to] ?? x.to, amount: x.amount })}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-sm text-muted">{data.note}</p>
          </>
        )}
        <Button onClick={onClose}>{t('table.close')}</Button>
      </div>
    </Modal>
  );
}
