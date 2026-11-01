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
  /** Odměny na hlavu: získané za vyřazení a ztracené (vypsané a vyplacené jinému). */
  headEarned?: number;
  headLost?: number;
  betNet?: number;
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
  const hasHead = summary.some((x) => (x.headEarned ?? 0) > 0 || (x.headLost ?? 0) > 0);
  const hasBets = summary.some((x) => (x.betNet ?? 0) !== 0);
  return (
    <div className="overflow-x-auto">
      <DataTable head={[t('tournament.placeShort'), t('tournament.player'), t('tournament.resultEntries'), t('tournament.resultRebuys'), t('tournament.resultAddons'), t('tournament.resultSpent'), t('tournament.won'), t('tournament.resultBounty'), ...(hasHead ? [t('tournament.resultHead')] : []), ...(hasBets ? [t('tournament.resultBets')] : []), t('tournament.resultProfit')]}>
        {summary.map((x) => (
          <tr key={x.userId} className={x.userId === meId ? 'bg-raised font-semibold' : ''}>
            <Td className="whitespace-nowrap font-mono">{x.place}.</Td>
            <Td className="whitespace-nowrap">{x.name}</Td>
            <Td className="whitespace-nowrap font-mono">{part(x.entries, x.entryAmount)}</Td>
            <Td className="whitespace-nowrap font-mono">{part(x.rebuys, x.rebuyAmount)}</Td>
            <Td className="whitespace-nowrap font-mono">{part(x.addons, x.addonAmount)}</Td>
            <Td className="whitespace-nowrap font-mono">-{money(x.spent)}</Td>
            <Td className="whitespace-nowrap font-mono">{money(x.payout)}</Td>
            <Td className="whitespace-nowrap font-mono">{x.bounty > 0 ? money(x.bounty) : '–'}</Td>
            {hasHead && (
              <Td className="whitespace-nowrap font-mono">
                {(x.headEarned ?? 0) > 0 && <span className="text-success">+{money(x.headEarned!)}</span>}
                {(x.headEarned ?? 0) > 0 && (x.headLost ?? 0) > 0 && ' '}
                {(x.headLost ?? 0) > 0 && <span className="text-danger">-{money(x.headLost!)}</span>}
                {!(x.headEarned ?? 0) && !(x.headLost ?? 0) && '–'}
              </Td>
            )}
            {hasBets && <Td className={`whitespace-nowrap font-mono ${(x.betNet ?? 0) > 0 ? 'text-success' : (x.betNet ?? 0) < 0 ? 'text-danger' : ''}`}>{(x.betNet ?? 0) !== 0 ? signed(x.betNet!) : '–'}</Td>}
            <Td className={`whitespace-nowrap font-mono ${x.profit > 0 ? 'text-success' : x.profit < 0 ? 'text-danger' : ''}`}>{signed(x.profit)}</Td>
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
    <Modal title={t('tournament.finishedTitle', { name: r.name })} onClose={done} wide fit>
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

export interface BustSummary extends TournamentSummary {
  /** Výhra za umístění se vyplatí až po konci turnaje. */
  payoutPending: boolean;
}

const bustKey = (id: string) => `kb.bustSummary.${id}`;
const bustSeen = (id: string): boolean => {
  try {
    return sessionStorage.getItem(bustKey(id)) === '1';
  } catch {
    return false;
  }
};

/**
 * Souhrn vyřazeného hráče za běhu turnaje: načte ho ze serveru a po vypadnutí ho jednou sám otevře.
 * Znovu ho vyvolá tlačítko (`open`), dokud turnaj běží.
 */
export function useBustSummary(tournamentId: string): { summary: BustSummary | null; name: string; open: boolean; setOpen: (v: boolean) => void } {
  const [summary, setSummary] = useState<BustSummary | null>(null);
  const [name, setName] = useState('');
  const [open, setOpenState] = useState(false);
  useEffect(() => {
    if (!tournamentId) return;
    const load = () =>
      get<{ name: string; me: { bustSummary?: BustSummary | null } }>(`/api/tournaments/${tournamentId}`)
        .then((v) => {
          const b = v.me.bustSummary ?? null;
          setSummary(b);
          setName(v.name);
          if (b && !bustSeen(tournamentId)) {
            try {
              sessionStorage.setItem(bustKey(tournamentId), '1');
            } catch {
              // bez úložiště se okno ukáže po obnovení znovu, nic horšího
            }
            setOpenState(true);
          }
          if (!b) setOpenState(false);
        })
        .catch(() => undefined);
    void load();
    return onSocket<{ id: string }>('tournament:changed', (m) => m.id === tournamentId && void load());
  }, [tournamentId]);
  return { summary, name, open, setOpen: setOpenState };
}

/** Tlačítko „Můj souhrn“ a okno se souhrnem vyřazeného hráče (jen dokud turnaj běží a hráč už vypadl). */
export function BustSummaryButton({ tournamentId }: { tournamentId: string }) {
  const { summary, name, open, setOpen } = useBustSummary(tournamentId);
  if (!summary) return null;
  const row = (label: string, value: string, cls = '') => (
    <div className="flex justify-between gap-6 border-b border-line py-1">
      <dt className="text-muted">{label}</dt>
      <dd className={`font-mono ${cls}`}>{value}</dd>
    </div>
  );
  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)} title={t('tournament.bust.buttonHelp')}>
          {t('tournament.bust.button')}
        </Button>
      </div>
      {open && (
        <Modal title={t('tournament.bust.title', { name })} onClose={() => setOpen(false)}>
          <p className="mb-2 font-semibold">{t('tournament.bust.place', { place: summary.place })}</p>
          <dl className="text-sm">
            {row(t('tournament.resultEntries'), part(summary.entries, summary.entryAmount))}
            {row(t('tournament.resultRebuys'), part(summary.rebuys, summary.rebuyAmount))}
            {row(t('tournament.resultAddons'), part(summary.addons, summary.addonAmount))}
            {row(t('tournament.resultSpent'), `-${money(summary.spent)}`)}
            {row(t('tournament.won'), money(summary.payout))}
            {row(t('tournament.resultBounty'), summary.bounty > 0 ? money(summary.bounty) : '–')}
            {row(t('tournament.resultProfit'), signed(summary.profit), summary.profit > 0 ? 'text-success' : summary.profit < 0 ? 'text-danger' : '')}
          </dl>
          <p className="mt-2 text-xs text-muted">{t('tournament.bust.note')}</p>
          <div className="mt-3 flex justify-end">
            <Button onClick={() => setOpen(false)}>{t('tournament.bust.close')}</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

interface ClaimedBounty {
  tournamentId: string;
  target: string;
  amount: number;
  paid: { userId: string; nickname: string; amount: number }[];
}

/** Zadavateli odměny na hlavu se kdekoli v aplikaci výrazně ukáže, že se jeho odměna uplatnila (kdo ji dostal a za koho). */
export function HeadBountyClaimedHost() {
  const [queue, setQueue] = useState<ClaimedBounty[]>([]);
  useEffect(() => onSocket<ClaimedBounty>('bounty:claimed', (c) => setQueue((q) => [...q, c])), []);
  const c = queue[0];
  if (!c) return null;
  const close = () => setQueue((q) => q.slice(1));
  return (
    <div role="alert" className="fixed inset-x-0 top-3 z-[90] mx-auto w-[min(34rem,calc(100%-2rem))] rounded-lg border-2 border-accent bg-surface p-4 shadow-xl">
      <p className="text-lg font-bold">🎯 {t('headBounty.claimed.title')}</p>
      <p className="mt-1">{t('headBounty.claimed.text', { target: c.target, amount: money(c.amount), winners: c.paid.map((x) => x.nickname).join(', ') })}</p>
      <div className="mt-3 flex justify-end">
        <Button variant="primary" onClick={close}>
          {t('headBounty.claimed.close')}
        </Button>
      </div>
    </div>
  );
}
