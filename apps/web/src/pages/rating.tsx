import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../api';
import { can, useSession } from '../session';
import { Badge, Button, Card, DataTable, Modal, Notice, Tabs, Td } from '../ui';

type Scope = 'tournament' | 'cash';
interface Dto {
  scope: Scope;
  rating: number | null;
  uncertainty: number | null;
  provisional: boolean;
  games: number;
  peak: number | null;
  division: string;
}
interface Ev {
  ref: string;
  kind: string;
  at: number;
  before: number | null;
  after: number | null;
  change: number | null;
  placement: number;
  knockouts: { nickname: string; points: number }[];
  knockedOutBy: { nickname: string; points: number }[];
  weight: number;
  rebuyPenalty: boolean;
}
interface Row {
  rank: number;
  userId: string;
  nickname: string;
  rating: number | null;
  division: string;
  games: number;
}

const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
const fmt = (n: number) => sign(Math.round(n * 10) / 10);

function explain(e: Ev): string {
  if (e.kind === 'reset') return t('rating.reset');
  const parts: string[] = [];
  if (e.placement !== 0) parts.push(t('rating.forPlacement', { n: fmt(e.placement) }));
  for (const k of e.knockouts) parts.push(t('rating.forKnockout', { n: fmt(k.points), nick: k.nickname }));
  for (const k of e.knockedOutBy) parts.push(t('rating.knockedBy', { n: fmt(-k.points), nick: k.nickname }));
  if (e.rebuyPenalty) parts.push(t('rating.rebuyNote'));
  if (e.weight < 1) parts.push(t('rating.weightNote', { n: Math.round(e.weight * 100) }));
  return parts.join(', ') || '–';
}

function Chart({ events }: { events: Ev[] }) {
  const pts = [...events].reverse().filter((e) => e.after !== null).map((e) => e.after!);
  if (pts.length < 2) return null;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const path = pts.map((p, i) => `${(i / (pts.length - 1)) * 300},${58 - ((p - min) / span) * 56}`).join(' ');
  return (
    <figure className="text-primary">
      <svg viewBox="0 0 300 60" className="h-24 w-full" role="img" aria-label={t('rating.chart')}>
        <polyline points={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="text-sm text-muted">{t('rating.chart')}</figcaption>
    </figure>
  );
}

function Duel({ row, onClose }: { row: Row; onClose: () => void }) {
  const [d, setD] = useState<{ aKnockedB: number; bKnockedA: number } | null>(null);
  useEffect(() => {
    get<{ aKnockedB: number; bKnockedA: number }>(`/api/rating/duel?a=me&b=${row.userId}`).then(setD).catch(() => setD({ aKnockedB: 0, bKnockedA: 0 }));
  }, [row.userId]);
  return (
    <Modal title={t('rating.duelTitle', { nick: row.nickname })} onClose={onClose}>
      {d ? (
        <p>
          {t('rating.duelYou', { n: d.aKnockedB })} · {t('rating.duelThem', { n: d.bKnockedA })}
        </p>
      ) : null}
    </Modal>
  );
}

export function RatingSection() {
  const { me } = useSession();
  const [info, setInfo] = useState<{ tournament: Dto; cash: Dto } | null>(null);
  const [scope, setScope] = useState<Scope>('tournament');
  const [events, setEvents] = useState<Ev[]>([]);
  const [board, setBoard] = useState<Row[]>([]);
  const [season, setSeason] = useState<{ on: boolean; id: string }>({ on: false, id: 'current' });
  const [seasonData, setSeasonData] = useState<{ season: { id: string; name: string } | null; seasons: { id: string; name: string }[]; rows: (Row & { delta: number | null })[] } | null>(null);
  const [duel, setDuel] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => {
    get<{ tournament: Dto; cash: Dto }>('/api/rating/me').then(setInfo).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    get<{ events: Ev[] }>(`/api/rating/history?scope=${scope}`).then((d) => setEvents(d.events)).catch(() => setEvents([]));
    get<{ rows: Row[] }>(`/api/rating/leaderboard?scope=${scope}`).then((d) => setBoard(d.rows)).catch(() => setBoard([]));
  }, [scope]);
  useEffect(() => {
    if (!season.on) return;
    get<NonNullable<typeof seasonData>>(`/api/rating/season?scope=${scope}&season=${season.id}`).then(setSeasonData).catch(() => setSeasonData(null));
  }, [scope, season]);
  if (error) return null; // rating je vypnutý nebo nedostupný
  if (!info) return null;
  const cur = info[scope];
  return (
    <Card title={t('rating.title')}>
      <div className="flex flex-col gap-3">
        <Tabs tabs={[{ id: 'tournament' as const, label: t('rating.tournament') }, { id: 'cash' as const, label: t('rating.cash') }]} value={scope} onChange={setScope} />
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-col">
            <span className="text-4xl font-bold">{cur.rating ?? cur.division}</span>
            {cur.uncertainty !== null && <span className="text-sm text-muted">± {cur.uncertainty}</span>}
          </div>
          <div className="flex flex-col gap-1">
            <Badge tone="primary">{cur.division}</Badge>
            {cur.provisional && <Badge tone="warning">{t('rating.provisional')}</Badge>}
            <span className="text-sm text-muted">
              {t('rating.games', { n: cur.games })}
              {cur.peak !== null ? ` · ${t('rating.peak', { n: cur.peak })}` : ''}
            </span>
          </div>
        </div>
        <Chart events={events} />
        <section className="flex flex-col gap-2">
          <h3 className="font-bold">{t('rating.history')}</h3>
          {events.length === 0 ? (
            <p className="text-sm text-muted">{t('rating.noHistory')}</p>
          ) : (
            <DataTable head={[t('stats.when'), t('rating.change'), t('rating.why')]}>
              {events.map((e) => (
                <tr key={e.ref + e.at}>
                  <Td>{new Date(e.at).toLocaleDateString('cs-CZ')}</Td>
                  <Td className="font-mono">{e.change === null ? '–' : <Badge tone={e.change > 0 ? 'success' : e.change < 0 ? 'danger' : 'muted'}>{sign(e.change)}</Badge>}</Td>
                  <Td className="text-sm">{explain(e)}</Td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="font-bold">{t('rating.leaderboard')}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={season.on ? 'secondary' : 'primary'} aria-pressed={!season.on} onClick={() => setSeason({ ...season, on: false })}>
              {t('rating.allTimeTab')}
            </Button>
            <Button variant={season.on ? 'primary' : 'secondary'} aria-pressed={season.on} onClick={() => setSeason({ ...season, on: true })}>
              {t('rating.seasonTab')}
            </Button>
            {season.on && seasonData && seasonData.seasons.length > 0 && (
              <select aria-label={t('rating.seasonTab')} className="rounded-sm border border-line bg-surface px-2 py-1" value={season.id === 'current' ? (seasonData.season?.id ?? '') : season.id} onChange={(e) => setSeason({ on: true, id: e.target.value })}>
                {seasonData.seasons.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {season.on ? (
            !seasonData || !seasonData.season ? (
              <p className="text-sm text-muted">{t('rating.seasonNone')}</p>
            ) : seasonData.rows.length === 0 ? (
              <p className="text-sm text-muted">{t('rating.leaderboardEmpty')}</p>
            ) : (
              <DataTable head={['#', t('stats.player'), t('rating.title'), t('rating.seasonDelta'), t('rating.division'), t('rating.gamesShort')]}>
                {seasonData.rows.map((r) => (
                  <tr key={r.userId}>
                    <Td>{r.rank}</Td>
                    <Td>{r.nickname}</Td>
                    <Td className="font-mono">{r.rating ?? '–'}</Td>
                    <Td className="font-mono">{r.delta === null ? '–' : r.delta > 0 ? `+${r.delta}` : r.delta}</Td>
                    <Td>{r.division}</Td>
                    <Td className="font-mono">{r.games}</Td>
                  </tr>
                ))}
              </DataTable>
            )
          ) : board.length === 0 ? (
            <p className="text-sm text-muted">{t('rating.leaderboardEmpty')}</p>
          ) : (
            <DataTable head={['#', t('stats.player'), t('rating.title'), t('rating.division'), t('rating.gamesShort'), '']}>
              {board.map((r) => (
                <tr key={r.userId}>
                  <Td>{r.rank}</Td>
                  <Td>{r.nickname}</Td>
                  <Td className="font-mono">{r.rating ?? '–'}</Td>
                  <Td>{r.division}</Td>
                  <Td className="font-mono">{r.games}</Td>
                  <Td>{r.userId !== me?.user.id && scope === 'tournament' && <Button onClick={() => setDuel(r)}>{t('rating.duel')}</Button>}</Td>
                </tr>
              ))}
            </DataTable>
          )}
        </section>
        {can(me, 'statistiky.sezony') && (
          <div className="flex flex-col gap-2">
            <Button
              onClick={async () => {
                if (!confirm(t('rating.resetConfirm'))) return;
                try {
                  const r = await post<{ players: number }>('/api/rating/reset');
                  setMsg(t('rating.resetDone', { n: r.players }));
                  load();
                } catch (e) {
                  setMsg(errorText(e));
                }
              }}
            >
              {t('rating.resetSeason')}
            </Button>
            {msg && <Notice>{msg}</Notice>}
          </div>
        )}
      </div>
      {duel && <Duel row={duel} onClose={() => setDuel(null)} />}
    </Card>
  );
}
