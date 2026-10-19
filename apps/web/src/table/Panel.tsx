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

/**
 * Nastavení panelů u stolu: jedno okno pro oba panely. Levý a pravý panel jsou vedle sebe, každý vlastní barvou;
 * každý widget je právě v jednom z nich (zobrazit, pořadí, přesun do druhého panelu). Pod tím jsou volby zobrazení.
 */
const SIDE_STYLE: Record<Side, { box: string; head: string; dot: string }> = {
  left: { box: 'border-info bg-info/10', head: 'text-info', dot: 'bg-info' },
  right: { box: 'border-warning bg-warning/10', head: 'text-warning', dot: 'bg-warning' },
};

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
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t('table.panelWidgetsHelp')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        {sides.map((side) => {
          const other: Side = side === 'left' ? 'right' : 'left';
          const list = layout[side].filter(present);
          const st = SIDE_STYLE[side];
          const name = side === 'left' ? t('table.panelLeft') : t('table.panelRight');
          const otherName = other === 'left' ? t('table.panelLeft') : t('table.panelRight');
          return (
            <section key={side} className={`rounded-md border-2 p-3 ${st.box}`} aria-label={name}>
              <h3 className={`mb-2 flex items-center gap-2 text-lg font-bold ${st.head}`}>
                <span aria-hidden="true" className={`inline-block h-3 w-3 rounded-full ${st.dot}`} />
                {side === 'left' ? '◀ ' : ''}
                {name}
                {side === 'right' ? ' ▶' : ''}
              </h3>
              <ul className="flex flex-col gap-1">
                {list.map((id, i) => (
                  <li key={id} className="flex flex-wrap items-center gap-1 rounded-sm bg-surface px-2 py-1">
                    <label className="flex min-w-0 flex-1 items-center gap-2">
                      <input type="checkbox" checked={!layout.hidden.includes(id)} onChange={() => setLayout(toggleHidden(layout, id))} />
                      <span className="truncate">{defs[id].title}</span>
                    </label>
                    <Button aria-label={t('table.moveUp')} disabled={i === 0} onClick={() => setLayout(reorder(layout, id, -1, skip))}>
                      ↑
                    </Button>
                    <Button aria-label={t('table.moveDown')} disabled={i === list.length - 1} onClick={() => setLayout(reorder(layout, id, 1, skip))}>
                      ↓
                    </Button>
                    <Button title={t('table.moveTo', { panel: otherName })} aria-label={t('table.moveTo', { panel: otherName })} onClick={() => setLayout(moveToSide(layout, id, other))}>
                      {side === 'left' ? '→' : '←'}
                    </Button>
                  </li>
                ))}
                {list.length === 0 && <li className="text-sm text-muted">{t('table.panelEmpty')}</li>}
              </ul>
            </section>
          );
        })}
      </div>
      <section>
        <h3 className="mb-1 font-bold">{t('table.panelDisplay')}</h3>
        <div className="grid gap-1 md:grid-cols-2">
          {flags.map((f) => (
            <label key={f.key} className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(settings.values[f.key] ?? f.def)} onChange={(e) => toggle(f.key, e.target.checked)} />
              {f.label}
            </label>
          ))}
        </div>
      </section>
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

  const settingsModal = open ? (
    <Modal title={t('table.panelSettings')} wide onClose={() => setOpen(false)}>
      <LayoutSettings onClose={() => setOpen(false)} />
    </Modal>
  ) : null;

  // Telefon, pravý panel: akce hned, ostatní widgety sbalené do jednoho řádku; celé se otevřou v okně.
  if (mobile && side === 'right') {
    const inWindow = visible.filter((id) => id !== 'tools' && id !== 'reveal');
    const position = positionText(tour, me?.user.id);
    const summary = [view ? (tournamentId && tour ? `${tour.alive}/${tour.players}` : `${view.seats.length}/${view.info.seatCount}`) : null, position, wanted.length > 0 ? `⚑ ${wanted.length}` : null].filter(Boolean).join(' · ');
    return (
      <>
        {settingsModal}
        {visible.includes('tools') && defs.tools.body}
        {visible.includes('reveal') && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-muted">{defs.reveal.title}:</span>
            {defs.reveal.body}
          </div>
        )}
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
      {settingsModal}
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
