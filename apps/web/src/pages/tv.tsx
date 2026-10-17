import { useEffect, useMemo, useState } from 'react';
import { t } from '@kb/shared';
import { ThemeProvider } from '../theme/ThemeProvider';
import { CardView } from '../table/CardView';
import { AnnouncerPlayer } from '../announcer/engine';

const TOKEN_KEY = 'kb.tv.token';

interface Level {
  smallBlind: number;
  bigBlind: number;
  ante: number;
}
interface TvTournament {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  onBreak: boolean;
  live: boolean;
  levelNumber: number;
  level: Level | null;
  nextLevel: Level | null;
  clockKind: 'level' | 'break' | null;
  clockMs: number | null;
  levelMode: string;
  handsInLevel: number;
  levelHands: number;
  players: number;
  alive: number;
  avgStack: number | null;
  prizePool: number;
  payouts: { place: number; amount: number }[];
  bubble: boolean;
  standings: { name: string; place: number; chips: number | null; status: string; payout: number | null }[];
  results: { name: string; place: number; payout: number }[] | null;
}
interface TvSeat {
  seat: number;
  name: string;
  stack: number;
  bet: number;
  status: string;
  isDealer: boolean;
  cards: [string, string] | null;
  hasCards: boolean;
}
interface TvTable {
  id: string;
  name: string;
  delay: number;
  ready: boolean;
  view: { handNumber: number; board: string[]; seats: TvSeat[]; totalPot: number; smallBlind: number; bigBlind: number; actingSeat: number | null } | null;
}
interface Row {
  rank: number;
  nickname: string;
  value: number;
}
interface Snapshot {
  serverTime: number;
  device: { id: string; name: string };
  themeId: string | null;
  layout: { screens: { type: string; seconds: number; tableId?: string; tournamentId?: string }[]; fontScalePercent: number; strip: boolean };
  tournaments: TvTournament[];
  tables: Record<string, TvTable | null>;
  boards: { seasonName: string | null; season: Row[]; rating: { rank: number; nickname: string; rating: number | null; division: string }[]; evening: Row[] };
  upcoming: { id: string; name: string; startAt: number; players: number }[];
  polls: { id: string; title: string; endsAt: number }[];
  ticker: { nick: string | null; body: string; at: number }[];
  evening: { id: string; name: string; status: string; mvp: string | null; players: { rank: number; nickname: string; net: number; score: number }[]; awards: { hunter: { nickname: string; count: number } | null; banker: { nickname: string; bb: number } | null; badBeat: { nickname: string; equity: number } | null } } | null;
  jingles?: { id: string; soundId: string; nickname: string; kind: string }[];
  announcer: { enabled: boolean; audio: boolean; ratePercent: number; volumePercent: number; items: { id: string; text: string }[] };
}

const playedJingles = new Set<string>();

const tvPlayer = new AnnouncerPlayer();

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const blinds = (l: Level | null) => (l ? `${l.smallBlind}/${l.bigBlind}${l.ante ? ` (${l.ante})` : ''}` : '–');

const readToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

/** Televize: bez přihlášení, jen čte veřejný snapshot a střídá obrazovky podle rozvržení. */
export function TvPage() {
  const [token, setToken] = useState<string | null>(readToken);
  if (!token) {
    return (
      <PairScreen
        onPaired={(tk) => {
          try {
            localStorage.setItem(TOKEN_KEY, tk);
          } catch {
            /* paměť prohlížeče není k dispozici: televize se po obnovení musí spárovat znovu */
          }
          setToken(tk);
        }}
      />
    );
  }
  return (
    <TvScreen
      token={token}
      onUnpaired={() => {
        try {
          localStorage.removeItem(TOKEN_KEY);
        } catch {
          /* nic */
        }
        setToken(null);
      }}
    />
  );
}

function PairScreen({ onPaired }: { onPaired: (token: string) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-bg p-8 text-center text-text">
      <h1 className="font-heading text-5xl font-bold">{t('tv.pair.title')}</h1>
      <p className="max-w-xl text-xl text-muted">{t('tv.pair.help')}</p>
      <form
        className="flex flex-col items-center gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          try {
            const r = await fetch('/api/tv/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
            const body = (await r.json()) as { token?: string; error?: string };
            if (!r.ok || !body.token) {
              setError(t(`error.${body.error ?? 'TV_CODE_INVALID'}`));
              return;
            }
            onPaired(body.token);
          } catch {
            setError(t('tv.pair.failed'));
          }
        }}
      >
        <input aria-label={t('tv.pair.code')} className="w-96 rounded-md border border-line bg-surface px-4 py-3 text-center font-mono text-5xl uppercase" value={code} maxLength={9} autoFocus onChange={(e) => setCode(e.target.value)} />
        <button type="submit" disabled={code.trim().length < 8} className="rounded-md border border-primary bg-primary px-8 py-3 text-2xl font-bold text-on-primary disabled:opacity-50">
          {t('tv.pair.submit')}
        </button>
        {error && <p className="text-xl text-danger">{error}</p>}
      </form>
    </main>
  );
}

function TvScreen({ token, onUnpaired }: { token: string; onUnpaired: () => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch('/api/tv/snapshot', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
        if (r.status === 401) {
          onUnpaired();
          return;
        }
        if (!r.ok) throw new Error(String(r.status));
        const body = (await r.json()) as Snapshot;
        if (!stop) {
          setSnap(body);
          setFetchedAt(Date.now());
          setOffline(false);
        }
      } catch {
        if (!stop) setOffline(true);
      }
    };
    void load();
    const poll = setInterval(load, 2000);
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => {
      stop = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [token, onUnpaired]);

  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    const unlock = () => {
      tvPlayer.unlock();
      setUnlocked(true);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
  useEffect(() => {
    const a = snap?.announcer;
    if (!a?.enabled) return;
    for (const item of a.items) {
      tvPlayer.enqueue(
        { id: item.id, text: item.text, audio: a.audio },
        { enabled: true, browserOnly: !a.audio, volume: a.volumePercent / 100, rate: a.ratePercent / 100, voiceName: '', audioUrl: (id) => `/api/tv/announcer/audio/${id}`, headers: { authorization: `Bearer ${token}` } },
      );
    }
  }, [snap, token]);

  useEffect(() => {
    for (const j of snap?.jingles ?? []) {
      if (playedJingles.has(j.id)) continue;
      playedJingles.add(j.id);
      void (async () => {
        try {
          const res = await fetch(`/api/tv/sounds/${j.soundId}`, { headers: { authorization: `Bearer ${token}` } });
          if (!res.ok) return;
          const url = URL.createObjectURL(await res.blob());
          const a = new Audio(url);
          a.volume = (snap?.announcer.volumePercent ?? 80) / 100;
          a.onended = () => URL.revokeObjectURL(url);
          await a.play();
        } catch {
          /* zvuk se nepustil (prohlížeč čeká na dotyk) */
        }
      })();
    }
  }, [snap, token]);

  const available = useMemo(() => (snap ? snap.layout.screens.filter((sc) => isAvailable(snap, sc)) : []), [snap]);
  if (!snap) return <main className="flex min-h-screen items-center justify-center bg-bg text-3xl text-muted">{t(offline ? 'tv.offline' : 'app.loading')}</main>;

  const total = available.reduce((a, sc) => a + sc.seconds, 0);
  let active = available[0] ?? null;
  if (total > 0) {
    let pos = Math.floor(now / 1000) % total;
    for (const sc of available) {
      if (pos < sc.seconds) {
        active = sc;
        break;
      }
      pos -= sc.seconds;
    }
  }
  const elapsed = now - fetchedAt;

  return (
    <ThemeProvider themeId={snap.themeId ?? 'classic-green'} colorMode="auto">
      <main className="flex min-h-screen flex-col bg-bg text-text" style={{ fontSize: `${snap.layout.fontScalePercent}%` }}>
        <div className="flex flex-1 flex-col gap-4 p-8">{active ? <Screen snap={snap} screen={active} elapsed={elapsed} /> : <p className="m-auto text-4xl text-muted">{t('tv.idle')}</p>}</div>
        {snap.announcer.enabled && !unlocked && <p className="bg-surface px-8 py-2 text-center text-xl text-muted">{t('tv.unlockSound')}</p>}
        {offline && <p className="bg-surface px-8 py-2 text-center text-xl text-danger">{t('tv.offline')}</p>}
        {snap.layout.strip && snap.ticker.length > 0 && (
          <footer className="flex gap-8 overflow-hidden border-t border-line bg-surface px-8 py-3 text-xl">
            {snap.ticker.slice(-3).map((m, i) => (
              <span key={i} className="truncate">
                {m.nick && <strong>{m.nick}: </strong>}
                <span className={m.nick ? '' : 'text-muted'}>{m.body}</span>
              </span>
            ))}
          </footer>
        )}
      </main>
    </ThemeProvider>
  );
}

type ScreenCfg = Snapshot['layout']['screens'][number];

const pickTournament = (snap: Snapshot, sc: ScreenCfg): TvTournament | null => (sc.tournamentId ? snap.tournaments.find((x) => x.id === sc.tournamentId) : snap.tournaments[0]) ?? null;

function isAvailable(snap: Snapshot, sc: ScreenCfg): boolean {
  switch (sc.type) {
    case 'clock':
      return !!pickTournament(snap, sc);
    case 'payouts':
      return (pickTournament(snap, sc)?.payouts.length ?? 0) > 0;
    case 'players':
      return (pickTournament(snap, sc)?.standings.length ?? 0) > 0;
    case 'leaderboard':
      return snap.boards.season.length + snap.boards.rating.length + snap.boards.evening.length > 0;
    case 'table':
      return !!snap.tables[sc.tableId ?? 'auto']?.view;
    case 'polls':
      return snap.polls.length > 0;
    case 'upcoming':
      return snap.upcoming.length > 0;
    case 'evening':
      return !!snap.evening;
    default:
      return false;
  }
}

function Screen({ snap, screen, elapsed }: { snap: Snapshot; screen: ScreenCfg; elapsed: number }) {
  switch (screen.type) {
    case 'clock':
      return <ClockScreen tr={pickTournament(snap, screen)!} elapsed={elapsed} />;
    case 'payouts':
      return <PayoutsScreen tr={pickTournament(snap, screen)!} />;
    case 'players':
      return <PlayersScreen tr={pickTournament(snap, screen)!} />;
    case 'leaderboard':
      return <LeaderboardScreen boards={snap.boards} />;
    case 'table':
      return <TableScreenTv table={snap.tables[screen.tableId ?? 'auto']!} />;
    case 'polls':
      return <PollsScreen polls={snap.polls} />;
    case 'evening':
      return <EveningScreen ev={snap.evening!} />;
    default:
      return <UpcomingScreen list={snap.upcoming} />;
  }
}

function Title({ children }: { children: string }) {
  return <h1 className="font-heading text-5xl font-bold">{children}</h1>;
}

function ClockScreen({ tr, elapsed }: { tr: TvTournament; elapsed: number }) {
  const remaining = tr.clockMs !== null ? (tr.paused ? tr.clockMs : tr.clockMs - elapsed) : null;
  const state = tr.status === 'finished' ? t('tv.clock.finished') : tr.status === 'registering' ? t('tv.clock.registering') : tr.paused ? t('tv.clock.paused') : tr.onBreak ? t('tv.clock.break') : t('tv.clock.level', { n: tr.levelNumber });
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
      <Title>{tr.name}</Title>
      <p className="text-4xl text-muted">{state}</p>
      {tr.status === 'running' && !tr.onBreak && <p className="font-mono text-9xl font-bold">{blinds(tr.level)}</p>}
      {tr.status === 'running' && remaining !== null && (
        <p className="font-mono text-8xl" role="timer">
          {mmss(remaining)}
        </p>
      )}
      {tr.status === 'running' && tr.levelMode === 'hands' && !tr.onBreak && <p className="text-3xl text-muted">{t('tv.clock.hands', { n: tr.handsInLevel, max: tr.levelHands })}</p>}
      {tr.nextLevel && tr.status === 'running' && (
        <p className="text-3xl text-muted">
          {t('tv.clock.next')}: <span className="font-mono">{blinds(tr.nextLevel)}</span>
        </p>
      )}
      <dl className="mt-4 grid grid-cols-3 gap-12 text-3xl">
        <Stat label={t('tv.clock.alive')} value={`${tr.alive}/${tr.players}`} />
        <Stat label={t('tv.clock.avg')} value={tr.avgStack ?? '–'} />
        <Stat label={t('tv.clock.pool')} value={tr.prizePool} />
      </dl>
      {tr.bubble && <p className="rounded-md bg-danger px-6 py-2 text-3xl font-bold text-on-primary">{t('tv.clock.bubble')}</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col items-center">
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono text-6xl font-bold">{value}</dd>
    </div>
  );
}

function PayoutsScreen({ tr }: { tr: TvTournament }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-6">
      <Title>{`${t('tv.payouts.title')}: ${tr.name}`}</Title>
      <p className="font-mono text-6xl">{tr.prizePool}</p>
      <ul className="grid min-w-96 gap-2 text-4xl">
        {tr.payouts.map((p) => (
          <li key={p.place} className="flex justify-between gap-12 border-b border-line py-1">
            <span>{p.place}.</span>
            <span className="font-mono font-bold">{p.amount}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlayersScreen({ tr }: { tr: TvTournament }) {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <Title>{`${t('tv.players.title')}: ${tr.name}`}</Title>
      <ol className="grid grid-cols-2 gap-x-12 gap-y-1 text-3xl">
        {tr.standings.map((p) => (
          <li key={`${p.place}-${p.name}`} className={`flex justify-between gap-4 border-b border-line py-1 ${p.status === 'out' ? 'text-muted' : ''}`}>
            <span>
              {p.place}. {p.name}
            </span>
            <span className="font-mono">{tr.results ? (p.payout ?? 0) : (p.chips ?? '')}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Board({ title, rows }: { title: string; rows: { rank: number; nickname: string; value: string | number }[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-2">
      <h2 className="font-heading text-3xl font-bold">{title}</h2>
      <ol className="flex flex-col text-2xl">
        {rows.map((r) => (
          <li key={r.rank} className="flex justify-between gap-4 border-b border-line py-1">
            <span className="truncate">
              {r.rank}. {r.nickname}
            </span>
            <span className="font-mono">{r.value}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LeaderboardScreen({ boards }: { boards: Snapshot['boards'] }) {
  return (
    <div className="flex flex-1 gap-8">
      <Board title={boards.seasonName ? t('tv.leaderboard.seasonNamed', { name: boards.seasonName }) : t('tv.leaderboard.season')} rows={boards.season.map((r) => ({ rank: r.rank, nickname: r.nickname, value: r.value }))} />
      <Board title={t('tv.leaderboard.rating')} rows={boards.rating.map((r) => ({ rank: r.rank, nickname: r.nickname, value: r.rating ?? r.division }))} />
      <Board title={t('tv.leaderboard.evening')} rows={boards.evening.map((r) => ({ rank: r.rank, nickname: r.nickname, value: r.value }))} />
    </div>
  );
}

function TableScreenTv({ table }: { table: TvTable }) {
  const v = table.view;
  if (!v) return <p className="m-auto text-4xl text-muted">{t('tv.table.preparing')}</p>;
  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <Title>{table.name}</Title>
        <span className="font-mono text-3xl text-muted">
          {v.smallBlind}/{v.bigBlind}
        </span>
        {table.delay > 0 && <span className="text-xl text-muted">{t('tv.table.delay', { seconds: table.delay })}</span>}
      </div>
      <div className="flex items-center justify-center gap-3">
        {v.board.map((c, i) => (
          <CardView key={i} card={c} />
        ))}
        <span className="ml-6 font-mono text-5xl">{v.totalPot}</span>
      </div>
      <ul className="grid grid-cols-3 gap-4">
        {v.seats.map((s) => (
          <li key={s.seat} className={`flex flex-col gap-1 rounded-md border p-3 text-2xl ${v.actingSeat === s.seat ? 'border-primary' : 'border-line'} ${s.status === 'folded' ? 'opacity-50' : ''}`}>
            <span className="flex justify-between gap-2">
              <strong className="truncate">{s.name}</strong>
              {s.isDealer && <span className="text-muted">D</span>}
            </span>
            <span className="font-mono">{s.stack}</span>
            <span className="flex gap-1">
              {s.cards ? s.cards.map((c, i) => <CardView key={i} card={c} small />) : s.hasCards ? [0, 1].map((i) => <CardView key={i} card={null} small />) : null}
              {s.bet > 0 && <span className="ml-auto font-mono">{s.bet}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EveningScreen({ ev }: { ev: NonNullable<Snapshot['evening']> }) {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <Title>{t('tv.evening.title', { name: ev.name })}</Title>
      <div className="flex gap-12">
        <ol className="flex flex-1 flex-col text-3xl">
          {ev.players.map((p) => (
            <li key={p.rank} className="flex justify-between gap-4 border-b border-line py-1">
              <span className="truncate">
                {p.rank}. {p.nickname}
              </span>
              <span className="font-mono">
                {p.net} <span className="text-muted">({p.score})</span>
              </span>
            </li>
          ))}
        </ol>
        <dl className="flex flex-col gap-4 text-3xl">
          {ev.mvp && (
            <div>
              <dt className="text-muted">{t('evening.mvp')}</dt>
              <dd className="font-bold">{ev.mvp}</dd>
            </div>
          )}
          {ev.awards.hunter && (
            <div>
              <dt className="text-muted">{t('evening.award.hunter')}</dt>
              <dd>{t('evening.award.hunterText', ev.awards.hunter)}</dd>
            </div>
          )}
          {ev.awards.banker && (
            <div>
              <dt className="text-muted">{t('evening.award.banker')}</dt>
              <dd>
                {ev.awards.banker.nickname} ({ev.awards.banker.bb} BB)
              </dd>
            </div>
          )}
          {ev.awards.badBeat && (
            <div>
              <dt className="text-muted">{t('evening.award.badBeat')}</dt>
              <dd>
                {ev.awards.badBeat.nickname} ({ev.awards.badBeat.equity} %)
              </dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}

function PollsScreen({ polls }: { polls: Snapshot['polls'] }) {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <Title>{t('tv.polls.title')}</Title>
      <ul className="flex flex-col gap-4 text-4xl">
        {polls.map((p) => (
          <li key={p.id} className="flex justify-between gap-8 border-b border-line py-2">
            <span>{p.title}</span>
            <span className="text-muted">{t('tv.polls.until', { time: new Date(p.endsAt).toLocaleString() })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UpcomingScreen({ list }: { list: Snapshot['upcoming'] }) {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <Title>{t('tv.upcoming.title')}</Title>
      <ul className="flex flex-col gap-4 text-4xl">
        {list.map((u) => (
          <li key={u.id} className="flex justify-between gap-8 border-b border-line py-2">
            <span>{u.name}</span>
            <span className="text-muted">
              {new Date(u.startAt).toLocaleString()} · {t('tv.upcoming.players', { n: u.players })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
