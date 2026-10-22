import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get, patch, post } from '../api';
import { onSocket } from '../net';
import { Link, navigate } from '../router';
import { HandCard } from './hand-share';
import { Badge, Button, Card, DataTable, Modal, Notice, Select, Spinner, Td, TextInput } from '../ui';

interface ListItem {
  id: string;
  name: string;
  status: 'open' | 'closed';
  startsAt: number;
  endsAt: number | null;
  games: number | null;
  players: number | null;
  mvp: string | null;
}

interface Player {
  userId: string;
  nickname: string;
  net: number;
  cash: number;
  tournament: number;
  knockouts: number;
  xp: number;
  score: number;
}

interface Summary {
  games: { kind: 'tournament' | 'live_cash' | 'cash'; ref: string; name: string }[];
  players: Player[];
  transfers: { from: string; to: string; amount: number }[];
  names: Record<string, string>;
  house: number;
  mvp: { nickname: string; score: number } | null;
  awards: {
    hunter: { nickname: string; count: number } | null;
    banker: { nickname: string; game: string; bb: number; amount: number } | null;
    badBeat: { nickname: string; game: string; equity: number } | null;
  };
  stats: { games: number; players: number; turnover: number; biggestPotBb: number | null };
  handOfEvening?: { label: string; sharedId: string | null; votes: number } | null;
}

interface View {
  id: string;
  name: string;
  status: 'open' | 'closed';
  startsAt: number;
  endsAt: number | null;
  canManage: boolean;
  summary: Summary;
  handVote?: { pollId: string; candidates: { kind: string; label: string }[]; decided: boolean } | null;
}

const when = (ms: number) => new Date(ms).toLocaleString();

/** Archiv herních večerů. */
export function EveningsPage() {
  const [data, setData] = useState<{ canManage: boolean; evenings: ListItem[] } | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const load = useCallback(() => {
    get<{ canManage: boolean; evenings: ListItem[] }>('/api/evenings')
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    load();
    return onSocket('evening:changed', load);
  }, [load]);
  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-2xl font-bold">{t('evening.title')}</h1>
        {data.canManage && (
          <Button className="ml-auto" variant="primary" onClick={() => setCreating(true)}>
            {t('evening.create')}
          </Button>
        )}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {data.evenings.length === 0 && <Notice>{t('evening.empty')}</Notice>}
      <ul className="flex flex-col gap-1">
        {data.evenings.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface px-3 py-2">
            <strong className="min-w-32">{e.name}</strong>
            <Badge tone={e.status === 'open' ? 'success' : 'muted'}>{t(`evening.status.${e.status}`)}</Badge>
            {e.games !== null && <Badge tone="primary">{t('evening.games', { n: e.games })}</Badge>}
            {e.players !== null && <Badge tone="primary">{t('evening.players', { n: e.players })}</Badge>}
            {e.mvp && (
              <Badge tone="warning">
                {t('evening.mvp')}: {e.mvp}
              </Badge>
            )}
            <span className="text-sm text-muted">{when(e.startsAt)}</span>
            <span className="ml-auto">
              <Button variant="primary" onClick={() => navigate(`/vecery/${e.id}`)}>
                {t('evening.open')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {creating && (
        <Modal title={t('evening.create')} onClose={() => setCreating(false)}>
          <div className="flex flex-col gap-3">
            <TextInput label={t('evening.name')} value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={name.trim().length < 2}
                onClick={async () => {
                  try {
                    const r = await post<{ id: string }>('/api/evenings', { name });
                    navigate(`/vecery/${r.id}`);
                  } catch (e) {
                    setError(errorText(e));
                    setCreating(false);
                  }
                }}
              >
                {t('evening.create')}
              </Button>
              <Button onClick={() => setCreating(false)}>{t('table.cancel')}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Detail večera: pořadí a body, ocenění, vyúčtování, hry a správa. */
export function EveningPage({ id }: { id: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<{ kind: string; ref: string; name: string }[]>([]);
  const [pick, setPick] = useState('');
  const load = useCallback(() => {
    get<View>(`/api/evenings/${id}`)
      .then((v) => {
        setView(v);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(() => {
    load();
    return onSocket<{ id: string }>('evening:changed', (m) => m.id === id && load());
  }, [id, load]);
  const open = view?.status === 'open';
  useEffect(() => {
    if (view?.canManage && open) void get<{ games: typeof candidates }>(`/api/evenings/${id}/candidates`).then((d) => setCandidates(d.games)).catch(() => setCandidates([]));
  }, [id, view?.canManage, open, view?.summary.games.length]);

  if (!view) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;
  const s = view.summary;
  const nick = (uid: string) => s.names[uid] ?? uid;
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError('');
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/vecery" className="underline">
          {t('evening.back')}
        </Link>
        <h1 className="font-heading text-2xl font-bold">{view.name}</h1>
        <Badge tone={open ? 'success' : 'muted'}>{t(`evening.status.${view.status}`)}</Badge>
        <span className="text-sm text-muted">
          {t('evening.from', { time: when(view.startsAt) })}
          {view.endsAt ? ` ${t('evening.to', { time: when(view.endsAt) })}` : ''}
        </span>
      </div>
      {error && <Notice kind="error">{error}</Notice>}

      <div className="flex flex-wrap gap-2">
        <a className="rounded-md border border-line bg-surface px-3 py-1" href={`/api/evenings/${id}/export.csv`}>
          {t('evening.export')}
        </a>
        {view.canManage && (
          <>
            <Button
              onClick={() => {
                const n = prompt(t('evening.name'), view.name);
                if (n && n.trim().length >= 2) void run(() => patch(`/api/evenings/${id}`, { name: n }));
              }}
            >
              {t('evening.rename')}
            </Button>
            {open && (
              <Button
                variant="primary"
                onClick={() => {
                  if (confirm(t('evening.confirmClose'))) void run(() => post(`/api/evenings/${id}/close`));
                }}
              >
                {t('evening.close')}
              </Button>
            )}
            {!open && <Button onClick={() => void run(() => post(`/api/evenings/${id}/recompute`))}>{t('evening.recompute')}</Button>}
            <Button
              variant="danger"
              onClick={() => {
                if (confirm(t('evening.confirmDelete'))) void del(`/api/evenings/${id}`).then(() => navigate('/vecery'), (e) => setError(errorText(e)));
              }}
            >
              {t('evening.delete')}
            </Button>
          </>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card title={t('evening.awards')}>
          <dl className="flex flex-col gap-2">
            <Award label={t('evening.mvp')} value={s.mvp ? `${s.mvp.nickname} (${s.mvp.score})` : null} />
            <Award label={t('evening.award.hunter')} value={s.awards.hunter ? t('evening.award.hunterText', { nick: s.awards.hunter.nickname, count: s.awards.hunter.count }) : null} />
            <Award label={t('evening.award.banker')} value={s.awards.banker ? t('evening.award.bankerText', { nick: s.awards.banker.nickname, amount: s.awards.banker.amount, bb: s.awards.banker.bb, game: s.awards.banker.game }) : null} />
            <Award label={t('evening.award.badBeat')} value={s.awards.badBeat ? t('evening.award.badBeatText', { nick: s.awards.badBeat.nickname, equity: s.awards.badBeat.equity, game: s.awards.badBeat.game }) : null} />
          </dl>
          <div className="mt-3 flex flex-col gap-1">
            <h3 className="font-bold">{t('evening.handVoteTitle')}</h3>
            {s.handOfEvening ? (
              <>
                <p className="text-sm">{t('evening.handOfEvening', { label: s.handOfEvening.label })}</p>
                {s.handOfEvening.sharedId && <HandCard id={s.handOfEvening.sharedId} />}
              </>
            ) : view.handVote && !view.handVote.decided ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="success">{t('evening.handVoteOpen')}</Badge>
                <Link to={`/ankety/${view.handVote.pollId}`} className="rounded-md border border-line bg-surface px-3 py-1">
                  {t('evening.handVoteGo')}
                </Link>
              </div>
            ) : (
              <p className="text-sm text-muted">{t('evening.handVoteNone')}</p>
            )}
            {view.canManage && !view.handVote && (
              <div>
                <Button onClick={() => void run(() => post(`/api/evenings/${id}/hand-vote`))}>{t('evening.handVoteStart')}</Button>
              </div>
            )}
          </div>
        </Card>
        <Card title={t('evening.stats')}>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            <dt className="text-muted">{t('evening.statGames')}</dt>
            <dd className="font-mono">{s.stats.games}</dd>
            <dt className="text-muted">{t('evening.statPlayers')}</dt>
            <dd className="font-mono">{s.stats.players}</dd>
            <dt className="text-muted">{t('evening.turnover')}</dt>
            <dd className="font-mono">{s.stats.turnover}</dd>
            <dt className="text-muted">{t('evening.biggestPot')}</dt>
            <dd className="font-mono">{s.stats.biggestPotBb !== null ? t('evening.biggestPotBb', { bb: s.stats.biggestPotBb }) : '–'}</dd>
          </dl>
        </Card>
      </div>

      <Card title={t('evening.ranking')}>
        {s.players.length === 0 ? (
          <p className="text-muted">{t('tournament.noPlayers')}</p>
        ) : (
          <DataTable head={['#', t('evening.colPlayer'), t('evening.colNet'), t('evening.colCash'), t('evening.colTournament'), t('evening.colKnockouts'), t('evening.colXp'), t('evening.colScore')]}>
            {s.players.map((p, i) => (
              <tr key={p.userId}>
                <Td className="font-mono">{i + 1}.</Td>
                <Td>{p.nickname}</Td>
                <Td className="font-mono">{p.net}</Td>
                <Td className="font-mono">{p.cash}</Td>
                <Td className="font-mono">{p.tournament}</Td>
                <Td className="font-mono">{p.knockouts || ''}</Td>
                <Td className="font-mono">{p.xp || ''}</Td>
                <Td className="font-mono font-bold">{p.score}</Td>
              </tr>
            ))}
          </DataTable>
        )}
        <p className="mt-2 text-sm text-muted">{t('evening.weights')}</p>
      </Card>

      <Card title={t('evening.transfers')}>
        {s.transfers.length === 0 ? (
          <p className="text-muted">{t('evening.noTransfers')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {s.transfers.map((tr, i) => (
              <li key={i}>{t('evening.transfer', { from: nick(tr.from), to: nick(tr.to), amount: tr.amount })}</li>
            ))}
          </ul>
        )}
        {view.canManage && s.house !== 0 && <p className="mt-2 text-sm text-muted">{t('evening.houseTotal', { amount: s.house })}</p>}
      </Card>

      <Card title={t('evening.gamesTitle')}>
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-1">
            {s.games.map((g) => (
              <li key={`${g.kind}:${g.ref}`} className="flex flex-wrap items-center gap-2">
                <Badge>{t(`evening.gameKind.${g.kind}`)}</Badge>
                <span className="flex-1">{g.name}</span>
                {view.canManage && open && <Button onClick={() => void run(() => post(`/api/evenings/${id}/games/remove`, { kind: g.kind, ref: g.ref }))}>{t('evening.removeGame')}</Button>}
              </li>
            ))}
          </ul>
          {view.canManage && open && (
            <div className="flex flex-wrap items-end gap-2">
              <Select label={t('evening.addGame')} value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">{t('evening.pickGame')}</option>
                {candidates.map((g) => (
                  <option key={`${g.kind}:${g.ref}`} value={`${g.kind}:${g.ref}`}>
                    {t(`evening.gameKind.${g.kind}`)}: {g.name}
                  </option>
                ))}
              </Select>
              <Button
                variant="primary"
                disabled={!pick}
                onClick={() => {
                  const [kind, ...rest] = pick.split(':');
                  setPick('');
                  void run(() => post(`/api/evenings/${id}/games`, { kind, ref: rest.join(':') }));
                }}
              >
                {t('evening.addGame')}
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Award({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-lg">{value ?? t('evening.award.none')}</dd>
    </div>
  );
}
