import { useMemo, useState } from 'react';
import { t } from '@kb/shared';
import { CardView } from '../table/CardView';
import { Badge, Button, DataTable, Notice, Td } from '../ui';

export interface HandDetail {
  id: string;
  kind: string;
  handNumber: number;
  playedAt: number;
  buttonSeat: number | null;
  board: string[];
  pot: number;
  rake: number;
  showdown: boolean;
  purged: boolean;
  runs: number;
  /** Boardy a vítězové jednotlivých běhů (run it twice); starší handy je nemají. */
  runBoards?: { board: string[]; winners: { userId: string; nickname: string; amount: number; handKey: string | null }[] }[] | null;
  chipsPerUnit: number;
  blinds: { sb: number; bb: number; ante: number };
  actions: { userId: string; street: string; action: string; amount: number; facing: number }[];
  players: { userId: string; nickname: string; seat: number; startStack: number; invested: number; won: number; net: number; hole: [string, string] | null; handKey: string | null }[];
}

export const fmtDate = (ts: number) => new Date(ts).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' });
export const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
export const tone = (n: number): 'success' | 'danger' | 'muted' => (n > 0 ? 'success' : n < 0 ? 'danger' : 'muted');
const STREET_CARDS: Record<string, number> = { PREFLOP: 0, FLOP: 3, TURN: 4, RIVER: 5, SHOWDOWN: 5 };

/** Karty, které jsou ve všech během stejné (už ležely na stole při all-inu); ostatní se mezi běhy liší. */
export function sharedCardCount(boards: string[][]): number {
  const first = boards[0] ?? [];
  let n = 0;
  while (n < first.length && boards.every((b) => b[n] === first[n])) n++;
  return n;
}

/** Run it twice / třikrát: celý board každého běhu (karty dolosované jen pro daný běh jsou orámované) a kdo běh vyhrál. */
export function RunsView({ d, unit }: { d: HandDetail; unit: (n: number) => number }) {
  if (d.runs < 2) return null;
  const runs = d.runBoards ?? [];
  if (runs.length < 2) return <Notice>{t('stats.runsMissing', { n: d.runs })}</Notice>;
  const shared = sharedCardCount(runs.map((r) => r.board));
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-2" aria-label={t('stats.runsTitle', { n: runs.length })}>
      <span className="text-sm font-semibold">{t('stats.runsTitle', { n: runs.length })}</span>
      {runs.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="w-12 text-xs text-muted">{t('stats.run', { n: i + 1 })}</span>
          <div className="flex gap-1">
            {r.board.map((c, j) => (
              <CardView key={`${j}${c}`} card={c} small still mark={j >= shared} />
            ))}
          </div>
          <span className="text-sm">
            {r.winners.length === 0 ? (
              <span className="text-muted">{t('stats.runNoWinner')}</span>
            ) : (
              r.winners.map((w, k) => (
                <span key={w.userId}>
                  {k > 0 && ', '}
                  <strong>{w.nickname}</strong> <span className="font-mono text-success">+{unit(w.amount)}</span>
                  {w.handKey && <span className="text-xs text-muted"> ({t(`stats.${w.handKey}`)})</span>}
                </span>
              ))
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Přehrávač handy po akcích; cizí karty se ukážou jen, když je server poslal. */
export function HandReplayBody({ d, me }: { d: HandDetail; me: string }) {
  // Přehrávač začíná na konci handy: hned je vidět celý stůl (flop, turn, river) a všechny akce; tlačítkem Zpět se jde po akcích zpátky.
  const [step, setStep] = useState(d.actions.length);
  const name = useMemo(() => new Map(d.players.map((p) => [p.userId, p.nickname])), [d]);
  const unit = (n: number) => (d.chipsPerUnit > 1 ? Math.round((n / d.chipsPerUnit) * 100) / 100 : n);
  return (
    <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('stats.blinds', { sb: unit(d.blinds.sb), bb: unit(d.blinds.bb) })}</p>
        {d.purged && <Notice>{t('stats.purged')}</Notice>}
        {(() => {
          const shown = step === 0 ? 0 : Math.min(STREET_CARDS[d.actions[step - 1]?.street ?? 'PREFLOP'] ?? 0, d.board.length);
          const full = step >= d.actions.length;
          const cards = full ? d.board : d.board.slice(0, shown);
          return (
            <div className="flex flex-wrap items-end gap-4" aria-label={t('stats.board')}>
              {([['flop', [0, 1, 2]], ['turn', [3]], ['river', [4]]] as const).map(([street, idx]) => (
                <div key={street} className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted">{t(`table.log.${street}`)}</span>
                  <div className="flex gap-1">
                    {idx.map((i) => (cards[i] ? <CardView key={i} card={cards[i]!} small /> : <span key={i} className="inline-block h-10 w-7 rounded-sm border border-dashed border-line" />))}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}
        <RunsView d={d} unit={unit} />
        {!d.purged && d.actions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
              {t('stats.prev')}
            </Button>
            <Button onClick={() => setStep(Math.min(d.actions.length, step + 1))} disabled={step >= d.actions.length}>
              {t('stats.next')}
            </Button>
            <span className="text-sm text-muted">
              {step}/{d.actions.length}
            </span>
          </div>
        )}
        <ol className="flex flex-col gap-0.5 text-sm">
          {d.actions.slice(0, step || undefined).map((a, i) => (
            <li key={i} className={i === step - 1 ? 'font-bold' : ''}>
              <span className="text-muted">{t(`stats.street.${a.street}`)}</span> {name.get(a.userId) ?? '?'}: {t(`stats.act.${a.action}`)}
              {a.amount > 0 && a.action !== 'fold' && a.action !== 'check' ? ` ${unit(a.amount)}` : ''}
            </li>
          ))}
        </ol>
        <DataTable head={[t('stats.player'), t('stats.cards'), t('stats.invested'), t('stats.won'), t('stats.result')]}>
          {d.players.map((p) => (
            <tr key={p.userId}>
              <Td>
                {p.nickname}
                {p.userId === me && <span className="text-muted"> ({t('stats.you')})</span>}
                {d.buttonSeat === p.seat && <Badge>D</Badge>}
              </Td>
              <Td>
                <span className="inline-flex gap-1">{p.hole ? p.hole.map((c) => <CardView key={c} card={c} small />) : <span className="text-muted">{t('stats.hidden')}</span>}</span>
                {p.handKey && <div className="text-xs text-muted">{t(`stats.${p.handKey}`)}</div>}
              </Td>
              <Td className="font-mono">{unit(p.invested)}</Td>
              <Td className="font-mono">{unit(p.won)}</Td>
              <Td>
                <Badge tone={tone(p.net)}>{signed(unit(p.net))}</Badge>
              </Td>
            </tr>
          ))}
        </DataTable>
        {d.rake > 0 && <p className="text-sm text-muted">{t('stats.rake', { n: unit(d.rake) })}</p>}
      </div>
  );
}
