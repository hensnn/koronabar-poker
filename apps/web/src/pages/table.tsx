import { useEffect, useState, type CSSProperties } from 'react';
import { TablePolls } from './polls';
import { PollEditor } from './poll-editor';
import { navigate } from '../router';
import { can, useSession } from '../session';
import { ShareToChat } from './chat-extras';
import { t } from '@kb/shared';
import { errorText, get, post } from '../api';
import { loadChannels, useChatStore } from '../chat-store';
import { onSocket, useNet } from '../net';
import { Link } from '../router';
import { saveUserSetting, useSettings } from '../settings';
import { useMobileAttribute, useMobileLayout } from '../table/mobile';
import { TableScreen } from '../table/TableScreen';
import { setTableFormat } from '../table/format';
import { TablePanel } from '../table/TablePanel';
import { Resizable } from '../table/resizable';
import { HandHistory } from '../table/HandHistory';
import { SoundPalette } from './sounds';
import { SoundMenu } from '../sound-menu';
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
  const [more, setMore] = useState(false);
  const mobile = useMobileLayout();
  useMobileAttribute(mobile);
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
  const num = (key: string) => Number(settings.values[key] ?? 0);
  const [size, setSize] = useState({ pw: num('ui.tablePanelWidth'), ph: num('ui.tablePanelHeight'), cw: num('ui.tableChatWidth'), ch: num('ui.tableChatHeight') });
  const [dragging, setDragging] = useState(false);
  const stored = [num('ui.tablePanelWidth'), num('ui.tablePanelHeight'), num('ui.tableChatWidth'), num('ui.tableChatHeight')].join();
  useEffect(() => {
    if (!dragging) setSize({ pw: num('ui.tablePanelWidth'), ph: num('ui.tablePanelHeight'), cw: num('ui.tableChatWidth'), ch: num('ui.tableChatHeight') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, dragging]);
  const chatMinimized = settings.values['ui.tableChatMinimized'] === true;
  const keep = (key: string, value: number | boolean) => void saveUserSetting(key, value).catch(() => undefined);
  const chatRight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-tk-layout-chat') === 'right';
  const pageStyle: CSSProperties = { ['--tk-panel-w' as string]: size.pw + 'px', ...(size.cw > 0 ? { ['--tk-chat-w' as string]: size.cw + 'px' } : {}) };
  const panelBodyStyle: CSSProperties | undefined = size.ph > 0 ? { maxHeight: size.ph, overflow: 'auto' } : undefined;
  const chatBoxStyle: CSSProperties | undefined = size.cw > 0 ? { width: size.cw, maxWidth: '100%' } : undefined;
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
  const [toolError, setToolError] = useState('');
  // Pauza: u turnaje přes turnaj (zakladatel/správce nebo „zasah.pauza“), u cash stolu přes stůl; server oprávnění ověří.
  const canPause = can(me, 'zasah.pauza') || (isTournament ? can(me, 'turnaj.upravit_vlastni') || can(me, 'turnaj.upravit_vse') : can(me, 'cash.upravit_vlastni') || can(me, 'cash.upravit_vse'));
  const togglePause = async () => {
    try {
      setToolError('');
      if (isTournament) await post(`/api/tournaments/${tournamentId}/${view?.paused ? 'resume' : 'pause'}`);
      else await post(`/api/lobby/tables/${tableId}/pause`, { resume: !!view?.paused });
    } catch (e) {
      setToolError(errorText(e));
    }
  };
  // Nástroje stolu: na širokém displeji v liště, na telefonu pod tlačítkem „⋯“.
  const tools = (
    <>
      {!isTournament && <ShareToChat kind="stul" id={tableId} />}
      {!isTournament && <Button onClick={() => setShowSettlement(true)}>{t('table.settlement')}</Button>}
      {can(me, 'anketa.vytvorit') && <Button onClick={() => setPollOpen(true)}>{t('polls.tableCreate')}</Button>}
      {canPause && view && (
        <Button onClick={() => void togglePause()} aria-pressed={!!view.paused}>
          {view.paused ? `▶ ${t('table.resume')}` : `⏸ ${t('table.pause')}`}
        </Button>
      )}
      <Button onClick={() => void saveUserSetting('ui.mobileLayout', mobile ? 'off' : 'on', true).catch(() => undefined)} title={t('table.mobileDeviceHint')}>
        {mobile ? t('table.mobileOff') : t('table.mobileOn')}
      </Button>
      <Button onClick={() => setHistory(true)} title={t('table.history')}>
        📜 {t('table.history')}
      </Button>
      <Button onClick={() => setFocus((v) => !v)} aria-pressed={focus} title={focus ? t('table.fullscreenExit') : t('table.fullscreen')}>
        {focus ? '⤡' : '⛶'} {focus ? t('table.fullscreenExit') : t('table.fullscreen')}
      </Button>
    </>
  );
  return (
    <div className="tk-tablepage" style={pageStyle} data-chat-min={chatMinimized ? '1' : undefined}>
      <Resizable
        as="aside"
        className="tk-tp-panel"
        w={size.pw}
        h={size.ph}
        limits={{ minW: 160, maxW: 640, minH: 120, maxH: 3000 }}
        onChange={(pw, ph, commit) => {
          setDragging(!commit);
          setSize((x) => ({ ...x, pw, ph }));
          if (commit) {
            if (pw !== num('ui.tablePanelWidth')) keep('ui.tablePanelWidth', pw);
            if (ph !== num('ui.tablePanelHeight')) keep('ui.tablePanelHeight', ph);
          }
        }}
        onReset={() => {
          setSize((x) => ({ ...x, pw: 272, ph: 0 }));
          keep('ui.tablePanelWidth', 272);
          keep('ui.tablePanelHeight', 0);
        }}
      >
        <div className="flex flex-col gap-2" style={panelBodyStyle} aria-label={t('table.panel')}>
          <TablePanel view={view} tableId={tableId} inBb={inBb} />
        </div>
      </Resizable>
      <div className="tk-tp-main flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={isTournament ? `/turnaj/${tournamentId}` : '/cash'} className="underline">
            {isTournament ? t('tournament.backToTournament') : t('table.backToLobby')}
          </Link>
          <span className="tk-tp-mobile relative ml-auto flex gap-2">
            <Button onClick={() => setDrawer('panel')}>{t('table.panelOpen')}</Button>
            <Button onClick={() => setDrawer('chat')}>
              {t('table.chatOpen')}
              {channel && channel.unread > 0 && <span className="ml-1 rounded-full bg-accent px-1.5 text-xs text-on-act">{channel.unread}</span>}
            </Button>
            <SoundMenu />
            <Button aria-haspopup="menu" aria-expanded={more} aria-label={t('table.more')} onClick={() => setMore((v) => !v)}>
              ⋯
            </Button>
            {more && (
              <div role="menu" className="absolute right-0 top-full z-20 mt-1 flex w-max flex-col gap-1 rounded-md border border-line bg-surface p-2 shadow-lg" onClick={() => setMore(false)}>
                {tools}
              </div>
            )}
          </span>
          <span className="tk-tp-desktop flex flex-wrap items-center gap-2">
            {tools}
            <SoundMenu />
          </span>
        </div>
        {toolError && <Notice kind="error">{toolError}</Notice>}
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
        {channel &&
          (chatMinimized ? (
            <MiniChat channel={channel} onRestore={() => keep('ui.tableChatMinimized', false)} />
          ) : (
            <Resizable
              className="relative"
              style={chatBoxStyle}
              side={chatRight ? 'left' : 'right'}
              w={size.cw}
              h={size.ch}
              limits={{ minW: 220, maxW: 1600, minH: 64, maxH: 1200 }}
              onChange={(cw, ch, commit) => {
                setDragging(!commit);
                setSize((x) => ({ ...x, cw, ch }));
                if (commit) {
                  if (cw !== num('ui.tableChatWidth')) keep('ui.tableChatWidth', cw);
                  if (ch !== num('ui.tableChatHeight')) keep('ui.tableChatHeight', ch);
                }
              }}
              onReset={() => {
                setSize((x) => ({ ...x, cw: 0, ch: 128 }));
                keep('ui.tableChatWidth', 0);
                keep('ui.tableChatHeight', 128);
              }}
            >
              <Card
                title={t('table.chat')}
                actions={
                  <span className="flex gap-1">
                    <Button onClick={() => keep('ui.tableChatMinimized', true)} title={t('table.chatMinimize')} aria-label={t('table.chatMinimize')}>
                      ▁
                    </Button>
                    <Button onClick={() => setDrawer('chat')} title={t('table.chatFull')} aria-label={t('table.chatFull')}>
                      ⛶
                    </Button>
                  </span>
                }
              >
                <ChatPanel channel={channel} compact listHeight={size.ch} />
              </Card>
            </Resizable>
          ))}
      </div>
      {drawer && (
        <div className="tk-drawer" role="dialog" aria-label={drawer === 'chat' ? t('table.chat') : t('table.panel')}>
          <div className="tk-drawer-head">
            <strong>{drawer === 'chat' ? t('table.chat') : t('table.panel')}</strong>
            <Button onClick={() => setDrawer(null)}>{t('table.close')}</Button>
          </div>
          <div className="tk-drawer-body flex flex-col gap-2">{drawer === 'chat' ? channel && <ChatPanel channel={channel} compact fill /> : <TablePanel view={view} tableId={tableId} inBb={inBb} />}</div>
        </div>
      )}
      {showSettlement && <SettlementDialog tableId={tableId} onClose={() => setShowSettlement(false)} />}
      {history && <HandHistory tableId={tableId} onClose={() => setHistory(false)} />}
    </div>
  );
}

/** Miniatura chatu: úzký pruh s počtem nepřečtených zpráv a poslední zprávou. */
function MiniChat({ channel, onRestore }: { channel: { id: string; unread: number }; onRestore: () => void }) {
  const store = useChatStore();
  const last = [...(store.messages[channel.id] ?? [])].reverse().find((m) => !m.system && !m.deleted);
  return (
    <button type="button" onClick={onRestore} title={t('table.chatRestore')} aria-label={t('table.chatRestore')} className="flex w-full items-center gap-2 rounded-md border border-line bg-surface px-3 py-1 text-left text-sm">
      <span aria-hidden="true">💬</span>
      <strong>{t('table.chatMini')}</strong>
      {channel.unread > 0 && <span className="rounded-full bg-accent px-1.5 text-xs text-on-act">{channel.unread}</span>}
      {last && (
        <span className="min-w-0 flex-1 truncate text-muted">
          {last.nickname}: {last.body}
        </span>
      )}
      <span aria-hidden="true">▴</span>
    </button>
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
