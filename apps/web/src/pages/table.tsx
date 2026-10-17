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
import { setTableFormat } from '../table/format';
import { TablePanel } from '../table/TablePanel';
import { HandHistory } from '../table/HandHistory';
import { SoundPalette } from './sounds';
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

/**
 * Stránka stolu: na širokém displeji levý panel s widgety, stůl uprostřed a chat dole (nebo vpravo podle motivu);
 * na telefonu stůl na celou šířku a panel i chat pod tlačítky.
 */
export function TablePage({ tableId }: { tableId: string }) {
  const settings = useSettings();
  const store = useChatStore();
  const net = useNet();
  const [showSettlement, setShowSettlement] = useState(false);
  const [drawer, setDrawer] = useState<'chat' | 'panel' | null>(null);
  const [focus, setFocus] = useState(false);
  const [history, setHistory] = useState(false);
  setTableFormat({ symbol: settings.values['ui.showSymbolAtTable'] === true });
  // Celá obrazovka: schová nabídku a patičku, volitelně i prohlížeč přepne do fullscreen.
  useEffect(() => {
    const root = document.documentElement;
    if (focus) {
      root.setAttribute('data-focus', '1');
      void root.requestFullscreen?.().catch(() => undefined);
    } else {
      root.removeAttribute('data-focus');
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    }
    const onChange = () => {
      if (!document.fullscreenElement) setFocus(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      root.removeAttribute('data-focus');
    };
  }, [focus]);
  useEffect(() => {
    void loadChannels().catch(() => undefined);
  }, [tableId]);
  const view = net.views[tableId];
  const tableInfo = view?.info;
  const isTournament = tableInfo?.tournament === true;
  // U turnaje na více stolech patří chat, dohoda a hlasování celému turnaji.
  const tournamentId = tableInfo?.tournamentId ?? tableId;
  const channel = store.channels.find((c) => c.key === `table:${tournamentId}`);
  useFollowMyTable(tournamentId, tableId, isTournament);
  const { me } = useSession();
  const [pollOpen, setPollOpen] = useState(false);
  const inBb = Boolean(settings.values['ui.showInBb']);
  const seated = !!view?.seats.some((s) => s.playerId === me?.user.id);
  return (
    <div className="tk-tablepage">
      <aside className="tk-tp-panel" aria-label={t('table.panel')}>
        <TablePanel view={view} tableId={tableId} inBb={inBb} />
      </aside>
      <div className="tk-tp-main flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={isTournament ? `/turnaj/${tournamentId}` : '/'} className="underline">
            {isTournament ? t('tournament.backToTournament') : t('table.backToLobby')}
          </Link>
          <span className="tk-tp-mobile ml-auto flex gap-2">
            <Button onClick={() => setDrawer('panel')}>{t('table.panelOpen')}</Button>
            <Button onClick={() => setDrawer('chat')}>
              {t('table.chatOpen')}
              {channel && channel.unread > 0 && <span className="ml-1 rounded-full bg-accent px-1.5 text-xs text-on-act">{channel.unread}</span>}
            </Button>
          </span>
          <span className="flex flex-wrap items-center gap-2 max-lg:w-full">
            {!isTournament && <ShareToChat kind="stul" id={tableId} />}
            {!isTournament && <Button onClick={() => setShowSettlement(true)}>{t('table.settlement')}</Button>}
            {can(me, 'anketa.vytvorit') && <Button onClick={() => setPollOpen(true)}>{t('polls.tableCreate')}</Button>}
            <Button onClick={() => setHistory(true)} title={t('table.history')}>
              📜 {t('table.history')}
            </Button>
            <Button onClick={() => setFocus((v) => !v)} aria-pressed={focus} title={focus ? t('table.fullscreenExit') : t('table.fullscreen')}>
              {focus ? '⤡' : '⛶'} {focus ? t('table.fullscreenExit') : t('table.fullscreen')}
            </Button>
          </span>
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
        <TableScreen
          tableId={tableId}
          inBb={inBb}
          quickPost={String(settings.values['ui.quickBetsPostflop'])}
          quickPre={String(settings.values['ui.quickBetsPreflop'])}
          extra={
            seated ? (
              <span className="tk-tp-mobile">
                <SoundPalette target={{ kind: 'table', id: tableId }} />
              </span>
            ) : undefined
          }
        />
      </div>
      <div className="tk-tp-chat">
        {channel && (
          <Card title={t('table.chat')}>
            <ChatPanel channel={channel} compact />
          </Card>
        )}
      </div>
      {drawer && (
        <div className="tk-drawer lg:hidden" role="dialog" aria-label={drawer === 'chat' ? t('table.chat') : t('table.panel')}>
          <div className="tk-drawer-head">
            <strong>{drawer === 'chat' ? t('table.chat') : t('table.panel')}</strong>
            <Button onClick={() => setDrawer(null)}>{t('table.close')}</Button>
          </div>
          <div className="tk-drawer-body flex flex-col gap-2">{drawer === 'chat' ? channel && <ChatPanel channel={channel} compact /> : <TablePanel view={view} tableId={tableId} inBb={inBb} />}</div>
        </div>
      )}
      {showSettlement && <SettlementDialog tableId={tableId} onClose={() => setShowSettlement(false)} />}
      {history && <HandHistory tableId={tableId} onClose={() => setHistory(false)} />}
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
