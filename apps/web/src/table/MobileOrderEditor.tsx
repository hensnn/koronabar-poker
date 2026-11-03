import { t, type SettingValue } from '@kb/shared';
import { Button } from '../ui';
import type { WidgetId } from './layout';
import { MID_FLAG, moveItem, ORDER_KEY, parseMobileOrder, serializeOrder, type MidPart, type MobileOrder } from './mobile-order';

const INFO_TITLE: Record<WidgetId, string> = {
  table: 'table.widget.table',
  best: 'table.widget.best',
  players: 'table.widget.players',
  events: 'table.widget.events',
  chat: 'table.chat',
  sounds: 'table.widget.sounds',
  info: 'table.info.title',
  bounties: 'table.info.rewards',
};

/**
 * Pořadí widgetů na telefonu: části pod stolem (s vypínačem) a widgety v zásuvce ℹ️. Jde použít na telefonu i z počítače
 * (v Nastavení → Telefon), proto dostává hodnoty a ukládání zvenku.
 */
export function MobileOrderEditor({ values, onChange }: { values: Record<string, unknown>; onChange: (key: string, value: SettingValue) => void }) {
  const order = parseMobileOrder(values[ORDER_KEY]);
  const save = (next: MobileOrder) => onChange(ORDER_KEY, serializeOrder(next));
  const row = <T extends string>(id: T, label: string, i: number, list: T[], move: (dir: -1 | 1) => void, flag?: { key: string; def: boolean }) => (
    <li key={id} className="flex flex-wrap items-center gap-1 rounded-sm bg-surface px-2 py-1">
      <label className="flex min-w-0 flex-1 items-center gap-2">
        {flag && <input type="checkbox" checked={flag.def ? values[flag.key] !== false : values[flag.key] === true} onChange={(e) => onChange(flag.key, e.target.checked)} />}
        <span className="truncate">{label}</span>
      </label>
      <Button aria-label={t('table.moveUp')} disabled={i === 0} onClick={() => move(-1)}>
        ↑
      </Button>
      <Button aria-label={t('table.moveDown')} disabled={i === list.length - 1} onClick={() => move(1)}>
        ↓
      </Button>
    </li>
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{t('mobile.order.help')}</p>
      <section className="rounded-md border-2 border-info bg-info/10 p-3" aria-label={t('mobile.order.mid')}>
        <h3 className="mb-2 font-bold text-info">{t('mobile.order.mid')}</h3>
        <ul className="flex flex-col gap-1">{order.mid.map((id: MidPart, i) => row(id, t(`mobile.order.part.${id}`), i, order.mid, (d) => save({ ...order, mid: moveItem(order.mid, id, d) }), MID_FLAG[id]))}</ul>
      </section>
      <section className="rounded-md border-2 border-warning bg-warning/10 p-3" aria-label={t('mobile.order.info')}>
        <h3 className="mb-2 font-bold text-warning">{t('mobile.order.info')}</h3>
        <ul className="flex flex-col gap-1">{order.info.map((id, i) => row(id, t(INFO_TITLE[id]), i, order.info, (d) => save({ ...order, info: moveItem(order.info, id, d) })))}</ul>
      </section>
      <div>
        <Button onClick={() => onChange(ORDER_KEY, '')}>{t('mobile.order.reset')}</Button>
      </div>
    </div>
  );
}
