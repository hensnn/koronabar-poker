import { useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { get } from '../api';
import { onSocket } from '../net';
import { navigate } from '../router';
import { useSession } from '../session';
import { Button, DataTable, Modal, Td } from '../ui';

interface Summary {
  userId: string;
  name: string;
  place: number;
  entries: number;
  rebuys: number;
  addons: number;
  spent: number;
  payout: number;
  bounty: number;
  profit: number;
}

const ackKey = (id: string) => `kb.tournamentResult.${id}`;
const seen = (id: string): boolean => {
  try {
    return localStorage.getItem(ackKey(id)) === '1';
  } catch {
    return false;
  }
};

/** Po konci turnaje se u stolu ukáže přehled všech hráčů (umístění, vstupy, rebuy, add-ony, výhra, zisk); po odkliknutí zpět do lobby. */
export function TournamentResultDialog({ tournamentId }: { tournamentId: string }) {
  const { me } = useSession();
  const [rows, setRows] = useState<Summary[] | null>(null);
  const [name, setName] = useState('');
  useEffect(() => {
    if (seen(tournamentId)) return;
    const load = () =>
      get<{ name: string; status: string; summary: Summary[] | null }>(`/api/tournaments/${tournamentId}`)
        .then((v) => {
          if (v.status === 'finished' && v.summary && v.summary.length > 0) {
            setName(v.name);
            setRows(v.summary);
          }
        })
        .catch(() => undefined);
    void load();
    return onSocket<{ id: string }>('tournament:changed', (m) => m.id === tournamentId && void load());
  }, [tournamentId]);
  if (!rows) return null;
  const done = () => {
    try {
      localStorage.setItem(ackKey(tournamentId), '1');
    } catch {
      // bez úložiště se okno ukáže znovu, nic horšího
    }
    setRows(null);
    navigate('/');
  };
  const money = (n: number) => n.toLocaleString('cs-CZ');
  const signed = (n: number) => (n > 0 ? `+${money(n)}` : money(n));
  return (
    <Modal title={t('tournament.finishedTitle', { name })} onClose={done} wide>
      <div className="overflow-x-auto">
        <DataTable head={[t('tournament.placeShort'), t('tournament.player'), t('tournament.resultEntries'), t('tournament.resultRebuys'), t('tournament.resultAddons'), t('tournament.resultSpent'), t('tournament.won'), t('tournament.resultProfit')]}>
          {rows.map((r) => (
            <tr key={r.userId} className={r.userId === me?.user.id ? 'bg-raised font-semibold' : ''}>
              <Td className="font-mono">{r.place}.</Td>
              <Td>{r.name}</Td>
              <Td className="font-mono">{r.entries}</Td>
              <Td className="font-mono">{r.rebuys}</Td>
              <Td className="font-mono">{r.addons}</Td>
              <Td className="font-mono">{money(r.spent)}</Td>
              <Td className="font-mono">{money(r.payout + r.bounty)}</Td>
              <Td className={`font-mono ${r.profit > 0 ? 'text-success' : r.profit < 0 ? 'text-danger' : ''}`}>{signed(r.profit)}</Td>
            </tr>
          ))}
        </DataTable>
      </div>
      <p className="mt-2 text-xs text-muted">{t('tournament.resultNote')}</p>
      <div className="mt-3 flex justify-end">
        <Button onClick={done}>{t('tournament.resultBackToLobby')}</Button>
      </div>
    </Modal>
  );
}
