import { t, type SettingValue } from '@kb/shared';
import { Button } from '../ui';
import { allowedZones, moveItem, moveToZone, ORDER_KEY, parseMobileOrder, serializeOrder, type MobileOrder, type MobileWidget, type Zone } from './mobile-order';

const TITLE: Record<MobileWidget, string> = {
  timer: 'mobile.order.part.timer',
  best: 'table.widget.best',
  sounds: 'table.widget.sounds',
  events: 'table.widget.events',
  players: 'table.widget.players',
  table: 'table.widget.table',
  bounties: 'table.info.rewards',
  info: 'table.info.title',
};

const ZONE_STYLE: Record<Zone, { box: string; head: string }> = {
  mid: { box: 'border-info bg-info/10', head: 'text-info' },
  info: { box: 'border-warning bg-warning/10', head: 'text-warning' },
  hidden: { box: 'border-line bg-raised', head: 'text-muted' },
};

/**
 * Rozmístění widgetů na telefonu: pod stolem (nad pevným ovládacím panelem), v informacích (zásuvka ℹ️) nebo skryté.
 * Pořadí se mění šipkami, místo výběrem. Jde použít na telefonu i z počítače (Nastavení → Telefon), proto dostává hodnoty a ukládání zvenku.
 */
export function MobileOrderEditor({ values, onChange }: { values: Record<string, unknown>; onChange: (key: string, value: SettingValue) => void }) {
  const order = parseMobileOrder(values[ORDER_KEY], values);
  const save = (next: MobileOrder) => onChange(ORDER_KEY, serializeOrder(next));
  const zones: Zone[] = ['mid', 'info', 'hidden'];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{t('mobile.order.help')}</p>
      {zones.map((zone) => {
        const list = order[zone];
        const st = ZONE_STYLE[zone];
        return (
          <section key={zone} className={`rounded-md border-2 p-3 ${st.box}`} aria-label={t(`mobile.order.zone.${zone}`)}>
            <h3 className={`mb-2 font-bold ${st.head}`}>{t(`mobile.order.zone.${zone}`)}</h3>
            <ul className="flex flex-col gap-1">
              {list.map((id, i) => (
                <li key={id} className="flex flex-wrap items-center gap-1 rounded-sm bg-surface px-2 py-1">
                  <span className="min-w-32 flex-1">{t(TITLE[id])}</span>
                  <Button aria-label={t('table.moveUp')} disabled={i === 0} onClick={() => save({ ...order, [zone]: moveItem(list, id, -1) })}>
                    ↑
                  </Button>
                  <Button aria-label={t('table.moveDown')} disabled={i === list.length - 1} onClick={() => save({ ...order, [zone]: moveItem(list, id, 1) })}>
                    ↓
                  </Button>
                  {allowedZones(id).length > 1 && (
                    <select className="rounded-sm border border-line bg-surface px-1 py-1" aria-label={t('mobile.order.moveTo', { name: t(TITLE[id]) })} value={zone} onChange={(e) => save(moveToZone(order, id, e.target.value as Zone))}>
                      {allowedZones(id).map((z) => (
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
