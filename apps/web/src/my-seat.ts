import { useEffect, useState } from 'react';
import { get } from './api';
import { onSocket } from './net';

export interface MySeat {
  tableId: string;
  name: string;
  tournamentId: string | null;
}

/** Kde právě sedím (cash stůl nebo turnajový stůl): pro tlačítko „Ke stolu“ v nabídce. Obnovuje se po připojení a každých 20 s. */
export function useMySeat(): MySeat | null {
  const [seat, setSeat] = useState<MySeat | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      get<{ seat: MySeat | null }>('/api/me/seat')
        .then((d) => alive && setSeat(d.seat))
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
  return seat;
}
