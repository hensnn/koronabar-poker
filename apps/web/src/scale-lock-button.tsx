import { t } from '@kb/shared';
import { useScaleFactor } from './scale-lock';
import { saveUserSetting, useSettings } from './settings';
import { Button } from './ui';

/** Tlačítko měřítka okna (záhlaví a lišta u stolu). Ukáže se jen tehdy, když je funkce v osobním nastavení zapnutá (Tlačítko / Zapnuto). */
export function ScaleLockButton() {
  const mode = String(useSettings().values['ui.scaleLock'] ?? 'off');
  const s = useScaleFactor();
  if (mode === 'off') return null;
  const on = mode === 'on';
  const label = t(on ? 'scaleLock.unlock' : 'scaleLock.lock');
  return (
    <button
      type="button"
      className="rounded-md border border-line bg-surface px-3 py-1"
      aria-pressed={on}
      title={label}
      aria-label={label}
      onClick={() => void saveUserSetting('ui.scaleLock', on ? 'button' : 'on', true).catch(() => undefined)}
    >
      {on ? '🔒' : '🔓'}
      {on && <span className="ml-1 text-xs">{Math.round(s * 100)} %</span>}
    </button>
  );
}

/** Tlačítka se zámkem v nabídce velikosti stolu: zamknout podle výšky okna, zamknout celé vzorové rozložení, odemknout. */
export function ScaleLockButtons() {
  const values = useSettings().values;
  const on = values['ui.scaleLock'] === 'on';
  const fit = values['ui.scaleLockMode'] === 'fit';
  const s = useScaleFactor();
  const lock = (mode: 'height' | 'fit') => {
    void saveUserSetting('ui.scaleLockMode', mode, true).catch(() => undefined);
    void saveUserSetting('ui.scaleLock', 'on', true).catch(() => undefined);
  };
  const pressed = 'border-primary bg-raised';
  return (
    <div role="group" aria-label={t('scaleLock.title')} className="flex flex-col gap-1 border-t border-line pt-2">
      <span className="text-sm font-medium">
        {t('scaleLock.title')}
        {on ? ` (${Math.round(s * 100)} %)` : ''}
      </span>
      <p className="max-w-64 text-xs text-muted">{t('scaleLock.help')}</p>
      <div className="flex flex-wrap gap-1">
        <Button className={on && !fit ? pressed : ''} aria-pressed={on && !fit} onClick={() => lock('height')}>
          🔒 {t('scaleLock.byHeight')}
        </Button>
        <Button className={on && fit ? pressed : ''} aria-pressed={on && fit} onClick={() => lock('fit')}>
          🔒 {t('scaleLock.whole')}
        </Button>
        <Button disabled={!on} onClick={() => void saveUserSetting('ui.scaleLock', 'button', true).catch(() => undefined)}>
          🔓 {t('scaleLock.unlockShort')}
        </Button>
      </div>
    </div>
  );
}
