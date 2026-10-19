import { useKeepInView } from './keep-in-view';
import { useEffect, useRef, useState } from 'react';
import { labelKey, t } from '@kb/shared';
import { saveUserSetting, useSettings } from './settings';

/** Přepínače zvuku v nabídce 🔊: každý řádek je osobní nastavení, které se uloží hned. */
const ROWS: { key: string; def: boolean; invert?: boolean; label?: string }[] = [
  { key: 'ui.sfxEnabled', def: true },
  { key: 'sounds.play', def: true },
  { key: 'sounds.jingles', def: true },
  { key: 'sounds.mentionSound', def: true },
  // Zaškrtnuto = hlasatel mluví (hodnota nastavení je obráceně: „ztlumit“).
  { key: 'announcer.mute', def: false, invert: true, label: 'announcer.mute' },
];

/** Na úzkém displeji se nabídka roztáhne přes šířku okna pod tlačítkem (vrací její horní okraj); jinak null = běžné ukotvení u tlačítka. */
export function popoverTop(anchor: HTMLElement | null): number | null {
  if (window.innerWidth >= 640 || !anchor) return null;
  return anchor.getBoundingClientRect().bottom + 4;
}

/** Popover se zvukovými přepínači (ikona v záhlaví). Na telefonu se nabídka přilepí k okraji okna, aby nevyjela ven. */
export function SoundMenu() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const popRef = useKeepInView<HTMLDivElement>(open);
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);
  const toggle = () => {
    setTop(popoverTop(box.current));
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
        <div ref={popRef} role="dialog" aria-label={t('sound.menu')} style={top === null ? undefined : { top }} className="fixed inset-x-2 z-20 flex flex-col gap-2 rounded-md border border-line bg-surface p-2 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1 sm:w-72">
          <strong>{t('sound.menu')}</strong>
          {rows.map((r) => (
            <label key={r.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" role="switch" checked={isOn(r)} onChange={(e) => void saveUserSetting(r.key, r.invert ? !e.target.checked : e.target.checked).catch(() => undefined)} />
              {t(r.label ?? labelKey(r.key))}
            </label>
          ))}
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
