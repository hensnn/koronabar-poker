import { useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { get } from '../api';
import { Link, navigate } from '../router';
import { useSession } from '../session';
import { useSettings } from '../settings';
import { useMySeat } from '../my-seat';
import { Badge, Button, Card, Notice } from '../ui';
import { PollsPanel } from './polls';
import { useFeatures } from '../features';

interface CashTable {
  id: string;
  name: string;
  seats: number;
  seated: number;
  smallBlind: number;
  bigBlind: number;
  playing: boolean;
}
interface Tour {
  id: string;
  name: string;
  status: 'registering' | 'running' | 'finished' | 'cancelled';
  players: number;
  seats: number;
  buyIn: number;
  fee: number;
  startAt: number | null;
  createdAt: number;
}
interface Row {
  userId: string;
  nickname: string;
  total: number;
  balance: number;
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const tone = (n: number) => (n > 0 ? 'text-success' : n < 0 ? 'text-danger' : 'text-muted');
const WHEN: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' };
const TOP = 8;

/** Hlavní stránka: kde hraju, můj zůstatek, otevřené cash stoly, plánované turnaje a žebříček hráčů. */
export function DashboardPage() {
  const features = useFeatures();
  const { me } = useSession();
  const settings = useSettings();
  const seat = useMySeat();
  const [tables, setTables] = useState<CashTable[] | null>(null);
  const [tours, setTours] = useState<Tour[] | null>(null);
  const [rows, setRows] = useState<Row[] | null | 'hidden'>(null);
  const symbol = String(settings.values['economy.currencySymbol'] ?? '');

  useEffect(() => {
    let alive = true;
    const load = () => {
      get<{ tables: CashTable[] }>('/api/lobby')
        .then((d) => alive && setTables(d.tables))
        .catch(() => undefined);
      get<{ tournaments: Tour[] }>('/api/tournaments')
        .then((d) => alive && setTours(d.tournaments))
        .catch(() => undefined);
    };
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const load = () =>
      get<{ rows: Row[] }>('/api/stats/overview')
        .then((d) => alive && setRows(d.rows))
        .catch(() => alive && setRows('hidden'));
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const upcoming = (tours ?? [])
    .filter((x) => x.status === 'registering' || x.status === 'running')
    .sort((a, b) => (a.status === b.status ? (a.startAt ?? a.createdAt) - (b.startAt ?? b.createdAt) : a.status === 'running' ? -1 : 1))
    .slice(0, 6);
  const board = Array.isArray(rows) ? rows : [];
  const myIndex = board.findIndex((r) => r.userId === me?.user.id);
  const mine = myIndex >= 0 ? board[myIndex] : undefined;
  const shown = board.slice(0, TOP);
  const meOutside = mine && myIndex >= TOP;

  return (
    <div className="flex flex-col gap-3">
      <h1 className="sr-only">{t('nav.lobby')}</h1>
      {features.polls && <PollsPanel />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card title={t('dashboard.account')}>
          <div className="flex flex-col gap-2">
            <p className="font-mono text-3xl font-bold">
              {me?.balance ?? 0} {symbol}
            </p>
            <p className="text-sm text-muted">{t('dashboard.balance')}</p>
            {mine && (
              <p>
                {t('dashboard.earnings')}: <strong className={`font-mono ${tone(mine.total)}`}>{signed(mine.total)}</strong>
                <span className="text-muted"> · {t('dashboard.place', { n: myIndex + 1 })}</span>
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Link to="/penezenka" className="underline">
                {t('nav.wallet')}
              </Link>
              <Link to="/statistiky" className="underline">
                {t('nav.stats')}
              </Link>
            </div>
          </div>
        </Card>
        <Card title={t('dashboard.playingNow')}>
          {seat ? (
            <div className="flex flex-col gap-2">
              <p>{seat.name}</p>
              <Button variant="primary" onClick={() => navigate(`/stul/${seat.tableId}`)}>
                {t('nav.myTable')}
              </Button>
            </div>
          ) : (
            <p className="text-muted">{t('dashboard.notSeated')}</p>
          )}
        </Card>
      </div>

      <Card
        title={t('dashboard.cash')}
        actions={
          <Link to="/cash" className="underline">
            {t('dashboard.allCash')}
          </Link>
        }
      >
        {tables === null ? (
          <p className="text-muted">{t('app.loading')}</p>
        ) : tables.length === 0 ? (
          <p className="text-muted">{t('lobby.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {tables.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-1">
                <strong>{x.name}</strong>
                <span className="font-mono text-sm">
                  {x.smallBlind}/{x.bigBlind}
                </span>
                <Badge tone="primary">
                  {x.seated}/{x.seats}
                </Badge>
                {x.playing && <Badge tone="success">{t('lobby.playing')}</Badge>}
                <span className="ml-auto">
                  <Button onClick={() => navigate(`/stul/${x.id}`)}>{x.seated < x.seats ? t('lobby.join') : t('lobby.watch')}</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={t('dashboard.tournaments')}
        actions={
          <Link to="/turnaje" className="underline">
            {t('dashboard.allTournaments')}
          </Link>
        }
      >
        {tours === null ? (
          <p className="text-muted">{t('app.loading')}</p>
        ) : upcoming.length === 0 ? (
          <p className="text-muted">{t('dashboard.noTournaments')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {upcoming.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-1">
                <strong>{x.name}</strong>
                {x.status === 'running' ? <Badge tone="success">{t('dashboard.running')}</Badge> : <Badge>{x.startAt ? new Date(x.startAt).toLocaleString('cs-CZ', WHEN) : t('dashboard.registering')}</Badge>}
                <span className="text-sm text-muted">
                  {x.players} {t('lobby.players')} · {t('lobby.buyIn')} {x.buyIn}
                  {x.fee > 0 ? `+${x.fee}` : ''}
                </span>
                <span className="ml-auto">
                  <Button onClick={() => navigate(`/turnaj/${x.id}`)}>{x.status === 'registering' ? t('dashboard.signUp') : t('dashboard.open')}</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={t('dashboard.leaderboard')}
        actions={
          <Link to="/statistiky" className="underline">
            {t('dashboard.fullStats')}
          </Link>
        }
      >
        {rows === 'hidden' ? (
          <Notice>{t('dashboard.statsHidden')}</Notice>
        ) : rows === null ? (
          <p className="text-muted">{t('app.loading')}</p>
        ) : shown.length === 0 ? (
          <p className="text-muted">{t('dashboard.noPlayers')}</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {shown.map((r, i) => (
              <Entry key={r.userId} place={i + 1} row={r} me={r.userId === me?.user.id} />
            ))}
            {meOutside && mine && <Entry place={myIndex + 1} row={mine} me />}
          </ol>
        )}
        <p className="mt-2 text-xs text-muted">{t('dashboard.earningsHelp')}</p>
      </Card>
    </div>
  );
}

function Entry({ place, row, me }: { place: number; row: Row; me: boolean }) {
  return (
    <li className={`flex items-center gap-3 rounded-md border px-3 py-1 ${me ? 'border-primary bg-raised' : 'border-line'}`}>
      <span className="w-6 text-right font-mono text-muted">{place}.</span>
      <strong className="flex-1 truncate">{row.nickname}</strong>
      <span className={`font-mono ${tone(row.total)}`}>{signed(row.total)}</span>
    </li>
  );
}
