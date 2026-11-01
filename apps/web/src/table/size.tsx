import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { t } from '@kb/shared';
import { saveUserSetting, useSettings } from '../settings';
import { Button } from '../ui';

const H = 'ui.tableHeightPercent';
const A = 'ui.tableAreaWidthPercent';
const ALIGN = 'ui.tableAreaAlign';
const FIT = 'ui.tableFitWindow';

/**
 * Přizpůsobení stolu oknu (osobní volba): změří, kolik místa je nad stolem, a CSS (`html[data-fit]`) nechá stůl zabrat zbytek výšky
 * okna nad stavovým řádkem a lištou akcí. Bez volby platí pevná rezerva.
 */
export function useTableFit(): void {
  const on = useSettings().values[FIT] === true;
  useEffect(() => {
    const root = document.documentElement;
    if (!on) return;
    root.setAttribute('data-fit', '1');
    const measure = () => {
      const room = document.querySelector('.tk-room');
      if (!room) return;
      root.style.setProperty('--tk-fit-top', `${Math.round(room.getBoundingClientRect().top + window.scrollY)}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    // stůl se může vykreslit až po načtení dat: změří se znovu, když se v dokumentu objeví nebo změní prvky
    const mo = new MutationObserver(measure);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', measure);
      root.removeAttribute('data-fit');
      root.style.removeProperty('--tk-fit-top');
    };
  }, [on]);
}

/** Rozpracovaná hodnota při tažení posuvníku (náhled hned, na server se uloží až po puštění). */
let live: { h?: number; a?: number } = {};
const listeners = new Set<() => void>();
const publish = (next: typeof live) => {
  live = next;
  listeners.forEach((l) => l());
};
const field = (key: string): 'h' | 'a' => (key === H ? 'h' : 'a');

/** Velikost stolu (h) a šířka plochy hry (a) v procentech dostupného místa (100 = celé okno). */
export function useTableSize(): { h: number; a: number } {
  const values = useSettings().values;
  const l = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => live,
  );
  return { h: l.h ?? Number(values[H] ?? 100), a: l.a ?? Number(values[A] ?? 100) };
}

/** Tlačítko 📐 v liště stolu: otevře malé okno s posuvníky (plocha hry a velikost stolu). */
export function TableSizeButton({ iconOnly }: { iconOnly: boolean }) {
  const [open, setOpen] = useState(false);
  const size = useTableSize();
  const align = String(useSettings().values[ALIGN] ?? 'center');
  const fit = useSettings().values[FIT] === true;
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const commit = (key: string) => {
    const value = size[field(key)];
    void saveUserSetting(key, value).finally(() => publish({ ...live, [field(key)]: undefined }));
  };
  const slider = (key: string, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-14">{label}</span>
      <input
        type="range"
        className="w-36"
        min={50}
        max={100}
        step={5}
        value={size[field(key)]}
        aria-label={label}
        onChange={(e) => publish({ ...live, [field(key)]: Number(e.target.value) })}
        onPointerUp={() => commit(key)}
        onKeyUp={() => commit(key)}
      />
      <span className="w-10 text-right font-mono">{size[field(key)]} %</span>
    </label>
  );
  return (
    <span ref={box} className="relative">
      <Button className={iconOnly ? 'px-2' : ''} aria-haspopup="dialog" aria-expanded={open} title={t('table.size')} aria-label={t('table.size')} onClick={() => setOpen((v) => !v)}>
        📐{iconOnly ? '' : ` ${t('table.size')}`}
      </Button>
      {open && (
        <div role="dialog" aria-label={t('table.size')} className="absolute left-0 top-full z-30 mt-1 flex w-max flex-col gap-2 rounded-md border border-line bg-surface p-3 shadow-lg">
          <p className="max-w-64 text-xs text-muted">{t('table.size.help')}</p>
          {slider(A, t('table.size.area'))}
          <div role="group" aria-label={t('settings.ui.tableAreaAlign.label')} className="flex gap-1">
            {(['left', 'center', 'right'] as const).map((a) => (
              <Button key={a} className={align === a ? 'border-primary bg-raised' : ''} aria-pressed={align === a} onClick={() => void saveUserSetting(ALIGN, a)}>
                {t(`table.size.align.${a}`)}
              </Button>
            ))}
          </div>
          {slider(H, t('table.size.height'))}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={fit} onChange={(e) => void saveUserSetting(FIT, e.target.checked)} />
            {t('table.size.fit')}
          </label>
          <Button
            onClick={() => {
              void saveUserSetting(H, 100);
              void saveUserSetting(A, 100);
              void saveUserSetting(ALIGN, 'center');
              void saveUserSetting(FIT, false);
            }}
          >
            {t('table.size.reset')}
          </Button>
        </div>
      )}
    </span>
  );
}
