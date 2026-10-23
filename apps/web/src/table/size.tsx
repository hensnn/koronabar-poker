import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { t } from '@kb/shared';
import { saveUserSetting, useSettings } from '../settings';
import { Button } from '../ui';

const W = 'ui.tableWidthPercent';
const H = 'ui.tableHeightPercent';

/** Rozpracovaná hodnota při tažení posuvníku (náhled hned, na server se uloží až po puštění). */
let live: { w?: number; h?: number } = {};
const listeners = new Set<() => void>();
const publish = (next: typeof live) => {
  live = next;
  listeners.forEach((l) => l());
};
const field = (key: string): 'w' | 'h' => (key === W ? 'w' : 'h');

/** Šířka a výška čtverce, na kterém je stůl, v procentech dostupného místa (100 = celé okno). */
export function useTableSize(): { w: number; h: number } {
  const values = useSettings().values;
  const l = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => live,
  );
  return { w: l.w ?? Number(values[W] ?? 100), h: l.h ?? Number(values[H] ?? 100) };
}

/** Tlačítko 📐 v liště stolu: otevře malé okno se dvěma posuvníky (šířka a výška plochy se stolem). */
export function TableSizeButton({ iconOnly }: { iconOnly: boolean }) {
  const [open, setOpen] = useState(false);
  const size = useTableSize();
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
          {slider(W, t('table.size.width'))}
          {slider(H, t('table.size.height'))}
          <Button
            onClick={() => {
              void saveUserSetting(W, 100);
              void saveUserSetting(H, 100);
            }}
          >
            {t('table.size.reset')}
          </Button>
        </div>
      )}
    </span>
  );
}
