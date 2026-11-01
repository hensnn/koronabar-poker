import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get, patch, post } from '../api';
import { onSocket } from '../net';
import { Link, navigate } from '../router';
import type { Card as PokerCard } from '@kb/game-core';
import { CardView } from '../table/CardView';
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
  side?: number;
  parts?: Record<string, number>;
  knockouts: number;
  xp: number;
  score: number;
}

interface HandShowPlayer {
  userId: string;
  nickname: string;
  hole: [string, string] | null;
  won: number;
  role: 'loser' | 'winner' | 'best';
  five: string[] | null;
  desc: { key: string; params?: Record<string, string> } | null;
}

interface HandShow {
  handId: string;
  game: string;
  board: string[];
  players: HandShowPlayer[];
}

interface Summary {
  games: { kind: 'tournament' | 'live_cash' | 'cash'; ref: string; name: string }[];
  players: Player[];
  lines?: { userId: string; game: string; kind: string; count: number; amount: number }[];
  transfers: { from: string; to: string; amount: number }[];
  names: Record<string, string>;
  house: number;
  mvp: { nickname: string; score: number } | null;
  awards: {
    hunter: { nickname: string; count: number } | null;
    banker: { nickname: string; game: string; bb: number; amount: number } | null;
    badBeat: { nickname: string; game: string; equity: number; hand?: HandShow | null } | null;
  };
  stats: { games: number; players: number; turnover: number; biggestPotBb: number | null };
  bestHand?: (HandShow & { userId: string; nickname: string }) | null;
}

interface View {
  id: string;
  name: string;
  status: 'open' | 'closed';
  startsAt: number;
  endsAt: number | null;
  canManage: boolean;
  summary: Summary;
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
            {!open && (
              <Button
                onClick={() => {
                  if (confirm(t('evening.confirmReopen'))) void run(() => post(`/api/evenings/${id}/reopen`));
                }}
              >
                {t('evening.reopen')}
              </Button>
            )}
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

      <Card title={t('evening.ranking')}>
        {s.players.length === 0 ? (
          <p className="text-muted">{t('tournament.noPlayers')}</p>
        ) : (
          <Ranking s={s} />
        )}
        {view.canManage && s.house !== 0 && <p className="mt-2 text-sm text-muted">{t('evening.houseTotal', { amount: s.house })}</p>}
      </Card>

      <Card title={t('evening.awards')}>
        <dl className="flex flex-col gap-2">
          <Award label={t('evening.mvp')} hint={t('evening.mvpHint')} value={s.mvp ? `${s.mvp.nickname} (${s.mvp.score})` : null} />
          <Award label={t('evening.award.hunter')} value={s.awards.hunter ? t('evening.award.hunterText', { nick: s.awards.hunter.nickname, count: s.awards.hunter.count }) : null} />
          <Award label={t('evening.award.banker')} value={s.awards.banker ? t('evening.award.bankerText', { nick: s.awards.banker.nickname, amount: s.awards.banker.amount, bb: s.awards.banker.bb, game: s.awards.banker.game }) : null} />
          <Award label={t('evening.award.badBeat')} value={s.awards.badBeat ? t('evening.award.badBeatText', { nick: s.awards.badBeat.nickname, equity: s.awards.badBeat.equity, game: s.awards.badBeat.game }) : null} />
        </dl>
        {s.awards.badBeat?.hand && <BadBeatHand hand={s.awards.badBeat.hand} equity={s.awards.badBeat.equity} />}
        <div className="mt-4 flex flex-col gap-2 border-t border-line pt-3">
          <h3 className="font-bold">{t('evening.bestHandTitle')}</h3>
          {s.bestHand ? <BestHandView hand={s.bestHand} /> : <p className="text-sm text-muted">{t('evening.bestHandNone')}</p>}
        </div>
        <details className="mt-4 rounded-md border border-line">
          <summary className="cursor-pointer px-3 py-2 font-semibold">{t('evening.legend.title')}</summary>
          <dl className="flex flex-col px-3 pb-3 gap-2 text-sm">
            {(['mvp', 'hunter', 'banker', 'badBeat', 'bestHand'] as const).map((k) => (
              <div key={k}>
                <dt className="font-semibold">{t(`evening.legend.${k}`)}</dt>
                <dd className="text-muted">{t(`evening.legend.${k}.text`)}</dd>
              </div>
            ))}
          </dl>
        </details>
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

      <Card title={t('evening.gamesTitle')}>
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-1">
            {s.games.map((g) => (
              <li key={`${g.kind}:${g.ref}`} className="flex flex-wrap items-center gap-2">
                <Badge>{t(`evening.gameKind.${g.kind}`)}</Badge>
                <span className="flex-1">{g.name}</span>
                <Link to={gameLink(g)} className="rounded-md border border-line bg-surface px-3 py-1 text-sm">
                  {t(g.kind === 'tournament' ? 'evening.openResult' : 'evening.openGame')}
                </Link>
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

      <details className="rounded-md border border-line bg-surface">
        <summary className="cursor-pointer px-4 py-3 font-heading text-lg font-bold">{t('evening.movements')}</summary>
        <div className="px-4 pb-4">
        <p className="mb-2 text-sm text-muted">{t('evening.movementsHelp')}</p>
        {s.lines === undefined ? (
          <p className="text-muted">{t('evening.movementsOld')}</p>
        ) : s.lines.length === 0 ? (
          <p className="text-muted">{t('evening.movementsNone')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {s.players.map((p) => {
              const mine = s.lines!.filter((l) => l.userId === p.userId);
              if (mine.length === 0) return null;
              return (
                <DataTable key={p.userId} head={[p.nickname, t('evening.colGame'), t('evening.colKind'), t('evening.colCount'), t('evening.colAmount')]}>
                  {mine.map((l) => (
                    <tr key={`${l.game}:${l.kind}`}>
                      <Td />
                      <Td>{s.games.find((g) => g.ref === l.game)?.name ?? l.game}</Td>
                      <Td>{t(l.kind === 'seated' ? 'evening.kind.seated' : `ledger.kind.${l.kind}`)}</Td>
                      <Td className="font-mono">{l.count}×</Td>
                      <Td className={`font-mono ${l.amount < 0 ? 'text-danger' : ''}`}>{l.amount > 0 ? `+${l.amount}` : l.amount}</Td>
                    </tr>
                  ))}
                  <tr>
                    <Td className="font-bold" colSpan={4}>
                      {t('evening.colSum')}
                    </Td>
                    <Td className="font-mono font-bold">{p.net > 0 ? `+${p.net}` : p.net}</Td>
                  </tr>
                </DataTable>
              );
            })}
          </div>
        )}
        </div>
      </details>
    </div>
  );
}

const asCard = (c: string): PokerCard => c as PokerCard;

/** Karty v řadě (rub, když je karta neznámá). */
function CardRow({ cards, marked }: { cards: string[]; /** Karty, které se zvýrazní (např. karty v ruce). */ marked?: string[] }) {
  return (
    <div className="flex flex-wrap gap-2 py-1">
      {cards.map((c) => (
        <CardView key={c} card={asCard(c)} small still mark={marked?.includes(c)} />
      ))}
    </div>
  );
}

/** Smolař: společné karty, jeho karty (čemu čelil) a karty vítěze (co ho porazilo), s názvy kombinací. */
function BadBeatHand({ hand, equity }: { hand: HandShow; equity: number }) {
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md border border-line bg-raised p-3">
      <h3 className="font-bold">{t('evening.badBeatTitle', { equity })}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 text-sm text-muted">{t('evening.board')}</span>
        <CardRow cards={hand.board} />
      </div>
      {[...hand.players].sort((a, b) => (a.role === 'loser' ? -1 : 0) - (b.role === 'loser' ? -1 : 0)).map((p) => (
        <div key={p.userId} className="flex flex-wrap items-center gap-2">
          <span className="w-28 text-sm">
            <span className="text-muted">{t(p.role === 'loser' ? 'evening.faced' : 'evening.beatBy')}</span> {p.nickname}
          </span>
          {p.hole && <CardRow cards={p.hole} marked={p.role === 'winner' ? p.hole : undefined} />}
          {p.desc && <span className="text-sm">{t(p.desc.key, p.desc.params)}</span>}
        </div>
      ))}
    </div>
  );
}

/** Handa večera: nejlepší kombinace, která na showdownu padla (pětice karet zvýrazněná). */
function BestHandView({ hand }: { hand: HandShow & { userId: string; nickname: string } }) {
  const mine = hand.players.find((p) => p.role === 'best');
  if (!mine) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-raised p-3">
      <p className="text-sm">{t('evening.bestHandText', { nick: hand.nickname, game: hand.game })}</p>
      <CardRow cards={mine.five ?? [...(mine.hole ?? []), ...hand.board]} marked={mine.hole ?? undefined} />
      {mine.desc && <p className="text-lg font-semibold">{t(mine.desc.key, mine.desc.params)}</p>}
      <p className="text-sm text-muted">{t('evening.bestHandLegend')}</p>
    </div>
  );
}

/** Kam vede odkaz na výsledek hry: turnaj, cash stůl nebo živý cash. */
const gameLink = (g: { kind: 'tournament' | 'live_cash' | 'cash'; ref: string }): string => (g.kind === 'tournament' ? `/turnaj/${g.ref}` : g.kind === 'live_cash' ? `/zivy-cash/${g.ref}` : `/stul/${g.ref}`);

function Award({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-sm text-muted" title={hint}>
        {label}
      </dt>
      <dd className="text-lg">{value ?? t('evening.award.none')}</dd>
    </div>
  );
}

/** Složky ve sloupcích tabulky pořadí (prázdné se skrývají); výsledek peněz je vpravo a zvýrazněný. */
const RANK_PARTS = ['cashBuyIn', 'cashOut', 'buyIn', 'rebuy', 'addon', 'payout', 'bounty', 'headBounty', 'bets', 'refund', 'other'] as const;
const signedN = (v: number): string => (v > 0 ? `+${v}` : String(v));
const toneOf = (v: number): string => (v > 0 ? 'text-success' : v < 0 ? 'text-danger' : '');

function Ranking({ s }: { s: Summary }) {
  const players = [...s.players].sort((a, b) => b.net - a.net || a.nickname.localeCompare(b.nickname, 'cs'));
  // Starší uzavřené večery složky nemají (jen cash a turnaje): ukážou se původní sloupce, dokud správce nepřepočítá souhrn.
  const hasParts = players.some((p) => p.parts && Object.keys(p.parts).length > 0);
  const used = hasParts ? RANK_PARTS.filter((k) => players.some((p) => (p.parts?.[k] ?? 0) !== 0)) : [];
  const hasKo = players.some((p) => p.knockouts > 0);
  return (
    <div className="overflow-x-auto">
      <DataTable
        head={[
          '#',
          t('evening.colPlayer'),
          ...(hasParts ? used.map((k) => t(`settlement.part.${k}`)) : [t('evening.colCash'), t('evening.colTournament'), t('evening.colSide')]),
          ...(hasKo ? [t('evening.colKnockouts')] : []),
          t('evening.colNet'),
        ]}
      >
        {players.map((p, i) => (
          <tr key={p.userId}>
            <Td className="font-mono">{i + 1}.</Td>
            <Td className="whitespace-nowrap">{p.nickname}</Td>
            {hasParts ? (
              used.map((k) => (
                <Td key={k} className={`font-mono ${toneOf(p.parts?.[k] ?? 0)}`}>
                  {(p.parts?.[k] ?? 0) !== 0 ? signedN(p.parts![k]!) : ''}
                </Td>
              ))
            ) : (
              <>
                <Td className="font-mono">{p.cash}</Td>
                <Td className="font-mono">{p.tournament}</Td>
                <Td className="font-mono">{p.side || ''}</Td>
              </>
            )}
            {hasKo && <Td className="font-mono">{p.knockouts || ''}</Td>}
            <Td className={`whitespace-nowrap bg-raised text-right font-mono text-lg font-bold ${toneOf(p.net)}`}>{signedN(p.net)}</Td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
