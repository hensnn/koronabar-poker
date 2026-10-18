import { useEffect, useRef, useState } from 'react';
import { t } from '@kb/shared';
import { Link } from './router';

export interface MenuItem {
  to: string;
  label: string;
}
export type MenuTone = 'success' | 'info' | 'warning' | 'accent';
export interface MenuGroup {
  id: string;
  label: string;
  tone: MenuTone;
  items: MenuItem[];
}

// Celé názvy tříd musí být v kódu napsané, aby je Tailwind našel; barvy jsou jen design tokeny.
const TONE: Record<MenuTone, { dot: string; active: string; border: string }> = {
  success: { dot: 'bg-success', active: 'border-success', border: 'border-l-success' },
  info: { dot: 'bg-info', active: 'border-info', border: 'border-l-info' },
  warning: { dot: 'bg-warning', active: 'border-warning', border: 'border-l-warning' },
  accent: { dot: 'bg-accent', active: 'border-accent', border: 'border-l-accent' },
};

/** Hlavní nabídka: skupiny s barevným označením, na počítači rozbalovací, na telefonu pod tlačítkem Nabídka. */
export function MainMenu({ groups, isActive, path }: { groups: MenuGroup[]; isActive: (to: string) => boolean; path: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(null), [path]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:items-center md:gap-1">
      {groups.map((g) => {
        const tone = TONE[g.tone];
        const current = g.items.some((i) => isActive(i.to));
        const isOpen = open === g.id;
        return (
          <div key={g.id} className="relative">
            <button
              type="button"
              aria-expanded={isOpen}
              aria-haspopup="true"
              onClick={() => setOpen(isOpen ? null : g.id)}
              className={`flex w-full items-center gap-2 rounded-md border px-3 py-1 md:w-auto ${current ? `${tone.active} bg-raised font-semibold` : 'border-line bg-surface'}`}
            >
              <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${tone.dot}`} />
              {g.label}
              <span aria-hidden="true" className="hidden text-xs md:inline">
                ▾
              </span>
            </button>
            <div role="menu" className={`${isOpen ? 'flex' : 'hidden'} mt-1 flex-col gap-1 md:absolute md:left-0 md:top-full md:z-30 md:min-w-44 md:rounded-md md:border md:border-line md:bg-surface md:p-1`}>
              {g.items.map((i) => (
                <Link
                  key={i.to}
                  to={i.to}
                  aria-current={isActive(i.to) ? 'page' : undefined}
                  className={`rounded-md border-l-4 px-3 py-1 ${tone.border} ${isActive(i.to) ? 'bg-primary text-on-primary' : 'bg-surface hover:bg-raised'}`}
                >
                  {i.label}
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
