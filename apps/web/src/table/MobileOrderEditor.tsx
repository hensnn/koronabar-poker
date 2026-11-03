import { t, type SettingValue } from '@kb/shared';
import { Button } from '../ui';
import { allowedZones, effectiveOrder, moveItem, moveToZone, ORDER_KEY, parseMobileOrder, serializeOrder, type MobileOrder, type MobileWidget, type Zone } from './mobile-order';

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

/**
 * Rozmístění widgetů na telefonu: obrazovka 1 (stůl; widgety jsou v pásu pod stolem), obrazovky 2 a 3 (listuje se prstem), ikony nahoře a skryté.
 * Pořadí se mění šipkami, místo výběrem; počet obrazovek se volí nahoře. Jde použít na telefonu i z počítače
 * (Nastavení → Telefon), proto dostává hodnoty a ukládání zvenku.
 */
export function MobileOrderEditor({ values, onChange }: { values: Record<string, unknown>; onChange: (key: string, value: SettingValue) => void }) {
  const order = parseMobileOrder(values[ORDER_KEY], values);
  const save = (next: MobileOrder) => onChange(ORDER_KEY, serializeOrder(next));
  // Nepoužívané obrazovky se nenabízejí; jejich widgety se na jedné nebo dvou obrazovkách přesunou (viz effectiveOrder).
  const zones: Zone[] = ['s1', ...(order.screens >= 2 ? (['s2'] as const) : []), ...(order.screens >= 3 ? (['s3'] as const) : []), 'icon', 'hidden'];
  const offered = (id: MobileWidget) => allowedZones(id).filter((z) => zones.includes(z));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{t('mobile.order.help')}</p>
      <div role="radiogroup" aria-label={t('mobile.order.screens')} className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t('mobile.order.screens')}</span>
        {([1, 2, 3] as const).map((n) => (
          <button key={n} role="radio" aria-checked={order.screens === n} onClick={() => save({ ...effectiveOrder({ ...order, screens: n }), screens: n })} className={`rounded-md border border-line px-3 py-1 ${order.screens === n ? 'bg-primary text-on-primary' : 'bg-surface text-text'}`}>
            {n}
          </button>
        ))}
      </div>
      {zones.map((zone) => {
        const list = order[zone];
        const st = ZONE_STYLE[zone];
        return (
          <section key={zone} className={`rounded-md border-2 p-3 ${st.box}`} aria-label={t(`mobile.order.zone.${zone}`)}>
            <h3 className={`mb-2 font-bold ${st.head}`}>{t(`mobile.order.zone.${zone}`)}</h3>
            <ul className="flex flex-col gap-1">
              {list.map((id, i) => (
                <li key={id} className="flex flex-wrap items-center gap-1 rounded-sm bg-surface px-2 py-1">
                  <span className="min-w-32 flex-1">{t(WIDGET_TITLE_KEY[id])}</span>
                  <Button aria-label={t('table.moveUp')} disabled={i === 0} onClick={() => save({ ...order, [zone]: moveItem(list, id, -1) })}>
                    ↑
                  </Button>
                  <Button aria-label={t('table.moveDown')} disabled={i === list.length - 1} onClick={() => save({ ...order, [zone]: moveItem(list, id, 1) })}>
                    ↓
                  </Button>
                  {offered(id).length > 1 && (
                    <select className="rounded-sm border border-line bg-surface px-1 py-1" aria-label={t('mobile.order.moveTo', { name: t(WIDGET_TITLE_KEY[id]) })} value={zone} onChange={(e) => save(moveToZone(order, id, e.target.value as Zone))}>
                      {offered(id).map((z) => (
                        <option key={z} value={z}>
                          {t(`mobile.order.zone.${z}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </li>
              ))}
              {list.length === 0 && <li className="text-sm text-muted">{t('mobile.order.empty')}</li>}
            </ul>
          </section>
        );
      })}
      <div>
        <Button onClick={() => onChange(ORDER_KEY, '')}>{t('mobile.order.reset')}</Button>
      </div>
    </div>
  );
}
