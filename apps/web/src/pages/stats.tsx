import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get, patch, post } from '../api';
import { can, useSession } from '../session';
import { CardView } from '../table/CardView';
import { fmtDate, HandReplayBody, signed, tone, type HandDetail } from './hand-replay';
import { ShareHandButton } from './hand-share';
import { Badge, Button, Card, DataTable, Modal, Notice, Select, Spinner, Tabs, Td, TextInput } from '../ui';

interface Season {
  id: string;
  name: string;
  startsAt: number;
  endsAt: number | null;
}
interface PlayerStats {
  hands: number;
  vpip: number;
  pfr: number;
  threeBet: number;
  wtsd: number;
  wsd: number;
  aggressionFactor: number | null;
  cashNet: number;
  biggestPot: number;
  bestHand: { key: string } | null;
  tournaments: { games: number; wins: number; itm: number; avgPlace: number | null; net: number; bounty: number; rebuys: number };
}
interface LeaderRow {
  userId: string;
  nickname: string;
  cashHands: number;
  cashNet: number;
  games: number;
  wins: number;
  itm: number;
  avgPlace: number | null;
  rebuys: number;
  bounty: number;
  tournamentNet: number;
  total: number;
}
interface HandRow {
  id: string;
  playedAt: number;
  kind: string;
  handNumber: number;
  board: string[];
  hole: [string, string] | null;
  net: number;
  pot: number;
  chipsPerUnit: number;
  blinds: { sb: number; bb: number; ante: number };
  showdown: boolean;
}


function SeasonSelect({ value, onChange, seasons }: { value: string; onChange: (v: string) => void; seasons: Season[] }) {
  return (
    <Select label={t('stats.season')} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="all">{t('stats.seasonAll')}</option>
      <option value="current">{t('stats.seasonCurrent')}</option>
      {seasons.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </Select>
  );
}

/** Průběh zůstatku: součet pohybů v peněžence v čase, jako jednoduchý graf (barva z tokenů přes currentColor). */
function BalanceChart() {
  const [points, setPoints] = useState<number[]>([]);
  useEffect(() => {
    get<{ amount: number }[]>('/api/wallet/history')
      .then((rows) => {
        let sum = 0;
        setPoints([0, ...[...rows].reverse().map((r) => (sum += r.amount))]);
      })
      .catch(() => undefined);
  }, []);
  if (points.length < 3) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points.map((p, i) => `${(i / (points.length - 1)) * 300},${58 - ((p - min) / span) * 56}`).join(' ');
  return (
    <figure className="text-primary">
      <svg viewBox="0 0 300 60" className="h-24 w-full" role="img" aria-label={t('stats.balanceChart')}>
        <polyline points={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="text-sm text-muted">{t('stats.balanceChart')}</figcaption>
    </figure>
  );
}

function StatsView({ userId, season }: { userId: string; season: string }) {
  const [s, setS] = useState<PlayerStats | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setS(null);
    get<PlayerStats>(`/api/stats/player/${userId}?season=${encodeURIComponent(season)}`)
      .then(setS)
      .catch((e) => setError(errorText(e)));
  }, [userId, season]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!s) return <Spinner label={t('app.loading')} />;
  const cell = (label: string, value: string | number, help?: string) => (
    <div className="rounded-md border border-line bg-surface p-2" title={help}>
      <div className="text-xs text-muted">{label}</div>
      <div className="font-mono text-lg">{value}</div>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      {s.hands === 0 && s.tournaments.games === 0 && <Notice>{t('stats.empty')}</Notice>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cell(t('stats.hands'), s.hands)}
        {cell('VPIP', `${s.vpip} %`, t('stats.help.vpip'))}
        {cell('PFR', `${s.pfr} %`, t('stats.help.pfr'))}
        {cell('3-bet', `${s.threeBet} %`, t('stats.help.threeBet'))}
        {cell('WTSD', `${s.wtsd} %`, t('stats.help.wtsd'))}
        {cell('W$SD', `${s.wsd} %`, t('stats.help.wsd'))}
        {cell(t('stats.aggression'), s.aggressionFactor ?? '–', t('stats.help.aggression'))}
        {cell(t('stats.biggestPot'), s.biggestPot)}
        {cell(t('stats.cashNet'), signed(s.cashNet))}
        {cell(t('stats.bestHand'), s.bestHand ? t(`stats.${s.bestHand.key}` as never) : '–')}
      </div>
      <Card title={t('stats.tournaments')}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {cell(t('stats.games'), s.tournaments.games)}
          {cell(t('stats.wins'), s.tournaments.wins)}
          {cell(t('stats.itm'), s.tournaments.games > 0 ? `${Math.round((s.tournaments.itm / s.tournaments.games) * 100)} %` : '–')}
          {cell(t('stats.avgPlace'), s.tournaments.avgPlace ?? '–')}
          {cell(t('stats.rebuys'), s.tournaments.rebuys)}
          {cell(t('stats.bounty'), s.tournaments.bounty)}
          {cell(t('stats.tournamentNet'), signed(s.tournaments.net))}
        </div>
      </Card>
    </div>
  );
}

function Leaderboard({ season, seasons }: { season: string; seasons: Season[] }) {
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<LeaderRow | null>(null);
  useEffect(() => {
    setRows(null);
    get<{ rows: LeaderRow[] }>(`/api/stats/leaderboard?season=${encodeURIComponent(season)}`)
      .then((d) => setRows(d.rows))
      .catch((e) => setError(errorText(e)));
  }, [season]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!rows) return <Spinner label={t('app.loading')} />;
  if (rows.length === 0) return <Notice>{t('stats.leaderboardEmpty')}</Notice>;
  return (
    <>
      <DataTable head={['#', t('stats.player'), t('stats.cashNet'), t('stats.hands'), t('stats.tournamentNet'), t('stats.games'), t('stats.wins'), t('stats.itm'), t('stats.avgPlace'), t('stats.total')]}>
        {rows.map((r, i) => (
          <tr key={r.userId}>
            <Td>{i + 1}</Td>
            <Td>
              <button className="underline" onClick={() => setOpen(r)}>
                {r.nickname}
              </button>
            </Td>
            <Td className="font-mono">{signed(r.cashNet)}</Td>
            <Td className="font-mono">{r.cashHands}</Td>
            <Td className="font-mono">{signed(r.tournamentNet)}</Td>
            <Td className="font-mono">{r.games}</Td>
            <Td className="font-mono">{r.wins}</Td>
            <Td className="font-mono">{r.itm}</Td>
            <Td className="font-mono">{r.avgPlace ?? '–'}</Td>
            <Td>
              <Badge tone={tone(r.total)}>{signed(r.total)}</Badge>
            </Td>
          </tr>
        ))}
      </DataTable>
      <p className="text-sm text-muted">{t('stats.leaderboardHint', { season: season === 'all' ? t('stats.seasonAll') : (seasons.find((s) => s.id === season)?.name ?? t('stats.seasonCurrent')) })}</p>
      {open && (
        <Modal title={open.nickname} onClose={() => setOpen(null)}>
          <StatsView userId={open.userId} season={season} />
        </Modal>
      )}
    </>
  );
}

function Replay({ id, me, onClose }: { id: string; me: string; onClose: () => void }) {
  const [d, setD] = useState<HandDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    get<HandDetail>(`/api/stats/hands/${id}`)
      .then(setD)
      .catch((e) => setError(errorText(e)));
  }, [id]);
  return (
    <Modal title={d ? t('stats.handTitle', { n: d.handNumber, date: fmtDate(d.playedAt) }) : t('stats.hand')} onClose={onClose}>
      {error && <Notice kind="error">{error}</Notice>}
      {!d && !error && <Spinner label={t('app.loading')} />}
      {d && (
        <div className="flex flex-col gap-3">
          <HandReplayBody d={d} me={me} />
          <div>
            <ShareHandButton handId={d.id} />
          </div>
        </div>
      )}
    </Modal>
  );
}

function HandsList({ me }: { me: string }) {
  const [rows, setRows] = useState<HandRow[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(
    (before?: number) => {
      get<{ hands: HandRow[] }>(`/api/stats/hands?limit=30${before ? `&before=${before}` : ''}`)
        .then((d) => {
          setRows((cur) => (before ? [...cur, ...d.hands] : d.hands));
          setDone(d.hands.length < 30);
        })
        .catch((e) => setError(errorText(e)));
    },
    [],
  );
  useEffect(() => load(), [load]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (rows.length === 0) return <Notice>{done ? t('stats.noHands') : t('app.loading')}</Notice>;
  return (
    <>
      <DataTable head={[t('stats.when'), t('stats.type'), t('stats.cards'), t('stats.board'), t('stats.result'), '']}>
        {rows.map((h) => {
          const net = h.chipsPerUnit > 1 ? Math.round(h.net / h.chipsPerUnit) : h.net;
          return (
            <tr key={h.id}>
              <Td>{fmtDate(h.playedAt)}</Td>
              <Td>{h.kind === 'cash' ? t('stats.cash') : t('stats.tournament')}</Td>
              <Td>
                <span className="inline-flex gap-1">{h.hole?.map((c) => <CardView key={c} card={c} small />)}</span>
              </Td>
              <Td>
                <span className="inline-flex gap-1">{h.board.map((c) => <CardView key={c} card={c} small />)}</span>
              </Td>
              <Td>
                <Badge tone={tone(net)}>{signed(net)}</Badge>
              </Td>
              <Td>
                <Button onClick={() => setOpen(h.id)}>{t('stats.replay')}</Button>
              </Td>
            </tr>
          );
        })}
      </DataTable>
      {!done && <Button onClick={() => load(rows[rows.length - 1]!.playedAt)}>{t('stats.more')}</Button>}
      {open && <Replay id={open} me={me} onClose={() => setOpen(null)} />}
    </>
  );
}

const dayInput = (ts: number | null) => (ts ? new Date(ts).toISOString().slice(0, 10) : '');

function SeasonsAdmin({ seasons, reload }: { seasons: Season[]; reload: () => void }) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState(dayInput(Date.now()));
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {error && <Notice kind="error">{error}</Notice>}
      <Card title={t('stats.newSeason')}>
        <div className="grid gap-2 sm:grid-cols-3">
          <TextInput label={t('stats.seasonName')} value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label={t('stats.seasonStart')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <div className="flex items-end">
            <Button variant="primary" disabled={!name.trim() || !from} onClick={() => run(async () => { await post('/api/stats/seasons', { name, startsAt: new Date(from).getTime() }); setName(''); })}>
              {t('stats.createSeason')}
            </Button>
          </div>
        </div>
      </Card>
      <DataTable head={[t('stats.seasonName'), t('stats.seasonStart'), t('stats.seasonEnd'), '']}>
        {seasons.map((s) => (
          <tr key={s.id}>
            <Td>{s.name}</Td>
            <Td>{dayInput(s.startsAt)}</Td>
            <Td>{s.endsAt ? dayInput(s.endsAt) : t('stats.running')}</Td>
            <Td>
              <div className="flex gap-2">
                {!s.endsAt && <Button onClick={() => run(() => patch(`/api/stats/seasons/${s.id}`, { endsAt: Date.now() }))}>{t('stats.endSeason')}</Button>}
                <Button variant="danger" onClick={() => run(() => del(`/api/stats/seasons/${s.id}`))}>
                  {t('stats.deleteSeason')}
                </Button>
              </div>
            </Td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

export function StatsPage() {
  const { me } = useSession();
  const [tab, setTab] = useState<'mine' | 'board' | 'hands' | 'seasons'>('mine');
  const [season, setSeason] = useState('all');
  const [seasons, setSeasons] = useState<Season[]>([]);
  const manage = can(me, 'statistiky.sezony');
  const reload = useCallback(() => {
    get<{ seasons: Season[] }>('/api/stats/seasons')
      .then((d) => setSeasons(d.seasons))
      .catch(() => undefined);
  }, []);
  useEffect(reload, [reload]);
  const tabs = [
    { id: 'mine' as const, label: t('stats.tabMine') },
    { id: 'board' as const, label: t('stats.tabBoard') },
    { id: 'hands' as const, label: t('stats.tabHands') },
    ...(manage ? [{ id: 'seasons' as const, label: t('stats.tabSeasons') }] : []),
  ];
  return (
    <main className="flex flex-col gap-3">
      <h1 className="font-heading text-xl font-bold">{t('stats.title')}</h1>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {(tab === 'mine' || tab === 'board') && <SeasonSelect value={season} onChange={setSeason} seasons={seasons} />}
      {tab === 'mine' && me && (
        <>
          <StatsView userId={me.user.id} season={season} />
          <BalanceChart />
        </>
      )}
      {tab === 'board' && <Leaderboard season={season} seasons={seasons} />}
      {tab === 'hands' && me && <HandsList me={me.user.id} />}
      {tab === 'seasons' && manage && <SeasonsAdmin seasons={seasons} reload={reload} />}
    </main>
  );
}
