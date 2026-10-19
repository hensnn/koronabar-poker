import { useMemo, useState, type ReactNode } from 'react';
import { t } from '@kb/shared';
import { defaultOf, saveUserSetting, useSettings } from '../settings';
import { Button, Modal } from '../ui';
import { positionText, useTournamentInfo, wantedList } from './InfoCard';
import { forMobile, moveToSide, reorder, sideOf, toggleCollapsed, toggleHidden, WIDGET_IDS, type Layout, type Side, type WidgetId } from './layout';
import { useMobileLayout } from './mobile';
import { useSession } from '../session';
import { useTableWidgets, type WidgetDef } from './widgets';

/** Rámeček jednoho widgetu: sbalitelná hlavička s volitelnými doplňky. */
function Frame({ id, def, layout, setLayout, extra }: { id: WidgetId; def: WidgetDef; layout: Layout; setLayout: (l: Layout) => void; extra?: ReactNode }) {
  const collapsed = layout.collapsed.includes(id);
  return (
    <section className="tk-widget">
      <div className="tk-widget-head">
        <button className="flex flex-1 items-center gap-2 text-left font-semibold" aria-expanded={!collapsed} onClick={() => setLayout(toggleCollapsed(layout, id))}>
          <span aria-hidden>{collapsed ? '▸' : '▾'}</span>
          <span className="flex-1">{def.title}</span>
          {def.badge ? <span className="rounded-full bg-accent px-1.5 text-xs text-on-act">{def.badge}</span> : null}
        </button>
        {def.actions}
        {extra}
      </div>
      {!collapsed && <div className="tk-widget-body">{def.body}</div>}
    </section>
  );
}

/** Ozubené kolečko: které widgety, v kterém panelu a v jakém pořadí, plus volby zobrazení u stolu. Stejné z obou panelů. */
function LayoutSettings({ onClose }: { onClose: () => void }) {
  const { layout, setLayout, defs } = useTableWidgets();
  const settings = useSettings();
  const present = (id: WidgetId) => id !== 'chat' || defs.chat.body !== null;
  const toggle = (key: string, value: boolean) => void saveUserSetting(key, value).catch(() => undefined);
  const flags: { key: string; label: string; def: boolean }[] = [
    { key: 'ui.rotateToMe', label: t('settings.ui.rotateToMe.label'), def: true },
    { key: 'ui.hideMyCards', label: t('settings.ui.hideMyCards.label'), def: false },
    { key: 'ui.dealAnimation', label: t('settings.ui.dealAnimation.label'), def: true },
    { key: 'ui.showInBb', label: t('settings.ui.showInBb.label'), def: false },
    { key: 'ui.showSymbolAtTable', label: t('settings.ui.showSymbolAtTable.label'), def: true },
    { key: 'xp.showAtTable', label: t('settings.xp.showAtTable.label'), def: true },
  ];
  const skip = (id: WidgetId) => !present(id);
  const sides: Side[] = ['left', 'right'];
  return (
    <section className="tk-widget">
      <div className="tk-widget-head">{t('table.panelSettings')}</div>
      <div className="tk-widget-body flex flex-col gap-3">
        <h3 className="font-bold">{t('table.panelWidgets')}</h3>
        <p className="text-xs text-muted">{t('table.panelWidgetsHelp')}</p>
        {sides.map((side) => (
          <div key={side}>
            <h4 className="mb-1 text-sm font-semibold text-muted">{side === 'left' ? t('table.panelLeft') : t('table.panelRight')}</h4>
            <ul className="flex flex-col gap-1">
              {layout[side].filter(present).map((id, i, list) => (
                <li key={id} className="flex flex-wrap items-center gap-1">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input type="checkbox" checked={!layout.hidden.includes(id)} onChange={() => setLayout(toggleHidden(layout, id))} />
                    <span className="truncate">{defs[id].title}</span>
                  </label>
                  <Button aria-label={side === 'left' ? t('table.moveRight') : t('table.moveLeft')} title={side === 'left' ? t('table.moveRight') : t('table.moveLeft')} onClick={() => setLayout(moveToSide(layout, id, side === 'left' ? 'right' : 'left'))}>
                    {side === 'left' ? '→' : '←'}
                  </Button>
                  <Button aria-label={t('table.moveUp')} disabled={i === 0} onClick={() => setLayout(reorder(layout, id, -1, skip))}>
                    ↑
                  </Button>
                  <Button aria-label={t('table.moveDown')} disabled={i === list.length - 1} onClick={() => setLayout(reorder(layout, id, 1, skip))}>
                    ↓
                  </Button>
                </li>
              ))}
              {layout[side].filter(present).length === 0 && <li className="text-sm text-muted">{t('table.panelEmpty')}</li>}
            </ul>
          </div>
        ))}
        <h3 className="font-bold">{t('table.panelDisplay')}</h3>
        {flags.map((f) => (
          <label key={f.key} className="flex items-center gap-2">
            <input type="checkbox" checked={Boolean(settings.values[f.key] ?? f.def)} onChange={(e) => toggle(f.key, e.target.checked)} />
            {f.label}
          </label>
        ))}
        <div className="flex gap-2">
          <Button
            onClick={() => {
              void saveUserSetting('ui.tableLayout', '').catch(() => undefined);
              void saveUserSetting('ui.tablePanel', '').catch(() => undefined);
              void saveUserSetting('ui.tableSide', '').catch(() => undefined);
              for (const k of ['ui.tablePanelWidth', 'ui.tablePanelHeight', 'ui.tableChatHeight', 'ui.tableSideWidth', 'ui.tableSideHeight']) void saveUserSetting(k, defaultOf(k)).catch(() => undefined);
            }}
          >
            {t('table.widget.reset')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('table.close')}
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * Jeden panel u stolu (levý nebo pravý). Oba panely čerpají ze stejné sady widgetů a rozložení, takže se widgety
 * dají přesouvat mezi nimi. Na telefonu je pravý panel sbalený do jednoho řádku (moje pozice, počet hráčů, odměny).
 */
export function Panel({ side, hide = [] }: { side: Side; /** Widgety, které se v tomto výskytu panelu nezobrazí (chat v zásuvce na telefonu má vlastní tlačítko). */ hide?: WidgetId[] }) {
  const { layout: stored, setLayout, defs, view } = useTableWidgets();
  const mobile = useMobileLayout();
  const layout = mobile ? forMobile(stored) : stored;
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { me } = useSession();
  const tournamentId = view?.info.tournament ? (view.info.tournamentId ?? null) : null;
  const tour = useTournamentInfo(tournamentId);
  const shown = (id: WidgetId) => defs[id].show && !layout.hidden.includes(id) && !hide.includes(id);
  const visible = layout[side].filter(shown);
  const gear = (
    <button className="rounded-md px-1 text-sm" aria-label={t('table.panelSettings')} title={t('table.panelSettings')} onClick={() => setOpen(true)}>
      ⚙
    </button>
  );
  const wanted = useMemo(() => (view ? wantedList(view) : []), [view]);

  if (open) return <LayoutSettings onClose={() => setOpen(false)} />;

  // Telefon, pravý panel: akce hned, ostatní widgety sbalené do jednoho řádku; celé se otevřou v okně.
  if (mobile && side === 'right') {
    const inWindow = visible.filter((id) => id !== 'tools');
    const position = positionText(tour, me?.user.id);
    const summary = [view ? (tournamentId && tour ? `${tour.alive}/${tour.players}` : `${view.seats.length}/${view.info.seatCount}`) : null, position, wanted.length > 0 ? `⚑ ${wanted.length}` : null].filter(Boolean).join(' · ');
    return (
      <>
        {visible.includes('tools') && defs.tools.body}
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
                  <div className="tk-widget-head">{defs[id].title}</div>
                  <div className="tk-widget-body">{defs[id].body}</div>
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
    <>
      {visible.length === 0 && (
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-muted">{side === 'left' ? t('table.panel') : t('table.panelRight')}</span>
          {gear}
        </div>
      )}
      {visible.map((id) => (
        <Frame key={id} id={id} def={defs[id]} layout={stored} setLayout={setLayout} extra={id === visible[0] ? gear : null} />
      ))}
    </>
  );
}

/** Pomocná kontrola pro testy a zobrazení: ve kterém panelu widget je. */
export const panelOf = (layout: Layout, id: WidgetId): Side => sideOf(layout, id);
void WIDGET_IDS;
