import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../api';
import { onSocket } from '../net';
import { Link, navigate } from '../router';
import { can, useSession } from '../session';
import { Badge, Button, Card, DataTable, Modal, Notice, Select, Spinner, TextInput, Td } from '../ui';

interface Dir {
  id: string;
  nickname: string;
}

/** Hráči k výběru (adresář bez zablokovaných). */
function useDirectory(): Dir[] {
  const [users, setUsers] = useState<Dir[]>([]);
  useEffect(() => {
    void get<Dir[]>('/api/directory').then(setUsers).catch(() => setUsers([]));
  }, []);
  return users;
}

export interface LiveStanding {
  userId: string;
  name: string;
  seat: number | null;
  tableNo?: number | null;
  status: string;
}

export interface LiveSuggestion {
  userId: string;
  name: string;
  fromNo: number;
  toTable: string;
  toNo: number;
  reason: 'balance' | 'break';
}

/** Ovládání živého turnaje: ředitel přihlašuje hráče, zapisuje rebuy, add-on a vyřazení. */
export function LiveDirectorPanel({
  id,
  status,
  standings,
  canRebuy,
  canAddon,
  canReenter,
  suggestions = [],
  multiTable = false,
  onDone,
}: {
  id: string;
  status: string;
  standings: LiveStanding[];
  canRebuy: boolean;
  canAddon: boolean;
  canReenter: boolean;
  suggestions?: LiveSuggestion[];
  multiTable?: boolean;
  onDone: () => void;
}) {
  const users = useDirectory();
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [victim, setVictim] = useState<LiveStanding | null>(null);
  const [killers, setKillers] = useState<string[]>([]);

  const run = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await post(`/api/tournaments/${id}/live/${path}`, body);
      setError('');
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const inGame = new Set(standings.map((s) => s.userId));
  const free = users.filter((u) => !inGame.has(u.id));
  const alive = standings.filter((s) => s.status === 'playing' || s.status === 'deciding');
  const open = status === 'registering' || status === 'running';

  return (
    <Card title={t('live.directorTitle')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('live.directorHint')}</p>
        {error && <Notice kind="error">{error}</Notice>}
        {open && (
          <div className="flex flex-wrap items-end gap-2">
            <Select label={t('live.addPlayer')} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">{t('live.pickPlayer')}</option>
              {free.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nickname}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              disabled={busy || !pick}
              onClick={async () => {
                await run('register', { userId: pick });
                setPick('');
              }}
            >
              {t('live.add')}
            </Button>
          </div>
        )}
        {suggestions.length > 0 && (
          <section className="flex flex-col gap-2 rounded-md border border-primary p-3">
            <h3 className="font-bold">{t('live.suggestTitle')}</h3>
            <p className="text-sm text-muted">{t('live.suggestHint')}</p>
            <ul className="flex flex-col gap-1">
              {suggestions.map((m) => (
                <li key={m.userId} className="flex flex-wrap items-center gap-2">
                  <span className="flex-1">{t(m.reason === 'break' ? 'live.suggestBreak' : 'live.suggestBalance', { nick: m.name, from: m.fromNo, to: m.toNo })}</span>
                  <Button variant="primary" disabled={busy} onClick={() => void run('move', { userId: m.userId, toTable: m.toTable })}>
                    {t('live.moveConfirm')}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {standings.length > 0 && (
          <DataTable head={[t('live.seat'), t('tournament.player'), t('tournament.statusCol'), '']}>
            {standings.map((p) => (
              <tr key={p.userId}>
                <Td className="font-mono">{p.seat === null || p.status === 'out' ? '' : multiTable && p.tableNo ? t('live.tableSeat', { t: p.tableNo, s: p.seat + 1 }) : p.seat + 1}</Td>
                <Td>{p.name}</Td>
                <Td>{t(`tournament.player.${p.status}`)}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {status === 'registering' && (
                      <Button disabled={busy} onClick={() => void run('unregister', { userId: p.userId })}>
                        {t('live.unregister')}
                      </Button>
                    )}
                    {status === 'running' && (p.status === 'playing' || p.status === 'deciding') && (
                      <>
                        {canRebuy && (
                          <Button disabled={busy} onClick={() => void run('buy', { userId: p.userId, what: 'rebuy' })}>
                            {t('live.rebuy')}
                          </Button>
                        )}
                        {canAddon && (
                          <Button disabled={busy} onClick={() => void run('buy', { userId: p.userId, what: 'addon' })}>
                            {t('live.addon')}
                          </Button>
                        )}
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() => {
                            setKillers([]);
                            setVictim(p);
                          }}
                        >
                          {t('live.eliminate')}
                        </Button>
                      </>
                    )}
                    {status === 'running' && p.status === 'out' && canReenter && (
                      <Button disabled={busy} onClick={() => void run('buy', { userId: p.userId, what: 'reenter' })}>
                        {t('live.reenter')}
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </DataTable>
        )}
      </div>
      {victim && (
        <Modal title={t('live.eliminateTitle', { nick: victim.name })} onClose={() => setVictim(null)}>
          <div className="flex flex-col gap-3">
            <fieldset className="flex flex-col gap-1">
              <legend className="font-medium">{t('live.killers')}</legend>
              {alive
                .filter((p) => p.userId !== victim.userId)
                .map((p) => (
                  <label key={p.userId} className="flex items-center gap-2">
                    <input type="checkbox" checked={killers.includes(p.userId)} onChange={(e) => setKillers(e.target.checked ? [...killers, p.userId] : killers.filter((x) => x !== p.userId))} />
                    {p.name}
                  </label>
                ))}
            </fieldset>
            <p className="text-sm text-muted">{t('live.killersHint')}</p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  await run('eliminate', { victimId: victim.userId, killers });
                  setVictim(null);
                }}
              >
                {t('live.confirmEliminate')}
              </Button>
              <Button onClick={() => setVictim(null)}>{t('table.cancel')}</Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

// ---------- živý cash ----------

interface GameSummary {
  id: string;
  name: string;
  status: 'open' | 'closed';
  players: number;
}

export function LiveCashListPage() {
  const { me } = useSession();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const reload = useCallback(() => {
    get<{ games: GameSummary[] }>('/api/live-cash')
      .then((d) => setGames(d.games))
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    reload();
    return onSocket('live:changed', reload);
  }, [reload]);
  if (!games) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-2xl font-bold">{t('liveCash.title')}</h1>
        {can(me, 'zivahra.rizeni') && (
          <Button className="ml-auto" variant="primary" onClick={() => setCreating(true)}>
            {t('liveCash.create')}
          </Button>
        )}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {games.length === 0 && <Notice>{t('liveCash.empty')}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        {games.map((g) => (
          <Card key={g.id} title={g.name}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={g.status === 'open' ? 'success' : 'muted'}>{t(`liveCash.status.${g.status}`)}</Badge>
              <Badge tone="primary">
                {g.players} {t('lobby.players')}
              </Badge>
              <Button variant="primary" onClick={() => navigate(`/zivy-cash/${g.id}`)}>
                {t('liveCash.open')}
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {creating && (
        <Modal title={t('liveCash.create')} onClose={() => setCreating(false)}>
          <div className="flex flex-col gap-3">
            <TextInput label={t('liveCash.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={name.trim().length < 2}
                onClick={async () => {
                  try {
                    const r = await post<{ id: string }>('/api/live-cash', { name });
                    navigate(`/zivy-cash/${r.id}`);
                  } catch (e) {
                    setError(errorText(e));
                    setCreating(false);
                  }
                }}
              >
                {t('liveCash.create')}
              </Button>
              <Button onClick={() => setCreating(false)}>{t('table.cancel')}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface GameView {
  id: string;
  name: string;
  status: 'open' | 'closed';
  pot: number;
  buyIns: number;
  fees: number;
  timeFeePerHour: number;
  players: { userId: string; name: string; buyIns: number; fee: number; cashOut: number; seated: boolean; net: number }[];
  log: { at: number; userId: string; kind: 'buyin' | 'topup' | 'fee' | 'cashout'; amount: number }[];
  director: boolean;
}

type Action = 'buyin' | 'fee' | 'cashout';

export function LiveCashPage({ id }: { id: string }) {
  const [view, setView] = useState<GameView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{ action: Action; userId: string } | null>(null);
  const [amount, setAmount] = useState('');
  const users = useDirectory();
  const load = useCallback(() => {
    get<GameView>(`/api/live-cash/${id}`)
      .then((v) => {
        setView(v);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(() => {
    load();
    const off = onSocket<{ id: string }>('live:changed', (m) => m.id === id && load());
    const poll = setInterval(load, 10_000);
    return () => {
      off();
      clearInterval(poll);
    };
  }, [id, load]);
  if (!view) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;

  const nick = (userId: string) => view.players.find((p) => p.userId === userId)?.name ?? users.find((u) => u.id === userId)?.nickname ?? '?';
  const open = view.status === 'open';
  const submit = async () => {
    if (!dialog) return;
    setBusy(true);
    try {
      await post(`/api/live-cash/${id}/${dialog.action}`, { userId: dialog.userId, amount: Number(amount) });
      setDialog(null);
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const ask = (action: Action, userId: string) => {
    setAmount(action === 'fee' && view.timeFeePerHour > 0 ? String(view.timeFeePerHour) : '');
    setDialog({ action, userId });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/zivy-cash" className="underline">
          {t('liveCash.back')}
        </Link>
        <h1 className="font-heading text-2xl font-bold">{view.name}</h1>
        <Badge tone={open ? 'success' : 'muted'}>{t(`liveCash.status.${view.status}`)}</Badge>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <Card>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
          <dt className="text-muted">{t('liveCash.pot')}</dt>
          <dd className="font-mono">{view.pot}</dd>
          <dt className="text-muted">{t('liveCash.buyIns')}</dt>
          <dd className="font-mono">{view.buyIns}</dd>
          <dt className="text-muted">{t('liveCash.fees')}</dt>
          <dd className="font-mono">{view.fees}</dd>
        </dl>
      </Card>

      {open && view.director && (
        <Card title={t('live.directorTitle')}>
          <div className="flex flex-wrap items-end gap-2">
            <Select label={t('live.addPlayer')} value="" onChange={(e) => e.target.value && ask('buyin', e.target.value)}>
              <option value="">{t('live.pickPlayer')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nickname}
                </option>
              ))}
            </Select>
          </div>
        </Card>
      )}

      <Card>
        {view.players.length === 0 ? (
          <p className="text-muted">{t('tournament.noPlayers')}</p>
        ) : (
          <DataTable head={[t('liveCash.player'), t('liveCash.colBuyIns'), t('liveCash.colFee'), t('liveCash.colCashOut'), t('liveCash.colNet'), '']}>
            {view.players.map((p) => (
              <tr key={p.userId}>
                <Td>
                  {p.name} <Badge tone={p.seated ? 'success' : 'muted'}>{t(p.seated ? 'liveCash.seated' : 'liveCash.left')}</Badge>
                </Td>
                <Td className="font-mono">{p.buyIns}</Td>
                <Td className="font-mono">{p.fee || ''}</Td>
                <Td className="font-mono">{p.cashOut || ''}</Td>
                <Td className="font-mono">{p.net}</Td>
                <Td>
                  {open && view.director && (
                    <div className="flex flex-wrap gap-1">
                      <Button onClick={() => ask('buyin', p.userId)}>{t('liveCash.buyIn')}</Button>
                      {p.seated && <Button onClick={() => ask('fee', p.userId)}>{t('liveCash.timeFee')}</Button>}
                      {p.seated && <Button onClick={() => ask('cashout', p.userId)}>{t('liveCash.cashOut')}</Button>}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>

      {open && view.director && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted">{t('liveCash.settleHint')}</p>
          <div>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                if (!confirm(t('liveCash.confirmClose'))) return;
                try {
                  await post(`/api/live-cash/${id}/close`);
                  load();
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              {t('liveCash.close')}
            </Button>
          </div>
        </div>
      )}

      {view.log.length > 0 && (
        <Card title={t('liveCash.log')}>
          <ul className="flex flex-col gap-1 text-sm">
            {view.log.map((l, i) => (
              <li key={i}>
                <span className="text-muted">{new Date(l.at).toLocaleTimeString()}</span> {nick(l.userId)}: {t(`liveCash.kind.${l.kind}`)} <span className="font-mono">{l.amount}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {dialog && (
        <Modal title={`${t(dialog.action === 'buyin' ? 'liveCash.buyIn' : dialog.action === 'fee' ? 'liveCash.timeFee' : 'liveCash.cashOut')}: ${nick(dialog.userId)}`} onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-3">
            <TextInput label={t('liveCash.amount')} type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            {dialog.action === 'fee' && view.timeFeePerHour > 0 && <p className="text-sm text-muted">{t('liveCash.timeFeeHint', { amount: view.timeFeePerHour })}</p>}
            <div className="flex gap-2">
              <Button variant="primary" disabled={busy || amount === '' || !Number.isInteger(Number(amount))} onClick={() => void submit()}>
                {t('liveCash.confirm')}
              </Button>
              <Button onClick={() => setDialog(null)}>{t('table.cancel')}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
