import { useEffect } from 'react';
import { get } from './api';
import { onSocket } from './net';
import { navigate } from './router';
import { useSettings } from './settings';

interface Notice {
  kind: string;
  link: string | null;
}

/** Po startu turnaje, do kterého jsem přihlášený, mě aplikace sama posadí: přejde na stránku mého stolu (volba `ui.autoJoinTournament`). */
export function useTournamentAutoJoin(): void {
  const on = useSettings().values['ui.autoJoinTournament'] !== false;
  useEffect(() => {
    if (!on) return;
    return onSocket<Notice>('notification', (n) => {
      const m = n.kind === 'started' && n.link ? /^\/turnaj\/([^/]+)$/.exec(n.link) : null;
      if (!m) return;
      get<{ me: { tableId: string | null; status: string | null } }>(`/api/tournaments/${m[1]}`)
        .then((v) => {
          if (v.me.status === 'playing' && v.me.tableId) navigate(`/stul/${v.me.tableId}`);
        })
        .catch(() => undefined);
    });
  }, [on]);
}
