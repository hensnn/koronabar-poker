import { SettlementPanel } from './settlement';
import { BalancesCard } from './admin/balances';
import { useCallback, useEffect, useState } from 'react';
import { currencyFormsOf, formatCurrency, t } from '@kb/shared';
import { useSettings } from '../settings';
import { del, errorText, get, post } from '../api';
import { can, useSession } from '../session';
import { Badge, Button, Card, DataTable, Notice, Td, TextInput, Select, TextArea } from '../ui';

interface HistoryRow {
  id: number;
  kind: string;
  at: string;
  gameId: string | null;
  note: string | null;
  amount: number;
}
interface RequestRow {
  id: string;
  userId: string;
  kind: string;
  amount: number | null;
  message: string | null;
  status: string;
  decisionNote: string | null;
  payload?: { target?: string } | null;
  createdAt: string;
}
interface TransferInfo {
  enabled: boolean;
  targets: string[];
  min: number;
  max: number;
}

const kindLabel = (r: { kind: string; payload?: { target?: string } | null }): string => (r.kind === 'prevod' ? `${t('wallet.transfer.kind')}: ${r.payload?.target ?? ''}` : t(`wallet.request.kind.${r.kind}`));

export function WalletPage() {
  const { me } = useSession();
  const settings = useSettings();
  const [hist, setHist] = useState<HistoryRow[]>([]);
  const [reqs, setReqs] = useState<RequestRow[]>([]);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [transfer, setTransfer] = useState<TransferInfo | null>(null);
  const [tTarget, setTTarget] = useState('');
  const [tAmount, setTAmount] = useState('');
  const [tMessage, setTMessage] = useState('');
  const [tMsg, setTMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const canRequest = can(me, 'zadost.vytvorit');
  const reload = useCallback(() => {
    get<HistoryRow[]>('/api/wallet/history').then(setHist).catch((e) => setError(errorText(e)));
    get<RequestRow[]>('/api/requests').then(setReqs).catch(() => undefined);
    get<TransferInfo>('/api/wallet/transfer')
      .then((i) => {
        setTransfer(i);
        setTTarget((c) => (i.targets.includes(c) ? c : (i.targets[0] ?? '')));
      })
      .catch(() => undefined);
  }, []);
  useEffect(reload, [reload, me?.balance]);

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-heading text-2xl font-bold">{t('wallet.title')}</h1>
      <Card>
        <p className="text-lg">
          {t('wallet.balance')}: <strong className="font-mono">{formatCurrency(me?.balance ?? 0, currencyFormsOf(settings.values))}</strong>
        </p>
      </Card>
      {error && <Notice kind="error">{error}</Notice>}

      {canRequest && (
        <Card title={t('wallet.request.title')}>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post('/api/requests', { kind: 'dobiti', amount: Number(amount), message });
                setAmount('');
                setMessage('');
                setError('');
                reload();
              } catch (er) {
                setError(errorText(er));
              }
            }}
          >
            <TextInput label={t('wallet.request.amount')} type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} required />
            <TextInput label={t('wallet.request.message')} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} />
            <Button variant="primary" type="submit">
              {t('wallet.request.submit')}
            </Button>
          </form>
          <DataTable head={[t('wallet.kind'), t('wallet.request.amount'), t('wallet.request.status'), t('wallet.request.note'), '']}>
            {reqs.filter((r) => r.userId === me?.user.id).map((r) => (
              <tr key={r.id}>
                <Td>{kindLabel(r)}</Td>
                <Td className="font-mono">{r.amount}</Td>
                <Td><Badge tone={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'danger' : 'muted'}>{t(`request.status.${r.status}`)}</Badge></Td>
                <Td>{r.decisionNote}</Td>
                <Td>{r.status === 'pending' && <Button onClick={() => void del(`/api/requests/${r.id}`).then(reload)}>{t('wallet.request.cancel')}</Button>}</Td>
              </tr>
            ))}
          </DataTable>
        </Card>
      )}

      {canRequest && transfer?.enabled && (
        <Card title={t('wallet.transfer.title')}>
          <p className="mb-2 text-sm text-muted">{t('wallet.transfer.help', { min: transfer.min, max: transfer.max })}</p>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const n = Number(tAmount);
              if (!Number.isInteger(n) || n < transfer.min || n > transfer.max) return setTMsg({ kind: 'error', text: t('wallet.transfer.range', { min: transfer.min, max: transfer.max }) });
              if (n > (me?.balance ?? 0)) return setTMsg({ kind: 'error', text: t('wallet.transfer.balance') });
              try {
                await post('/api/requests', { kind: 'prevod', amount: n, message: tMessage, target: tTarget });
                setTAmount('');
                setTMessage('');
                setTMsg({ kind: 'success', text: t('wallet.transfer.sent') });
                reload();
              } catch (er) {
                setTMsg({ kind: 'error', text: errorText(er) });
              }
            }}
          >
            <Select label={t('wallet.transfer.target')} value={tTarget} onChange={(e) => setTTarget(e.target.value)}>
              {transfer.targets.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
            <TextInput label={t('wallet.request.amount')} type="number" min={transfer.min} max={transfer.max} value={tAmount} onChange={(e) => setTAmount(e.target.value)} required />
            <TextInput label={t('wallet.request.message')} value={tMessage} onChange={(e) => setTMessage(e.target.value)} maxLength={500} />
            <Button variant="primary" type="submit" disabled={!tTarget}>
              {t('wallet.transfer.submit')}
            </Button>
          </form>
          {tMsg && <Notice kind={tMsg.kind}>{tMsg.text}</Notice>}
        </Card>
      )}

      <SettlementPanel />

      <Card title={t('wallet.history')}>
        <DataTable head={[t('wallet.when'), t('wallet.kind'), t('wallet.amount'), t('wallet.note')]}>
          {hist.map((h) => (
            <tr key={h.id}>
              <Td>{new Date(h.at).toLocaleString('cs-CZ')}</Td>
              <Td>{t(`ledger.kind.${h.kind}`)}</Td>
              <Td className={`font-mono ${h.amount >= 0 ? 'text-success' : 'text-danger'}`}>{h.amount > 0 ? `+${h.amount}` : h.amount}</Td>
              <Td>{h.note ?? h.gameId ?? ''}</Td>
            </tr>
          ))}
        </DataTable>
      </Card>
    </div>
  );
}

/** Pokladník: dobití, strhnutí, vyřizování žádostí, schvalování, kniha. */
export function CashierPanel() {
  const { me } = useSession();
  const [users, setUsers] = useState<{ id: string; nickname: string }[]>([]);
  const [reqs, setReqs] = useState<RequestRow[]>([]);
  const [form, setForm] = useState({ userId: '', amount: '', reason: '', mode: 'topup' });
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const reload = useCallback(() => {
    get<RequestRow[]>('/api/requests?all=1&status=pending').then(setReqs).catch(() => setReqs([]));
  }, []);
  useEffect(() => {
    reload();
    void get<{ id: string; nickname: string }[]>('/api/directory').then(setUsers);
  }, [reload]);
  const nick = (id: string) => users.find((u) => u.id === id)?.nickname ?? id;
  const limits = me?.limits['mena.dobit'];

  return (
    <div className="flex flex-col gap-3">
      <Card title={t('cashier.operation')}>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await post<{ done: boolean }>(`/api/admin/wallet/${form.mode}`, { userId: form.userId, amount: Number(form.amount), reason: form.reason });
              setMsg({ kind: 'success', text: r.done ? t('cashier.done') : t('cashier.pending') });
              setForm({ ...form, amount: '', reason: '' });
            } catch (er) {
              setMsg({ kind: 'error', text: errorText(er) });
            }
          }}
        >
          <Select label={t('cashier.mode')} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
            {can(me, 'mena.dobit') && <option value="topup">{t('cashier.topup')}</option>}
            {can(me, 'mena.strhnout') && <option value="debit">{t('cashier.debit')}</option>}
          </Select>
          <Select label={t('cashier.user')} value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} required>
            <option value="">{t('cashier.pick')}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.nickname}
              </option>
            ))}
          </Select>
          <TextInput label={t('wallet.amount')} type="number" min={1} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} hint={limits?.maxPerOperation ? t('cashier.limit', { n: limits.maxPerOperation }) : undefined} required />
          <TextArea label={t('cashier.reason')} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required />
          {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
          <Button variant="primary" type="submit">
            {t('table.confirm')}
          </Button>
        </form>
      </Card>

      {can(me, 'mena.vyridit_zadost') && (
        <Card title={t('cashier.requests')}>
          {reqs.length === 0 && <p className="text-muted">{t('cashier.noRequests')}</p>}
          <DataTable head={[t('cashier.user'), t('wallet.kind'), t('wallet.amount'), t('wallet.request.message'), '']}>
            {reqs.map((r) => (
              <tr key={r.id}>
                <Td>{nick(r.userId)}</Td>
                <Td>{kindLabel(r)}</Td>
                <Td className="font-mono">{r.amount}</Td>
                <Td>{r.message}</Td>
                <Td>
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={() => void post(`/api/requests/${r.id}/decide`, { approve: true }).then(reload).catch((e) => setMsg({ kind: 'error', text: errorText(e) }))}>
                      {t('cashier.approve')}
                    </Button>
                    <Button onClick={() => void post(`/api/requests/${r.id}/decide`, { approve: false, note: prompt(t('cashier.rejectReason')) ?? '' }).then(reload)}>{t('cashier.reject')}</Button>
                  </div>
                </Td>
              </tr>
            ))}
          </DataTable>
        </Card>
      )}
      {can(me, 'mena.zobrazit_knihu') && <BalancesCard refreshKey={me?.balance} />}
      {can(me, 'mena.zobrazit_knihu') && <LedgerPanel />}
    </div>
  );
}

interface LedgerTx {
  id: number;
  kind: string;
  at: string;
  note: string | null;
  entries: { account: string; amount: number }[];
}

const kindText = (k: string): string => (t(`ledger.kind.${k}`) === `ledger.kind.${k}` ? k : t(`ledger.kind.${k}`));

/** Účetní kniha pokladníka s filtry: druh pohybu, hráč nebo účet, období, text v poznámce a nejmenší částka. */
function LedgerPanel() {
  const [rows, setRows] = useState<LedgerTx[]>([]);
  const [house, setHouse] = useState<Record<string, number>>({});
  const [kinds, setKinds] = useState<string[]>([]);
  const [people, setPeople] = useState<{ userId: string; nickname: string }[]>([]);
  const [kind, setKind] = useState('');
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [min, setMin] = useState('');
  const [limit, setLimit] = useState('100');
  const [sort, setSort] = useState<{ key: 'time' | 'kind' | 'amount'; dir: 'asc' | 'desc' }>({ key: 'time', dir: 'desc' });
  useEffect(() => {
    void get<Record<string, number>>('/api/admin/house').then(setHouse).catch(() => undefined);
    void get<{ kinds: string[] }>('/api/admin/ledger/kinds').then((r) => setKinds(r.kinds)).catch(() => undefined);
    void get<{ rows: { userId: string; nickname: string }[] }>('/api/admin/balances').then((r) => setPeople(r.rows)).catch(() => undefined);
  }, []);
  useEffect(() => {
    const p = new URLSearchParams();
    if (kind) p.set('kind', kind);
    if (account) p.set('account', account);
    if (from) p.set('from', String(new Date(`${from}T00:00:00`).getTime()));
    if (to) p.set('to', String(new Date(`${to}T23:59:59`).getTime()));
    if (text.trim()) p.set('q', text.trim());
    if (Number(min) > 0) p.set('min', min);
    p.set('limit', limit);
    p.set('sort', sort.key);
    p.set('dir', sort.dir);
    const timer = window.setTimeout(() => void get<LedgerTx[]>(`/api/admin/ledger?${p.toString()}`).then(setRows).catch(() => undefined), 250);
    return () => window.clearTimeout(timer);
  }, [kind, account, from, to, text, min, limit, sort]);
  const names = new Map(people.map((x) => [`wallet:${x.userId}`, x.nickname]));
  const accountText = (a: string) => names.get(a) ?? (a === 'house' ? t('cashier.house') : a === 'mint' ? t('cashier.ledger.mint') : a);
  const sortHead = (key: 'time' | 'kind' | 'amount', label: string) => (
    <button className="underline decoration-dotted" onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))} aria-label={t('cashier.ledger.sortBy', { col: label })}>
      {label}
      {sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
    </button>
  );
  const filtered = kind !== '' || account !== '' || from !== '' || to !== '' || text.trim() !== '' || Number(min) > 0;
  return (
    <Card title={t('cashier.ledger')}>
      <p className="mb-2">
        {t('cashier.house')}: <strong className="font-mono">{house.house ?? 0}</strong>
      </p>
      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Select label={t('cashier.ledger.filterKind')} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">{t('cashier.ledger.all')}</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {kindText(k)}
            </option>
          ))}
        </Select>
        <Select label={t('cashier.ledger.filterAccount')} value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">{t('cashier.ledger.all')}</option>
          <option value="house">{t('cashier.house')}</option>
          <option value="mint">{t('cashier.ledger.mint')}</option>
          {people.map((x) => (
            <option key={x.userId} value={`wallet:${x.userId}`}>
              {x.nickname}
            </option>
          ))}
        </Select>
        <TextInput label={t('cashier.ledger.from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextInput label={t('cashier.ledger.to')} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <TextInput label={t('cashier.ledger.search')} value={text} maxLength={100} onChange={(e) => setText(e.target.value)} />
        <TextInput label={t('cashier.ledger.min')} type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} />
        <Select label={t('cashier.ledger.limit')} value={limit} onChange={(e) => setLimit(e.target.value)}>
          {['50', '100', '250', '500'].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
        <div className="flex items-end">
          <Button
            disabled={!filtered}
            onClick={() => {
              setKind('');
              setAccount('');
              setFrom('');
              setTo('');
              setText('');
              setMin('');
            }}
          >
            {t('cashier.ledger.reset')}
          </Button>
        </div>
      </div>
      <p className="mb-2 text-sm text-muted">{t('cashier.ledger.count', { n: rows.length })}</p>
      <DataTable
        head={[
          sortHead('time', '#'),
          sortHead('time', t('wallet.when')),
          sortHead('kind', t('wallet.kind')),
          sortHead('amount', t('cashier.ledger.amount')),
          t('cashier.entries'),
          t('wallet.note'),
        ]}
      >
        {rows.map((r) => (
          <tr key={r.id}>
            <Td>{r.id}</Td>
            <Td>{new Date(r.at).toLocaleString('cs-CZ')}</Td>
            <Td>{kindText(r.kind)}</Td>
            <Td className="font-mono">{Math.max(0, ...r.entries.map((e) => Math.abs(e.amount))).toLocaleString('cs-CZ')}</Td>
            <Td className="font-mono text-xs">{r.entries.map((e) => `${accountText(e.account)}: ${e.amount > 0 ? '+' : ''}${e.amount}`).join(' · ')}</Td>
            <Td>{r.note}</Td>
          </tr>
        ))}
      </DataTable>
    </Card>
  );
}
