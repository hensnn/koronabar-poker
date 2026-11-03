import { useEffect, useRef, useState, type CSSProperties, type ReactNode, Fragment } from 'react';
import { TablePolls } from './polls';
import { PollEditor } from './poll-editor';
import { navigate } from '../router';
import { can, useSession } from '../session';
import { ShareToChat } from './chat-extras';
import { t } from '@kb/shared';
import { errorText, get, post } from '../api';
import { loadChannels, useChatStore } from '../chat-store';
import { onSocket, table as tableApi, useNetSelector } from '../net';
import { Link } from '../router';
import { defaultOf, saveUserSetting, useSettings } from '../settings';
import { mobileScale, useFollowPhoneProfile, useLandscapePhone, useMobileAttribute, useMobileLayout, useMobileOrder } from '../table/mobile';
import { TableScreen } from '../table/TableScreen';
import { setTableFormat } from '../table/format';
import { Panel, PanelSettingsButton } from '../table/Panel';
import { MobilePager, MobileScreen, MobileWidgetDrawer } from '../table/MobilePager';
import { MobileOrderEditor, WIDGET_TITLE_KEY } from '../table/MobileOrderEditor';
import { TOOL_ICON, TOOL_IDS, mainIndex, screenLayout, toolScreens, WIDGET_ICON, zoneOf, type MobileWidget, type ToolId } from '../table/mobile-order';
import { TournamentBanner } from '../table/TablePanel';
import { TableSizeButton, useTableSize } from '../table/size';
import { MobileBar, MobileScalePanel } from '../table/mobile-ui';
import { TableWidgetsProvider, useHiddenSides } from '../table/widgets';
import { Resizable } from '../table/resizable';
import { HandHistory } from '../table/HandHistory';
import { SoundPalette } from './sounds';
import { SoundMenu } from '../sound-menu';
import { AssistantToolButton } from './assistant';
import { Button, DataTable, ErrorToast, Modal, Notice, Td } from '../ui';
import { ChatPanel } from './chat';
import { DealPanel } from './deal';
import { useFeatures } from '../features';
import { BustSummaryButton, useTournamentResultFallback } from './tournament-result';
import { useKeepInView } from '../keep-in-view';

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
  const features = useFeatures();
  const [showSettlement, setShowSettlement] = useState(false);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const [history, setHistory] = useState(false);
  const hiddenSides = useHiddenSides();
  const [more, setMore] = useState(false);
  const moreRef = useKeepInView<HTMLDivElement>(more);
  const mobile = useMobileLayout();
  // Obrazovky na telefonu: 0 = stůl s ovládacím panelem, další se listují prstem; rozmístění widgetů si volí hráč.
  const order = useMobileOrder();
  const landscapePhone = useLandscapePhone();
  const landscape = mobile && landscapePhone;
  const layoutZones = screenLayout(order);
  const tableIdx = mainIndex(order);
  const [page, setPage] = useState(tableIdx);
  // Změna hlavní obrazovky v nastavení přepne rovnou na ni.
  useEffect(() => setPage(tableIdx), [tableIdx]);
  const [layoutEditor, setLayoutEditor] = useState(false);
  const goTo = (id: MobileWidget) => {
    const z = zoneOf(order, id);
    if (z === 's2' || z === 's3') setPage(Math.max(0, layoutZones.indexOf(z)));
    else if (z === 'icon') setDrawer(`w:${id}`);
  };
  const modern = mobile;
  useFollowPhoneProfile(mobile);
  const seatCountForScale = useNetSelector((n) => n.views[tableId]?.info.seatCount) ?? 9;
  useMobileAttribute(mobile, modern, mobileScale(settings.values, seatCountForScale, landscape));
  setTableFormat({ symbol: settings.values['ui.showSymbolAtTable'] === true, chipLabel: settings.values['ui.showChipLabelAtTable'] !== false });
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
  // Volba „u stolu automaticky celá obrazovka“ (jen mobilní rozložení): po vstupu ke stolu se zapne režim celé obrazovky.
  const autoFocus = mobile && settings.values['ui.mobileAutoFullscreen'] === true;
  useEffect(() => {
    if (autoFocus) setFocus(true);
  }, [autoFocus, tableId]);
  useEffect(() => {
    void loadChannels().catch(() => undefined);
  }, [tableId]);
  const num = (key: string) => Number(settings.values[key] ?? 0);
  const [size, setSize] = useState({ pw: num('ui.tablePanelWidth'), ph: num('ui.tablePanelHeight'), ch: num('ui.tableChatHeight') });
  const [dragging, setDragging] = useState(false);
  const panelHeights = useRef(new Set<number>());
  const stored = [num('ui.tablePanelWidth'), num('ui.tablePanelHeight'), num('ui.tableChatHeight')].join();
  useEffect(() => {
    if (!dragging) setSize({ pw: num('ui.tablePanelWidth'), ph: num('ui.tablePanelHeight'), ch: num('ui.tableChatHeight') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, dragging]);
  const keep = (key: string, value: number | boolean) => void saveUserSetting(key, value).catch(() => undefined);
  const area = useTableSize();
  const areaAlign = String(useSettings().values['ui.tableAreaAlign'] ?? 'center');
  const pageStyle: CSSProperties = { ['--tk-panel-w' as string]: size.pw + 'px', ['--area-w' as string]: String(area.a) };
  // Výška panelu je výchozí podle herní oblasti; ruční výška (tažení za spodní okraj) ji přepíše.
  const panelStyle: CSSProperties | undefined = size.ph > 0 ? { height: size.ph, alignSelf: 'start' } : undefined;
  // Jen pohled na tento stůl: změna přítomnosti nebo jiného stolu stránku nepřekresluje.
  const view = useNetSelector((n) => n.views[tableId]);
  const tableInfo = view?.info;
  const isTournament = tableInfo?.tournament === true;
  // U turnaje na více stolech patří chat, dohoda a hlasování celému turnaji.
  const tournamentId = tableInfo?.tournamentId ?? tableId;
  const channel = features.chat ? store.channels.find((c) => c.key === `table:${tournamentId}`) : undefined;
  useFollowMyTable(tournamentId, tableId, isTournament);
  useTournamentResultFallback(isTournament ? tournamentId : '');
  const { me } = useSession();
  const mySeat = view?.seats.find((x) => x.playerId === me?.user.id);
  const myTurn = !!mySeat && view?.actingSeat === mySeat.seat;
  // Když jsem na tahu, vrátí se obrazovka na stůl (ovládací panel je jen tam).
  useEffect(() => {
    if (myTurn) setPage(tableIdx);
  }, [myTurn, tableIdx]);
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
  // Sit out: můj stav je tlačítko s návratem do hry, ostatní jen krátká informace (místo značek přes celý řádek u sedadel).
  const sitters = (view?.seats ?? []).filter((x) => x.status === 'sittingOut' || x.sitOut === true);
  const meSitting = sitters.some((x) => x.playerId === me?.user.id);
  const othersSitting = sitters.filter((x) => x.playerId !== me?.user.id).map((x) => x.name);
  const chatWidget = channel
    ? {
          unread: channel.unread,
          actions: (
            <button className="px-1" onClick={() => setDrawer('chat')} title={t('table.chatFull')} aria-label={t('table.chatFull')}>
              ⛶
            </button>
          ),
          body: (
            <Resizable
              className="relative pb-2"
              w={0}
              h={size.ch}
              resizeW={false}
              limits={{ minW: 0, maxW: 0, minH: 64, maxH: 1200 }}
              onChange={(_w, ch, commit) => {
                setDragging(!commit);
                setSize((x) => ({ ...x, ch }));
                if (commit && ch !== num('ui.tableChatHeight')) keep('ui.tableChatHeight', ch);
              }}
              onReset={() => {
                setSize((x) => ({ ...x, ch: defaultOf('ui.tableChatHeight') }));
                keep('ui.tableChatHeight', defaultOf('ui.tableChatHeight'));
              }}
            >
              <ChatPanel channel={channel} compact listHeight={size.ch} />
            </Resizable>
          ),
        }
      : undefined;
  // Nástroje stolu: na širokém displeji v liště jen jako ikony s popisem při najetí, na telefonu pod tlačítkem „⋯“ s textem.
  const renderTools = (iconOnly: boolean) => {
    /** Jedno tlačítko lišty: ikona (a popisek v nabídce na telefonu), popis vždy i jako tooltip a pro čtečky. */
    const tool = (icon: string, label: string, onClick: () => void, extra: { pressed?: boolean } = {}) => (
      <Button className={iconOnly ? 'px-2' : ''} onClick={onClick} title={label} aria-label={label} aria-pressed={extra.pressed}>
        {icon}
        {iconOnly ? '' : ` ${label}`}
      </Button>
    );
    return (
      <>
        {!isTournament && features.chat && <ShareToChat kind="stul" id={tableId} iconOnly={iconOnly} />}
        {!isTournament && tool('🧾', t('table.settlement'), () => setShowSettlement(true))}
        {features.polls && can(me, 'anketa.vytvorit') && tool('🗳️', t('polls.tableCreate'), () => setPollOpen(true))}
        {meSitting && (
          <Button onClick={() => void tableApi.sitIn(tableId).catch(() => undefined)} title={t('table.sitIn')} aria-label={t('table.sitIn')}>
            ▶ {t('table.sitIn')}
          </Button>
        )}
        {othersSitting.length > 0 && (
          <span className="rounded-md border border-warning px-2 py-1 text-sm" title={t('table.sitOutOthers', { names: othersSitting.join(', ') })}>
            💤 {othersSitting.length}
          </span>
        )}
        {!modern && canPause && view && tool(view.paused ? '▶' : '⏸', view.paused ? t('table.resume') : t('table.pause'), () => void togglePause(), { pressed: !!view.paused })}
        {tool(mobile ? '🖥️' : '📱', mobile ? t('table.mobileOff') : t('table.mobileOn'), () => void saveUserSetting('ui.mobileLayout', mobile ? 'off' : 'on', true).catch(() => undefined))}
        {!mobile && <TableSizeButton iconOnly={iconOnly} />}
        {!modern && <PanelSettingsButton iconOnly={iconOnly} />}
        {!modern && tool('📜', t('table.history'), () => setHistory(true))}
        {tool(focus ? '⤡' : '⛶', focus ? t('table.fullscreenExit') : t('table.fullscreen'), () => setFocus((v) => !v), { pressed: focus })}
      </>
    );
  };
  const drawerTitle = drawer === 'chat' ? t('table.chat') : drawer === 'scale' ? t('table.scale.title') : drawer?.startsWith('w:') ? t(WIDGET_TITLE_KEY[drawer.slice(2) as MobileWidget]) : drawer === 'menu' ? t('table.m.menu') : t('table.panel');
  // Ikony horní lišty na telefonu: každý nástroj má obrazovky, na kterých je vidět (Nastavení → Telefon → Ikony); všechny jsou vždy v nabídce ☰.
  const mbtn = 'tk-mbar-btn relative rounded-md border border-line bg-surface';
  const iconBtn = (key: string, icon: string, label: string, onClick: () => void, extra: { pressed?: boolean; badge?: number } = {}) => (
    <button key={key} className={mbtn} onClick={onClick} aria-label={label} title={label} aria-pressed={extra.pressed}>
      {icon}
      {extra.badge ? <span className="absolute -right-1 -top-1 rounded-full bg-accent px-1 text-xs text-on-act">{extra.badge}</span> : null}
    </button>
  );
  const toolNodes: Record<ToolId, ReactNode> = {
    history: iconBtn('history', TOOL_ICON.history, t('table.history'), () => setHistory(true)),
    pause: canPause && view ? iconBtn('pause', view.paused ? '▶' : '⏸', view.paused ? t('table.resume') : t('table.pause'), () => void togglePause(), { pressed: !!view.paused }) : null,
    chat: channel && zoneOf(order, 'chat') !== 'hidden' ? iconBtn('chat', TOOL_ICON.chat, t('table.chatOpen'), () => goTo('chat'), { badge: channel.unread }) : null,
    info: iconBtn('info', TOOL_ICON.info, t('table.m.info'), () => goTo('info')),
    share: !isTournament && features.chat ? <ShareToChat key="share" kind="stul" id={tableId} iconOnly /> : null,
    settlement: !isTournament ? iconBtn('settlement', TOOL_ICON.settlement, t('table.settlement'), () => setShowSettlement(true)) : null,
    poll: features.polls && can(me, 'anketa.vytvorit') ? iconBtn('poll', TOOL_ICON.poll, t('polls.tableCreate'), () => setPollOpen(true)) : null,
    layout: iconBtn('layout', TOOL_ICON.layout, t('table.mobileOff'), () => void saveUserSetting('ui.mobileLayout', 'off', true).catch(() => undefined)),
    scale: iconBtn('scale', TOOL_ICON.scale, t('table.scale.title'), () => setDrawer('scale')),
    fullscreen: iconBtn('fullscreen', focus ? '⤡' : TOOL_ICON.fullscreen, focus ? t('table.fullscreenExit') : t('table.fullscreen'), () => setFocus((v) => !v), { pressed: focus }),
    sound: <SoundMenu key="sound" />,
    assistant: features.assistant ? <AssistantToolButton key="assistant" iconOnly /> : null,
  };
  const widgetIcons = order.icon.filter((id) => id !== 'info' && id !== 'chat');
  const barItems: ReactNode[] = [
    ...(meSitting ? [<Button key="sitin" onClick={() => void tableApi.sitIn(tableId).catch(() => undefined)} title={t('table.sitIn')} aria-label={t('table.sitIn')}>▶ {t('table.sitIn')}</Button>] : []),
    ...(othersSitting.length > 0 ? [<span key="others" className="rounded-md border border-warning px-2 py-1 text-sm" title={t('table.sitOutOthers', { names: othersSitting.join(', ') })}>💤 {othersSitting.length}</span>] : []),
    ...TOOL_IDS.filter((id) => toolNodes[id] && toolScreens(order, id).includes(page + 1)).map((id) => toolNodes[id]),
    ...widgetIcons.filter((id) => toolScreens(order, `w:${id}`).includes(page + 1)).map((id) => iconBtn(`w:${id}`, WIDGET_ICON[id], t(WIDGET_TITLE_KEY[id]), () => setDrawer(`w:${id}`))),
  ];
  // Nabídka ☰: úplná sada nástrojů a widgetů-ikon (co je v liště na obrazovce, je tu také), ať je vždy všechno po ruce.
  const menuItems: ReactNode[] = [
    ...(meSitting ? [barItems[0]] : []),
    ...TOOL_IDS.map((id) => toolNodes[id]).filter(Boolean),
    ...widgetIcons.map((id) => iconBtn(`m-w:${id}`, WIDGET_ICON[id], t(WIDGET_TITLE_KEY[id]), () => setDrawer(`w:${id}`))),
  ];
  return (
    <TableWidgetsProvider view={view} tableId={tableId} inBb={inBb} chat={chatWidget}>
    <div className={`tk-tablepage ${hiddenSides.left ? 'tk-no-panel' : ''}`} data-area={areaAlign} style={pageStyle}>
      {!hiddenSides.left && (
      <Resizable
        as="aside"
        className="tk-tp-panel"
        style={panelStyle}
        w={size.pw}
        h={size.ph}
        scale={area.a / 100}
        limits={{ minW: 160, maxW: 640, minH: 120, maxH: 3000 }}
        onChange={(pw, ph, commit) => {
          setDragging(!commit);
          panelHeights.current.add(ph);
          const heightDragged = panelHeights.current.size > 1 || num('ui.tablePanelHeight') > 0;
          setSize((x) => ({ ...x, pw, ph: heightDragged ? ph : x.ph }));
          if (commit) {
            if (pw !== num('ui.tablePanelWidth')) keep('ui.tablePanelWidth', pw);
            // výška se uloží jen po skutečném tažení; tažení za šířku ji nesmí zafixovat
            if (panelHeights.current.size > 1 && ph !== num('ui.tablePanelHeight')) keep('ui.tablePanelHeight', ph);
            panelHeights.current = new Set();
          }
        }}
        onReset={() => {
          setSize((x) => ({ ...x, pw: defaultOf('ui.tablePanelWidth'), ph: defaultOf('ui.tablePanelHeight') }));
          keep('ui.tablePanelWidth', defaultOf('ui.tablePanelWidth'));
          keep('ui.tablePanelHeight', defaultOf('ui.tablePanelHeight'));
        }}
      >
        <div className="tk-tp-scroll" aria-label={t('table.panel')}>
          <Panel side="left" />
        </div>
      </Resizable>
      )}
      <div className="tk-tp-main flex flex-col gap-2">
        {modern ? (
          <MobileBar
            backTo={isTournament ? `/turnaj/${tournamentId}` : '/stoly'}
            title={`${isTournament ? '🏆 ' : ''}${tableInfo ? `${tableInfo.smallBlind}/${tableInfo.bigBlind}` : ''}`}
            items={barItems}
            onMenu={() => setDrawer('menu')}
          />
        ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Link to={isTournament ? `/turnaj/${tournamentId}` : '/stoly'} className="underline">
            {isTournament ? t('tournament.backToTournament') : t('table.backToLobby')}
          </Link>
          <span className="tk-tp-mobile relative ml-auto flex gap-2">
            {!hiddenSides.left && <Button onClick={() => setDrawer('panel')}>{t('table.panelOpen')}</Button>}
            <Button onClick={() => setDrawer('chat')}>
              {t('table.chatOpen')}
              {channel && channel.unread > 0 && <span className="ml-1 rounded-full bg-accent px-1.5 text-xs text-on-act">{channel.unread}</span>}
            </Button>
            <SoundMenu />
            <Button aria-haspopup="menu" aria-expanded={more} aria-label={t('table.more')} onClick={() => setMore((v) => !v)}>
              ⋯
            </Button>
            {more && (
              <div ref={moreRef} role="menu" className="absolute right-0 top-full z-20 mt-1 flex w-max flex-col gap-1 rounded-md border border-line bg-surface p-2 shadow-lg" onClick={() => setMore(false)}>
                {renderTools(false)}
                {features.assistant && <AssistantToolButton iconOnly={false} />}
              </div>
            )}
          </span>
          <span className="tk-tp-desktop flex flex-wrap items-center gap-2">
            {renderTools(true)}
            <SoundMenu />
            {features.assistant && <AssistantToolButton iconOnly />}
          </span>
        </div>
        )}
        <ErrorToast message={toolError} onClose={() => setToolError('')} />
        {features.polls && <TablePolls tableId={tableId} alsoIds={tournamentId !== tableId ? [tournamentId] : []} />}
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
        {isTournament && <TournamentBanner tournamentId={tournamentId} handRunning={!!(view?.handId && view.winners === null && view.street !== null)} />}
        {isTournament && <DealPanel id={tournamentId} onlyOpen />}
        {isTournament && <BustSummaryButton tournamentId={tournamentId} />}
        {(() => {
          const screen = (
          <TableScreen
            tableId={tableId}
            inBb={inBb}
            quickPost={String(settings.values['ui.quickBetsPostflop'])}
            quickPre={String(settings.values['ui.quickBetsPreflop'])}
            modern={modern}
            extra={
              seated && !modern ? (
                <span className="tk-tp-mobile">
                  <SoundPalette target={{ kind: 'table', id: tableId }} />
                </span>
              ) : undefined
            }
          />
          );
          return modern && !landscape ? (
            <MobilePager
              page={page}
              onPage={setPage}
              tableIndex={tableIdx}
              pages={layoutZones.map((z, i) => (z === 's1' ? <Fragment key="table">{screen}</Fragment> : <MobileScreen key={z} ids={order[z]} channel={channel} visible={page === i} />))}
            />
          ) : (
            screen
          );
        })()}
      </div>
      {layoutEditor && (
        <Modal title={`📱 ${t('mobile.order.title')}`} onClose={() => setLayoutEditor(false)}>
          <MobileOrderEditor values={settings.values} landscape={landscape} onChange={(k, v) => void saveUserSetting(k, v, true).catch(() => undefined)} />
          <div className="mt-3">
            <Button variant="primary" onClick={() => setLayoutEditor(false)}>
              {t('table.close')}
            </Button>
          </div>
        </Modal>
      )}
      {drawer && (
        <div className="tk-drawer" role="dialog" aria-label={drawerTitle}>
          <div className="tk-drawer-head">
            <strong>{drawerTitle}</strong>
            <Button onClick={() => setDrawer(null)}>{t('table.close')}</Button>
          </div>
          <div className="tk-drawer-body flex flex-col gap-2">
            {drawer === 'chat' ? (
              channel && <ChatPanel channel={channel} compact fill />
            ) : drawer === 'scale' ? (
              <MobileScalePanel seatCount={tableInfo?.seatCount ?? seatCountForScale} />
            ) : drawer.startsWith('w:') ? (
              <MobileWidgetDrawer id={drawer.slice(2) as MobileWidget} channel={channel} />
            ) : drawer === 'menu' ? (
              <>
                <div className="flex flex-wrap items-center gap-2">{menuItems}</div>
                <Button
                  onClick={() => {
                    setDrawer(null);
                    setLayoutEditor(true);
                  }}
                >
                  📱 {t('mobile.order.open')}
                </Button>
                <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface p-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" role="switch" checked={settings.values['ui.vibrate'] !== false} onChange={(e) => void saveUserSetting('ui.vibrate', e.target.checked, true).catch(() => undefined)} />
                    {t('table.m.vibrate')}
                  </label>
                </div>
              </>
            ) : (
              <Panel side="left" hide={['chat']} />
            )}
          </div>
        </div>
      )}
      {showSettlement && <SettlementDialog tableId={tableId} onClose={() => setShowSettlement(false)} />}
      {history && <HandHistory tableId={tableId} onClose={() => setHistory(false)} />}
    </div>
    </TableWidgetsProvider>
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
