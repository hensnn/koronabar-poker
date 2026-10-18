import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { t } from '@kb/shared';
import type { TableView } from '@kb/game-core';
import { useSession } from '../session';
import { saveUserSetting, useSettings } from '../settings';
import { Button, Modal } from '../ui';
import { BountiesBody, DealButton, InfoBody, positionText, useTournamentInfo, wantedList } from './InfoCard';
import { useFeatures } from '../features';
import { useMobileLayout } from './mobile';

/** Widgety pravého panelu u stolu; pořadí je výchozí pořadí zobrazení. */
export const SIDE_WIDGETS = ['info', 'bounties', 'deal', 'tools'] as const;
export type SideId = (typeof SIDE_WIDGETS)[number];

interface SideState {
  collapsed: SideId[];
  hidden: SideId[];
  order: SideId[];
}

const ids = (x: unknown): SideId[] => (Array.isArray(x) ? x.filter((v): v is SideId => (SIDE_WIDGETS as readonly string[]).includes(String(v))) : []);

function parseState(raw: unknown): SideState {
  try {
    const p = JSON.parse(String(raw || '{}')) as Partial<SideState>;
    const order = [...new Set(ids(p.order))];
    for (const [i, w] of SIDE_WIDGETS.entries()) {
      if (order.includes(w)) continue;
      const prev = SIDE_WIDGETS.slice(0, i).reverse().find((x) => order.includes(x));
      order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, w);
    }
    return { collapsed: ids(p.collapsed), hidden: ids(p.hidden), order };
  } catch {
    return { collapsed: [], hidden: [], order: [...SIDE_WIDGETS] };
  }
}

/** Stav panelu je osobní nastavení (synchronizuje se mezi zařízeními), stejně jako u levého panelu. */
function useSideState(): [SideState, (next: SideState) => void] {
  const settings = useSettings();
  const state = useMemo(() => parseState(settings.values['ui.tableSide']), [settings.values]);
  const set = useCallback((next: SideState) => void saveUserSetting('ui.tableSide', JSON.stringify(next)).catch(() => undefined), []);
  return [state, set];
}

function SideSettings({ state, setState, titles, absent, onClose }: { state: SideState; setState: (s: SideState) => void; titles: Record<SideId, string>; absent: SideId[]; onClose: () => void }) {
  const move = (id: SideId, dir: -1 | 1) => {
    const order = [...state.order];
    const i = order.indexOf(id);
    let j = i + dir;
    while (j >= 0 && j < order.length && absent.includes(order[j]!)) j += dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    setState({ ...state, order });
  };
  return (
    <section className="tk-widget">
      <div className="tk-widget-head">{t('table.sidePanelSettings')}</div>
      <div className="tk-widget-body flex flex-col gap-3">
        <h3 className="font-bold">{t('table.panelWidgets')}</h3>
        <ul className="flex flex-col gap-1">
          {state.order
            .filter((id) => !absent.includes(id))
            .map((id, i, list) => (
              <li key={id} className="flex items-center gap-2">
                <label className="flex flex-1 items-center gap-2">
                  <input type="checkbox" checked={!state.hidden.includes(id)} onChange={(e) => setState({ ...state, hidden: e.target.checked ? state.hidden.filter((x) => x !== id) : [...state.hidden, id] })} />
                  {titles[id]}
                </label>
                <Button aria-label={t('table.moveUp')} disabled={i === 0} onClick={() => move(id, -1)}>
                  ↑
                </Button>
                <Button aria-label={t('table.moveDown')} disabled={i === list.length - 1} onClick={() => move(id, 1)}>
                  ↓
                </Button>
              </li>
            ))}
        </ul>
        <div className="flex gap-2">
          <Button onClick={() => setState({ collapsed: [], hidden: [], order: [...SIDE_WIDGETS] })}>{t('table.widget.reset')}</Button>
          <Button variant="primary" onClick={onClose}>
            {t('table.close')}
          </Button>
        </div>
      </div>
    </section>
  );
}

function Frame({ id, title, state, setState, actions, children }: { id: SideId; title: string; state: SideState; setState: (s: SideState) => void; actions?: ReactNode; children: ReactNode }) {
  const collapsed = state.collapsed.includes(id);
  return (
    <section className="tk-widget">
      <div className="tk-widget-head">
        <button className="flex flex-1 items-center gap-2 text-left font-semibold" aria-expanded={!collapsed} onClick={() => setState({ ...state, collapsed: collapsed ? state.collapsed.filter((x) => x !== id) : [...state.collapsed, id] })}>
          <span aria-hidden>{collapsed ? '▸' : '▾'}</span>
          <span className="flex-1">{title}</span>
        </button>
        {actions}
      </div>
      {!collapsed && <div className="tk-widget-body">{children}</div>}
    </section>
  );
}

/**
 * Pravý panel u stolu: informace o hře, odměny na hlavu, dohoda a akce. Přizpůsobuje se ozubeným kolečkem
 * (které widgety, v jakém pořadí a které jsou sbalené), stejně jako levý panel.
 */
export function SidePanel({ view, tournamentId, inBb, tools }: { view: TableView; tournamentId: string | null; inBb: boolean; /** Akce hry (Sit out, Dokoupit, Odejít, ukázání karet…), nebo null. */ tools: ReactNode | null }) {
  const [state, setState] = useSideState();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const mobile = useMobileLayout();
  const features = useFeatures();
  const { me } = useSession();
  const tour = useTournamentInfo(tournamentId);
  const info = view.info;
  const hasDeal = !!tournamentId && !!tour && tour.deal.enabled && tour.status === 'running' && !tour.deal.done;
  const wanted = wantedList(view);

  const titles: Record<SideId, string> = { info: t('table.info.title'), bounties: t('table.info.rewards'), deal: t('table.info.deal'), tools: t('table.widget.actions') };
  const available: Record<SideId, boolean> = {
    info: true,
    // Odměny na hlavu jsou věc turnaje (nebo cokoli, co je u stolu právě vypsané)
    bounties: features.headBounty && (!!tournamentId || wanted.length > 0),
    deal: hasDeal,
    tools: tools !== null,
  };
  const bodies: Record<SideId, ReactNode> = {
    info: <InfoBody view={view} tour={tour} tournamentId={tournamentId} inBb={inBb} />,
    bounties: <BountiesBody view={view} />,
    deal: <DealButton tour={tour} tournamentId={tournamentId} />,
    tools: tools,
  };
  const visible = state.order.filter((id) => available[id] && !state.hidden.includes(id));
  const gear = (
    <button className="rounded-md px-1 text-sm" aria-label={t('table.sidePanelSettings')} title={t('table.sidePanelSettings')} onClick={() => setOpen(true)}>
      ⚙
    </button>
  );

  if (open) {
    return <SideSettings state={state} setState={setState} titles={titles} absent={available.tools ? [] : ['tools']} onClose={() => setOpen(false)} />;
  }

  // Telefon: akce hned, ostatní widgety sbalené do jednoho řádku (moje pozice, počet hráčů/míst, odměny); celé se otevřou v okně.
  if (mobile) {
    const position = positionText(tour, me?.user.id);
    const summary = [tournamentId && tour ? `${tour.alive}/${tour.players}` : `${view.seats.length}/${info.seatCount}`, position, wanted.length > 0 ? `⚑ ${wanted.length}` : null].filter(Boolean).join(' · ');
    const inWindow = visible.filter((id) => id !== 'tools');
    return (
      <>
        {!state.hidden.includes('tools') && tools}
        {inWindow.length > 0 && (
          <button className="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-2 py-1 text-left text-xs" aria-haspopup="dialog" onClick={() => setExpanded(true)}>
            <span className="shrink-0 whitespace-nowrap font-semibold">{t('table.info.title')}</span>
            <span className="truncate font-mono">{summary}</span>
          </button>
        )}
        {expanded && (
          <Modal title={t('table.info.title')} onClose={() => setExpanded(false)}>
            <div className="flex flex-col gap-2">
              {inWindow.map((id) => (
                <section key={id} className="tk-widget">
                  <div className="tk-widget-head">{titles[id]}</div>
                  <div className="tk-widget-body">{bodies[id]}</div>
                </section>
              ))}
              <div className="flex justify-end">{gear}</div>
            </div>
          </Modal>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {visible.map((id) => (
        <Frame key={id} id={id} title={titles[id]} state={state} setState={setState} actions={id === visible[0] ? gear : null}>
          {bodies[id]}
        </Frame>
      ))}
      {visible.length === 0 && <div className="flex justify-end">{gear}</div>}
    </div>
  );
}
