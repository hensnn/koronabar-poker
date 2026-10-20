import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get, patch, post } from '../api';
import { can, useSession } from '../session';
import { CardView } from '../table/CardView';
import { fmtDate, HandReplayBody, signed, tone, type HandDetail } from './hand-replay';
import { ShareHandButton } from './hand-share';
import { Badge, Button, Card, DataTable, Modal, Notice, Select, Spinner, Tabs, Td, TextInput } from '../ui';
import { CategoriesView } from './stats-categories';
import { BarChart, LineChart, MultiLineChart, type Pt, type Series } from './charts';

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

interface Timeline {
  balance: Pt[];
  earnings: Pt[];
  tournaments: { at: number; name: string; net: number; place: number; field: number; cumulative: number }[];
  cash: { day: number; net: number; hands: number; cumulative: number }[];
  xp: Pt[];
  rating: { tournament: Pt[]; cash: Pt[]; visible: boolean };
  activity: { day: number; hands: number }[];
}

const RANGES = [
  { id: '30', days: 30 },
  { id: '90', days: 90 },
  { id: '365', days: 365 },
  { id: 'all', days: 0 },
] as const;

const cumulate = (rows: { at: number; v: number }[]): Pt[] => {
  let c = 0;
  return rows.map((r) => [r.at, (c += r.v)] as Pt);
};

/** Jak se mi daří: zůstatek, výsledky turnajů a cash, XP, rating a aktivita v čase (za zvolené období). */
function Progress() {
  const [tl, setTl] = useState<Timeline | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('90');
  const [error, setError] = useState('');
  useEffect(() => {
    get<Timeline>('/api/stats/timeline')
      .then(setTl)
      .catch((e) => setError(errorText(e)));
  }, []);
  const since = useMemo(() => {
    const r = RANGES.find((x) => x.id === range)!;
    return r.days > 0 ? Date.now() - r.days * 86_400_000 : 0;
  }, [range]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!tl) return <Spinner label={t('app.loading')} />;
  const within = <T,>(rows: T[], at: (r: T) => number): T[] => rows.filter((r) => at(r) >= since);
  const balance = within(tl.balance, (p) => p[0]);
  const bStart = balance[0]?.[1] ?? 0;
  const bEnd = balance[balance.length - 1]?.[1] ?? tl.balance[tl.balance.length - 1]?.[1] ?? 0;
  const tours = within(tl.tournaments, (x) => x.at);
  const earn = within(tl.earnings, (p) => p[0]);
  const earnTotal = earn.reduce((n, p) => n + p[1], 0);
  const earnCum = cumulate(earn.map((p) => ({ at: p[0], v: p[1] })));
  const tourNet = tours.reduce((n, x) => n + x.net, 0);
  const tourCum = cumulate(tours.map((x) => ({ at: x.at, v: x.net })));
  const cash = within(tl.cash, (x) => x.day);
  const cashNet = cash.reduce((n, x) => n + x.net, 0);
  const cashCum = cumulate(cash.map((x) => ({ at: x.day, v: x.net })));
  const xp = within(tl.xp, (p) => p[0]);
  const days = within(tl.activity, (x) => x.day);
  const hands = days.reduce((n, x) => n + x.hands, 0);
  const best = tours.length ? tours.reduce((m, x) => (x.net > m.net ? x : m)) : null;
  const card = (label: string, value: string, tn?: 'success' | 'danger' | 'muted') => (
    <div className="rounded-md border border-line bg-surface p-2">
      <div className="text-xs text-muted">{label}</div>
      <div className={`font-mono text-lg ${tn === 'success' ? 'text-success' : tn === 'danger' ? 'text-danger' : ''}`}>{value}</div>
    </div>
  );
  const empty = tl.balance.length === 0 && tl.tournaments.length === 0 && tl.cash.length === 0;
  return (
    <section className="flex flex-col gap-3" aria-label={t('charts.title')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-lg font-bold">{t('charts.title')}</h2>
        <div role="tablist" className="flex gap-1">
          {RANGES.map((r) => (
            <button key={r.id} role="tab" aria-selected={range === r.id} onClick={() => setRange(r.id)} className={`rounded-md border border-line px-2 py-0.5 text-sm ${range === r.id ? 'bg-primary text-on-primary' : 'bg-surface'}`}>
              {t(`charts.range.${r.id}`)}
            </button>
          ))}
        </div>
      </div>
      {empty && <Notice>{t('charts.empty')}</Notice>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {card(t('charts.earnTotal'), signed(earnTotal), tone(earnTotal))}
        {card(t('charts.tourNet'), signed(tourNet), tone(tourNet))}
        {card(t('charts.cashNet'), signed(cashNet), tone(cashNet))}
        {card(t('charts.balanceNow'), String(bEnd))}
        {card(t('charts.tourPlayed'), String(tours.length))}
        {card(t('charts.handsPlayed'), String(hands))}
        {card(t('charts.bestTour'), best ? `${signed(best.net)} (${best.place}./${best.field})` : '–', best ? tone(best.net) : 'muted')}
        {card(t('charts.xpGained'), signed((xp[xp.length - 1]?.[1] ?? 0) - (xp[0]?.[1] ?? 0)))}
      </div>
      <Card title={t('charts.earn')}>
        <LineChart points={earnCum} label={t('charts.earnHelp')} className="text-success" signed />
      </Card>
      <Card title={t('charts.balance')}>
        <LineChart points={balance} label={t('charts.balanceHelp')} />
        <p className="text-xs text-muted">{t('charts.balanceNote')}</p>
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title={t('charts.tourProfit')}>
          <LineChart points={tourCum} label={t('charts.tourProfitHelp')} className="text-success" signed />
          <BarChart bars={tours.map((x) => ({ x: x.at, v: x.net, tip: `${x.name}: ${signed(x.net)} (${x.place}./${x.field})` }))} label={t('charts.perTournament')} />
        </Card>
        <Card title={t('charts.cashProfit')}>
          <LineChart points={cashCum} label={t('charts.cashProfitHelp')} className="text-accent" signed />
          <BarChart bars={cash.map((x) => ({ x: x.day, v: x.net, tip: `${new Date(x.day).toLocaleDateString('cs-CZ')}: ${signed(x.net)} (${x.hands} ${t('charts.hands')})` }))} label={t('charts.perDay')} />
        </Card>
        <Card title={t('charts.xp')}>
          <LineChart points={xp} label={t('charts.xpHelp')} className="text-secondary" />
        </Card>
        <Card title={t('charts.rating')}>
          {tl.rating.visible ? (
            <div className="flex flex-col gap-2">
              <LineChart points={within(tl.rating.tournament, (p) => p[0])} label={t('charts.ratingTournament')} className="text-primary" />
              <LineChart points={within(tl.rating.cash, (p) => p[0])} label={t('charts.ratingCash')} className="text-accent" />
            </div>
          ) : (
            <p className="text-sm text-muted">{t('charts.ratingHidden')}</p>
          )}
        </Card>
      </div>
      <Card title={t('charts.activity')}>
        <BarChart bars={days.map((x) => ({ x: x.day, v: x.hands, tip: `${new Date(x.day).toLocaleDateString('cs-CZ')}: ${x.hands} ${t('charts.hands')}` }))} label={t('charts.activityHelp')} />
      </Card>
      <p className="text-xs text-muted">{t('charts.note')}</p>
    </section>
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

interface OverviewRow {
  userId: string;
  nickname: string;
  balance: number;
  xp: number;
  level: number;
  rank: { name: string; icon: string; color: string };
  ratingTournament: number | null;
  ratingCash: number | null;
  hands: number;
  tournaments: number;
  tournamentNet: number;
  cashNet: number;
  total: number;
  lastSeenAt: number | null;
}

type SortKey = 'nickname' | 'balance' | 'total' | 'tournamentNet' | 'cashNet' | 'level' | 'ratingTournament' | 'ratingCash' | 'hands' | 'tournaments';

/** Přehled mezi hráči: tabulka všech hráčů (řazení klepnutím na sloupec) a srovnání vývoje vybraných hráčů v čase. */
function PlayersOverview({ meId }: { meId: string }) {
  const [rows, setRows] = useState<OverviewRow[] | null>(null);
  const [error, setError] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'total', dir: -1 });
  const [picked, setPicked] = useState<string[] | null>(null);
  const [metric, setMetric] = useState<'profit' | 'balance' | 'xp'>('profit');
  const [series, setSeries] = useState<Series[]>([]);
  const [range, setRange] = useState<'30' | '90' | '365' | 'all'>('all');
  useEffect(() => {
    get<{ rows: OverviewRow[] }>('/api/stats/overview')
      .then((d) => setRows(d.rows))
      .catch((e) => setError(errorText(e)));
  }, []);
  // výchozí výběr: já a první tři podle celkového výsledku
  const selected = useMemo(() => picked ?? (rows ? [meId, ...rows.filter((r) => r.userId !== meId).slice(0, 3).map((r) => r.userId)].slice(0, 4) : []), [picked, rows, meId]);
  useEffect(() => {
    if (selected.length === 0) return;
    get<{ series: { userId: string; nickname: string; points: Pt[] }[] }>(`/api/stats/compare?users=${selected.join(',')}&metric=${metric}`)
      .then((d) => setSeries(d.series.map((x) => ({ id: x.userId, name: x.nickname, points: x.points }))))
      .catch((e) => setError(errorText(e)));
  }, [selected, metric]);
  const since = useMemo(() => (range === 'all' ? 0 : Date.now() - Number(range) * 86_400_000), [range]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!rows) return <Spinner label={t('app.loading')} />;
  const sorted = [...rows].sort((a, b) => {
    const av = a[sort.key] ?? -Infinity;
    const bv = b[sort.key] ?? -Infinity;
    return (typeof av === 'string' ? av.localeCompare(String(bv), 'cs') : Number(av) - Number(bv)) * sort.dir;
  });
  const head = (key: SortKey, label: string) => (
    <button className="underline decoration-dotted" onClick={() => setSort({ key, dir: sort.key === key ? ((-sort.dir) as 1 | -1) : -1 })} aria-label={label}>
      {label}
      {sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
    </button>
  );
  const toggle = (id: string) => setPicked((cur) => {
    const base = cur ?? selected;
    return base.includes(id) ? base.filter((x) => x !== id) : [...base, id].slice(0, 8);
  });
  const shown = series.map((x) => ({ ...x, points: x.points.filter((p) => p[0] >= since) }));
  return (
    <div className="flex flex-col gap-3">
      <Card title={t('overview.compare')}>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="tablist" className="flex flex-wrap gap-1">
              {(['profit', 'balance', 'xp'] as const).map((m) => (
                <button key={m} role="tab" aria-selected={metric === m} onClick={() => setMetric(m)} className={`rounded-md border border-line px-2 py-0.5 text-sm ${metric === m ? 'bg-primary text-on-primary' : 'bg-surface'}`}>
                  {t(`overview.metric.${m}`)}
                </button>
              ))}
            </div>
            <div role="tablist" className="flex gap-1">
              {(['30', '90', '365', 'all'] as const).map((r) => (
                <button key={r} role="tab" aria-selected={range === r} onClick={() => setRange(r)} className={`rounded-md border border-line px-2 py-0.5 text-sm ${range === r ? 'bg-primary text-on-primary' : 'bg-surface'}`}>
                  {t(`charts.range.${r}`)}
                </button>
              ))}
            </div>
          </div>
          <MultiLineChart series={shown} label={t(`overview.metricHelp.${metric}`)} signed={metric === 'profit'} />
          <p className="text-xs text-muted">{t('overview.pickHint')}</p>
        </div>
      </Card>
      <CategoriesView meId={meId} />
      <DataTable head={[t('overview.compareCol'), head('nickname', t('stats.player')), head('total', t('overview.earn')), head('tournamentNet', t('stats.tournamentNet')), head('cashNet', t('overview.cashNet')), head('balance', t('overview.balance')), head('level', t('overview.level')), head('ratingTournament', t('overview.ratingT')), head('ratingCash', t('overview.ratingC')), head('hands', t('stats.hands')), head('tournaments', t('stats.games'))]}>
        {sorted.map((r) => (
          <tr key={r.userId} className={r.userId === meId ? 'bg-raised' : ''}>
            <Td>
              <input type="checkbox" aria-label={t('overview.compareCol')} checked={selected.includes(r.userId)} onChange={() => toggle(r.userId)} />
            </Td>
            <Td>
              <strong>{r.nickname}</strong> {r.userId === meId && <Badge tone="primary">{t('overview.me')}</Badge>}
            </Td>
            <Td>
              <Badge tone={tone(r.total)}>{signed(r.total)}</Badge>
            </Td>
            <Td className="font-mono">{signed(r.tournamentNet)}</Td>
            <Td className="font-mono">{signed(r.cashNet)}</Td>
            <Td className="font-mono text-muted">{r.balance}</Td>
            <Td className="text-sm">
              <span className="font-mono">{r.level}</span> {r.rank.name}
            </Td>
            <Td className="font-mono">{r.ratingTournament ?? '–'}</Td>
            <Td className="font-mono">{r.ratingCash ?? '–'}</Td>
            <Td className="font-mono">{r.hands}</Td>
            <Td className="font-mono">{r.tournaments}</Td>
          </tr>
        ))}
      </DataTable>
      <p className="text-sm text-muted">{t('overview.note')}</p>
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
  const [tab, setTab] = useState<'mine' | 'players' | 'board' | 'hands' | 'seasons'>('mine');
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
    { id: 'players' as const, label: t('overview.tab') },
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
          <Progress />
        </>
      )}
      {tab === 'players' && me && <PlayersOverview meId={me.user.id} />}
      {tab === 'board' && <Leaderboard season={season} seasons={seasons} />}
      {tab === 'hands' && me && <HandsList me={me.user.id} />}
      {tab === 'seasons' && manage && <SeasonsAdmin seasons={seasons} reload={reload} />}
    </main>
  );
}
