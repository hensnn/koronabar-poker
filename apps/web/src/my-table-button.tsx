import { useEffect, useRef, useState } from 'react';
import { Link } from './router';
import { t } from '@kb/shared';
import { useKeepInView } from './keep-in-view';
import { useMySeats } from './my-seat';

const btn = 'rounded-md border border-primary bg-primary px-3 py-1 text-on-primary';

/**
 * Tlačítko „Ke stolu“ v hlavičce. Když sedím u jednoho stolu, vede rovnou k němu; u více stolů (cash i turnaj naráz)
 * otevře výběr stolu. Stůl, na kterém už jsem, se v nabídce neukazuje.
 */
export function MyTableButton({ path }: { path: string }) {
  const seats = useMySeats().filter((s) => path !== `/stul/${s.tableId}`);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useKeepInView<HTMLDivElement>(open);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => setOpen(false), [path]);
  if (seats.length === 0) return null;
  const first = seats[0]!;
  if (seats.length === 1) {
    return (
      <Link to={`/stul/${first.tableId}`} className={btn} title={first.name}>
        🪑 {t('nav.myTable')}
      </Link>
    );
  }
  return (
    <div ref={ref} className="relative">
      <button className={btn} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        🪑 {t('nav.myTable')} ({seats.length}) ▾
      </button>
      {open && (
        <div ref={menuRef} role="menu" className="absolute right-0 z-30 mt-1 flex min-w-48 flex-col gap-1 rounded-md border border-line bg-surface p-1">
          {seats.map((s) => (
            <Link key={s.tableId} to={`/stul/${s.tableId}`} role="menuitem" className="rounded-md px-3 py-1 hover:bg-raised">
              {s.name}
              {s.tournamentId ? ` · ${t('nav.myTableTournament')}` : ''}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
