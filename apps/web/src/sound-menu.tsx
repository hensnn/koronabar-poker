import { useKeepInView } from './keep-in-view';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { labelKey, t } from '@kb/shared';
import { saveUserSetting, useSettings } from './settings';
import { playSfx, SFX_THEMES } from './table/sfx';

/** Přepínače zvuku v nabídce 🔊: každý řádek je osobní nastavení, které se uloží hned. */
const ROWS: { key: string; def: boolean; invert?: boolean; label?: string }[] = [
  { key: 'ui.sfxEnabled', def: true },
  { key: 'sounds.play', def: true },
  { key: 'sounds.jingles', def: true },
  { key: 'sounds.mentionSound', def: true },
  // Zaškrtnuto = hlasatel mluví (hodnota nastavení je obráceně: „ztlumit“).
  { key: 'announcer.mute', def: false, invert: true, label: 'announcer.mute' },
];

/** Kam se rozbalí nabídka u tlačítka: dolů, nebo nahoru, když je tlačítko ve spodní polovině okna (např. ve spodní nabídce „Více“ na telefonu). */
export type PopoverPlace = { up: boolean; style?: CSSProperties };

/**
 * Na úzkém displeji se nabídka roztáhne přes šířku okna pod tlačítkem; ve spodní polovině okna se místo toho rozbalí nad ním
 * (a nejvýš do výšky, která nad tlačítkem zbývá). Bez stylu a bez `up` platí běžné ukotvení u tlačítka.
 */
export function popoverPlace(anchor: HTMLElement | null): PopoverPlace {
  if (!anchor) return { up: false };
  const r = anchor.getBoundingClientRect();
  const wide = window.innerWidth >= 640;
  if (r.top <= window.innerHeight / 2) return wide ? { up: false } : { up: false, style: { top: r.bottom + 4 } };
  return { up: true, style: { bottom: window.innerHeight - r.top + 4, maxHeight: r.top - 12, ...(wide ? { right: window.innerWidth - r.right } : {}) } };
}

/** Třídy ukotvení nabídky podle `popoverPlace` (nahoru: pevně nad tlačítkem; dolů: u tlačítka, na telefonu přes šířku okna). */
export const popoverClass = (up: boolean): string => (up ? 'fixed inset-x-2 sm:inset-x-auto' : 'fixed inset-x-2 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1');

/** Popover se zvukovými přepínači (ikona v záhlaví). Na telefonu se nabídka přilepí k okraji okna, aby nevyjela ven. */
export function SoundMenu() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const popRef = useKeepInView<HTMLDivElement>(open);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<PopoverPlace>({ up: false });
  const toggle = () => {
    setPlace(popoverPlace(box.current));
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const rows = ROWS.filter((r) => r.key !== 'announcer.mute' || settings.values['announcer.enabled'] !== false);
  const isOn = (r: (typeof ROWS)[number]) => {
    const v = Boolean(settings.values[r.key] ?? r.def);
    return r.invert ? !v : v;
  };
  const anyOn = rows.some(isOn);
  const setAll = (on: boolean) => {
    for (const r of rows) void saveUserSetting(r.key, r.invert ? !on : on).catch(() => undefined);
  };
  return (
    <div className="relative" ref={box}>
      <button type="button" className="rounded-md border border-line bg-surface px-3 py-1" aria-haspopup="dialog" aria-expanded={open} title={t('sound.menu')} aria-label={t('sound.menu')} onClick={toggle}>
        {anyOn ? '🔊' : '🔇'}
      </button>
      {open && (
        <div ref={popRef} role="dialog" aria-label={t('sound.menu')} style={place.style} className={`${popoverClass(place.up)} z-50 flex flex-col gap-2 overflow-y-auto rounded-md border border-line bg-surface p-2 shadow-lg sm:w-72`}>
          <strong>{t('sound.menu')}</strong>
          {rows.map((r) => (
            <label key={r.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" role="switch" checked={isOn(r)} onChange={(e) => void saveUserSetting(r.key, r.invert ? !e.target.checked : e.target.checked).catch(() => undefined)} />
              {t(r.label ?? labelKey(r.key))}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm" title={t('settings.ui.sfxTheme.help')}>
            {t('settings.ui.sfxTheme.label')}
            <select
              className="rounded-md border border-line bg-surface px-1 py-0.5 text-sm"
              value={String(settings.values['ui.sfxTheme'] ?? 'classic')}
              onChange={(e) => {
                void saveUserSetting('ui.sfxTheme', e.target.value).catch(() => undefined);
                // Ukázka nové sady po uložení (nastavení se promítne až po chvíli, proto s malým zpožděním).
                window.setTimeout(() => playSfx('chip', Number(settings.values['ui.sfxVolumePercent'] ?? 60) / 100), 300);
              }}
            >
              {SFX_THEMES.map((th) => (
                <option key={th} value={th}>
                  {t(`settings.ui.sfxTheme.option.${th}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 border-t border-line pt-2">
            <button type="button" className="rounded-md border border-line bg-surface px-2 py-1 text-sm" onClick={() => setAll(false)}>
              {t('sound.allOff')}
            </button>
            <button type="button" className="rounded-md border border-line bg-surface px-2 py-1 text-sm" onClick={() => setAll(true)}>
              {t('sound.allOn')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
