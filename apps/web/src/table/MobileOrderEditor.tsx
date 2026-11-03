import { useState } from 'react';
import { t, type SettingValue } from '@kb/shared';
import { Button, Tabs } from '../ui';
import { allowedZones, effectiveOrder, forLandscape, mainIndex, moveItem, moveToZone, orderKeyFor, parseMobileOrder, serializeOrder, TOOL_ICON, TOOL_IDS, TOOL_TITLE_KEY, toggleToolScreen, toolScreens, WIDGET_ICON, screenLayout, type MobileOrder, type MobileWidget, type Zone } from './mobile-order';

export const WIDGET_TITLE_KEY: Record<MobileWidget, string> = {
  timer: 'mobile.order.part.timer',
  best: 'table.widget.best',
  sounds: 'table.widget.sounds',
  events: 'table.widget.events',
  players: 'table.widget.players',
  table: 'table.widget.table',
  bounties: 'table.info.rewards',
  info: 'table.info.title',
  chat: 'table.chat',
};

const ZONE_STYLE: Record<Zone, { box: string; head: string }> = {
  s1: { box: 'border-success bg-success/10', head: 'text-success' },
  s2: { box: 'border-info bg-info/10', head: 'text-info' },
  s3: { box: 'border-warning bg-warning/10', head: 'text-warning' },
  icon: { box: 'border-accent bg-accent/10', head: 'text-accent' },
  hidden: { box: 'border-line bg-raised', head: 'text-muted' },
};

/** Krátký popisek místa na tlačítku: obrazovky číslem, ostatní slovem. */
const CHIP: Record<Zone, string> = { s1: '1', s2: '2', s3: '3', icon: '🔘', hidden: '🚫' };

/**
 * Rozmístění widgetů a ikon na telefonu. Záložka Widgety: kam který widget patří (obrazovka 1 pod stolem, 2, 3, ikona, skrytý) jedním klepnutím
 * na číslo obrazovky. Záložka Ikony: na kterých obrazovkách je ikona v horní liště (všechny jsou vždy v nabídce ☰).
 * Jde použít na telefonu i z počítače (Nastavení → Telefon), proto dostává hodnoty a ukládání zvenku.
 */
export function MobileOrderEditor({ values, onChange, landscape: landscapeNow = false }: { values: Record<string, unknown>; onChange: (key: string, value: SettingValue) => void; /** Otevřít rovnou rozmístění pro telefon na šířku (např. když je telefon otočený). */ landscape?: boolean }) {
  const [tab, setTab] = useState<'widgets' | 'icons'>('widgets');
  const [landscape, setLandscape] = useState(landscapeNow);
  const key = orderKeyFor(landscape);
  // Na šířku je jedna obrazovka (vpravo pod ovládacím panelem); na výšku 1 až 3 obrazovky.
  const order = landscape ? forLandscape(parseMobileOrder(values[key], values, true)) : parseMobileOrder(values[key], values);
  const save = (next: MobileOrder) => onChange(key, serializeOrder(next));
  const screens = Array.from({ length: order.screens }, (_, i) => i + 1);
  const layout = screenLayout(order);
  const zones: Zone[] = landscape ? ['s1', 'icon', 'hidden'] : [...layout, 'icon', 'hidden'];
  // Číslo obrazovky zleva, na které je dané místo (obrazovka se stolem je na pozici podle volby hráče).
  const posOf = (z: Zone): number => (z === 's1' || z === 's2' || z === 's3' ? layout.indexOf(z) + 1 : 0);
  const zoneLabel = (z: Zone): string => (landscape ? (z === 's1' ? t('mobile.order.zone.s1Landscape') : t(`mobile.order.zone.${z}`)) : z === 's1' ? t('mobile.order.zone.table', { n: posOf(z) }) : z === 's2' || z === 's3' ? t('mobile.order.zone.screenN', { n: posOf(z) }) : t(`mobile.order.zone.${z}`));
  const offered = (id: MobileWidget) => zones.filter((z) => allowedZones(id).includes(z));
  const widgetIcons = order.icon.filter((id) => id !== 'info' && id !== 'chat');

  const chipClass = (on: boolean) => `min-w-9 rounded-md border px-2 py-1 text-sm ${on ? 'border-primary bg-primary text-on-primary' : 'border-line bg-surface text-text'}`;

  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label={t('mobile.order.orientation')} className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t('mobile.order.orientation')}</span>
        {([false, true] as const).map((l) => (
          <button key={String(l)} role="radio" aria-checked={landscape === l} onClick={() => setLandscape(l)} className={chipClass(landscape === l)}>
            {l ? '📱↔ ' + t('mobile.order.landscape') : '📱↕ ' + t('mobile.order.portrait')}
          </button>
        ))}
      </div>
      <p className="text-sm text-muted">{landscape ? t('mobile.order.landscapeHelp') : t('mobile.order.help')}</p>
      {!landscape && (
      <div role="radiogroup" aria-label={t('mobile.order.screens')} className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t('mobile.order.screens')}</span>
        {([1, 2, 3] as const).map((n) => (
          <button key={n} role="radio" aria-checked={order.screens === n} onClick={() => save({ ...effectiveOrder({ ...order, screens: n }), screens: n })} className={chipClass(order.screens === n)}>
            {n}
          </button>
        ))}
      </div>
      )}
      {!landscape && order.screens > 1 && (
        <div role="radiogroup" aria-label={t('mobile.order.main')} className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t('mobile.order.main')}</span>
          {screens.map((n) => (
            <button key={n} role="radio" aria-checked={mainIndex(order) + 1 === n} onClick={() => save({ ...order, main: n as 1 | 2 | 3 })} className={chipClass(mainIndex(order) + 1 === n)}>
              {n}
            </button>
          ))}
        </div>
      )}
      <Tabs tabs={[{ id: 'widgets' as const, label: t('mobile.order.tab.widgets') }, { id: 'icons' as const, label: t('mobile.order.tab.icons') }]} value={tab} onChange={setTab} />

      {tab === 'widgets' &&
        zones.map((zone) => {
          const list = order[zone];
          const st = ZONE_STYLE[zone];
          return (
            <section key={zone} className={`rounded-md border-2 p-3 ${st.box}`} aria-label={zoneLabel(zone)}>
              <h3 className={`mb-2 font-bold ${st.head}`}>{zoneLabel(zone)}</h3>
              <ul className="flex flex-col gap-1">
                {list.map((id, i) => (
                  <li key={id} className="flex flex-col gap-1 rounded-sm bg-surface px-2 py-1">
                    <div className="flex items-center gap-1">
                      <span className="min-w-0 flex-1">{t(WIDGET_TITLE_KEY[id])}</span>
                      <Button aria-label={t('table.moveUp')} disabled={i === 0} onClick={() => save({ ...order, [zone]: moveItem(list, id, -1) })}>
                        ↑
                      </Button>
                      <Button aria-label={t('table.moveDown')} disabled={i === list.length - 1} onClick={() => save({ ...order, [zone]: moveItem(list, id, 1) })}>
                        ↓
                      </Button>
                    </div>
                    {offered(id).length > 1 && (
                      <div role="radiogroup" aria-label={t('mobile.order.moveTo', { name: t(WIDGET_TITLE_KEY[id]) })} className="flex flex-wrap items-center gap-1">
                        <span className="text-xs text-muted">{t('mobile.order.place')}</span>
                        {offered(id).map((z) => (
                          <button key={z} role="radio" aria-checked={z === zone} title={zoneLabel(z)} aria-label={zoneLabel(z)} onClick={() => save(moveToZone(order, id, z))} className={chipClass(z === zone)}>
                            {z === 's1' || z === 's2' || z === 's3' ? (landscape ? '1' : String(posOf(z))) : CHIP[z]}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
                {list.length === 0 && <li className="text-sm text-muted">{t('mobile.order.empty')}</li>}
              </ul>
            </section>
          );
        })}

      {tab === 'icons' && (
        <section className="rounded-md border-2 border-line bg-raised p-3">
          <p className="mb-2 text-sm text-muted">{t('mobile.order.iconsHelp')}</p>
          <ul className="flex flex-col gap-1">
            {[...TOOL_IDS.map((id) => ({ key: id as string, icon: TOOL_ICON[id], label: t(TOOL_TITLE_KEY[id]) })), ...widgetIcons.map((id) => ({ key: `w:${id}`, icon: WIDGET_ICON[id], label: t(WIDGET_TITLE_KEY[id]) }))].map((row) => {
              const on = toolScreens(order, row.key);
              return (
                <li key={row.key} className="flex items-center gap-2 rounded-sm bg-surface px-2 py-1">
                  <span aria-hidden="true" className="w-6 text-center text-lg">
                    {row.icon}
                  </span>
                  <span className="min-w-0 flex-1">{row.label}</span>
                  <span role="group" aria-label={t('mobile.order.iconScreens', { name: row.label })} className="flex gap-1">
                    {screens.map((n) => (
                      <button key={n} aria-pressed={on.includes(n)} aria-label={t('mobile.screenN', { n })} title={t('mobile.screenN', { n })} onClick={() => save(toggleToolScreen(order, row.key, n))} className={chipClass(on.includes(n))}>
                        {n}
                      </button>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <div>
        <Button onClick={() => onChange(key, '')}>{t('mobile.order.reset')}</Button>
      </div>
    </div>
  );
}
