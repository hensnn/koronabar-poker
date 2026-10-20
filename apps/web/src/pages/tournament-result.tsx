import { useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { get } from '../api';
import { onSocket } from '../net';
import { navigate } from '../router';
import { useSession } from '../session';
import { Button, DataTable, Modal, Td } from '../ui';

export interface TournamentSummary {
  userId: string;
  name: string;
  place: number;
  entries: number;
  rebuys: number;
  addons: number;
  /** Zaplacené částky včetně poplatků. */
  entryAmount: number;
  rebuyAmount: number;
  addonAmount: number;
  spent: number;
  payout: number;
  bounty: number;
  profit: number;
}
interface Result {
  id: string;
  name: string;
  summary: TournamentSummary[];
}

const ackKey = (id: string) => `kb.tournamentResult.${id}`;
const seen = (id: string): boolean => {
  try {
    return localStorage.getItem(ackKey(id)) === '1';
  } catch {
    return false;
  }
};

// Jedno okno pro celou aplikaci: přijde ze serveru (kdekoli v aplikaci), nebo se dohledá po otevření stolu skončeného turnaje.
let current: Result | null = null;
const listeners = new Set<() => void>();
const publish = (r: Result | null) => {
  current = r;
  listeners.forEach((l) => l());
};
function show(r: Result): void {
  if (seen(r.id) || r.summary.length === 0 || current?.id === r.id) return;
  publish(r);
}

/** Dohledá výsledky turnaje (po otevření jeho stolu, když okno zmeškal): ukáže je, pokud je hráč ještě nepotvrdil. */
const money = (n: number) => n.toLocaleString('cs-CZ');
const signed = (n: number) => (n > 0 ? `+${money(n)}` : money(n));
const part = (count: number, amount: number) => (count > 0 ? `${count}× ${money(amount)}` : '–');

/** Výsledek turnaje s náklady: buy-in, rebuye, add-ony, zaplaceno celkem, výhra, bounty a zisk (výhra + bounty − zaplaceno). */
export function SummaryTable({ summary, meId }: { summary: TournamentSummary[]; meId?: string }) {
  return (
    <div className="overflow-x-auto">
      <DataTable head={[t('tournament.placeShort'), t('tournament.player'), t('tournament.resultEntries'), t('tournament.resultRebuys'), t('tournament.resultAddons'), t('tournament.resultSpent'), t('tournament.won'), t('tournament.resultBounty'), t('tournament.resultProfit')]}>
        {summary.map((x) => (
          <tr key={x.userId} className={x.userId === meId ? 'bg-raised font-semibold' : ''}>
            <Td className="font-mono">{x.place}.</Td>
            <Td>{x.name}</Td>
            <Td className="font-mono">{part(x.entries, x.entryAmount)}</Td>
            <Td className="font-mono">{part(x.rebuys, x.rebuyAmount)}</Td>
            <Td className="font-mono">{part(x.addons, x.addonAmount)}</Td>
            <Td className="font-mono">-{money(x.spent)}</Td>
            <Td className="font-mono">{money(x.payout)}</Td>
            <Td className="font-mono">{x.bounty > 0 ? money(x.bounty) : '–'}</Td>
            <Td className={`font-mono ${x.profit > 0 ? 'text-success' : x.profit < 0 ? 'text-danger' : ''}`}>{signed(x.profit)}</Td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

export function useTournamentResultFallback(tournamentId: string): void {
  useEffect(() => {
    if (!tournamentId || seen(tournamentId)) return;
    const load = () =>
      get<{ name: string; status: string; summary: TournamentSummary[] | null }>(`/api/tournaments/${tournamentId}`)
        .then((v) => v.status === 'finished' && v.summary && show({ id: tournamentId, name: v.name, summary: v.summary }))
        .catch(() => undefined);
    void load();
    return onSocket<{ id: string }>('tournament:changed', (m) => m.id === tournamentId && void load());
  }, [tournamentId]);
}

/** Po konci turnaje se hráči, který se ho účastnil, kdekoli v aplikaci ukáže přehled všech hráčů; po odkliknutí zpět do lobby. */
export function TournamentResultHost() {
  const { me } = useSession();
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    const off = onSocket<Result>('tournament:result', (r) => show(r));
    return () => {
      listeners.delete(l);
      off();
    };
  }, []);
  const r = current;
  if (!r) return null;
  const done = () => {
    try {
      localStorage.setItem(ackKey(r.id), '1');
    } catch {
      // bez úložiště se okno ukáže znovu, nic horšího
    }
    publish(null);
    navigate('/');
  };
  return (
    <Modal title={t('tournament.finishedTitle', { name: r.name })} onClose={done} wide>
      <SummaryTable summary={r.summary} meId={me?.user.id} />
      <p className="mt-2">
        <a className="rounded-md border border-line bg-surface px-3 py-1 text-sm" href={`/api/tournaments/${r.id}/export.csv`}>
          {t('tournament.exportCsv')}
        </a>
      </p>
      <p className="mt-2 text-xs text-muted">{t('tournament.resultNote')}</p>
      <div className="mt-3 flex justify-end">
        <Button onClick={done}>{t('tournament.resultBackToLobby')}</Button>
      </div>
    </Modal>
  );
}
