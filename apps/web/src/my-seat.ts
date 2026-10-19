import { useEffect, useState } from 'react';
import { get } from './api';
import { onSocket } from './net';

export interface MySeat {
  tableId: string;
  name: string;
  tournamentId: string | null;
}

/** Kde právě sedím (všechny cash i turnajové stoly): pro tlačítko „Ke stolu“ v nabídce. Obnovuje se po připojení a každých 20 s. */
export function useMySeats(): MySeat[] {
  const [seats, setSeats] = useState<MySeat[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      get<{ seat: MySeat | null; seats?: MySeat[] }>('/api/me/seat')
        .then((d) => alive && setSeats(d.seats ?? (d.seat ? [d.seat] : [])))
        .catch(() => undefined);
    void load();
    const off = onSocket('hello', load);
    const timer = setInterval(load, 20_000);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
  }, []);
  return seats;
}

/** První stůl, u kterého sedím (pro místa, kde se ukazuje jen jeden). */
export function useMySeat(): MySeat | null {
  return useMySeats()[0] ?? null;
}
