import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../api';
import { onSocket } from '../net';
import { Link, navigate } from '../router';
import { can, useSession } from '../session';
import { Badge, Button, Card, Notice, Spinner, Tabs, TextArea, TextInput } from '../ui';
import { PollEditor } from './poll-editor';

interface Option {
  id: string;
  label: string;
  emoji?: string;
}
interface OptionResult {
  id: string;
  score: number;
  voters: number;
  share: number;
  extra?: Record<string, number>;
}
interface Result {
  outcome: string;
  final: boolean;
  winners: string[];
  tied: string[];
  options: OptionResult[];
  voted: number;
  eligible: number;
  participationPercent: number;
  texts?: { userId: string | null; text: string }[];
  summary?: string;
}
interface PollView {
  id: string;
  title: string;
  description: string;
  type: 'yesno' | 'single' | 'multi' | 'ranked' | 'rating' | 'schedule' | 'text';
  options: Option[];
  minChoices: number | null;
  maxChoices: number | null;
  ratingMax: number | null;
  allowAddOptions: boolean;
  allowChange: boolean;
  anonymity: string;
  threshold: { kind: string; percent?: number };
  quorum: { kind: string; value?: number };
  eligibility: string;
  status: string;
  endsAt: number;
  founder: { id: string; nickname: string | null } | null;
  eligibleCount: number;
  votedCount: number;
  canVote: boolean;
  voted: boolean;
  myAnswer: Record<string, unknown> | null;
  manager: boolean;
  canConfirm: boolean;
  action: { kind: string; requireConfirm: boolean; state: string; message: string | null; createdId: string | null; params: Record<string, unknown> | null } | null;
  pinned: boolean;
  tiePending: string[];
  result: Result | null;
  voters: { nickname: string; answer: Record<string, unknown> }[] | null;
}
interface Row {
  id: string;
  title: string;
  type: string;
  status: string;
  endsAt: number;
  pinned: boolean;
  voted: boolean;
  canVote: boolean;
  outcome: string | null;
  summary: string | null;
}

const fmtDate = (ts: number) => new Date(ts).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' });
const label = (o: Option) => `${o.emoji ? o.emoji + ' ' : ''}${o.label}`;

function Countdown({ endsAt }: { endsAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  const ms = endsAt - now;
  if (ms <= 0) return <span>{t('polls.ended')}</span>;
  const m = Math.floor(ms / 60_000);
  const text = m >= 1440 ? t('polls.daysLeft', { n: Math.floor(m / 1440) }) : m >= 60 ? t('polls.hoursLeft', { n: Math.floor(m / 60), m: m % 60 }) : t('polls.minutesLeft', { n: m });
  return <span title={fmtDate(endsAt)}>{text}</span>;
}

const STATUS_TONE: Record<string, 'success' | 'muted' | 'warning' | 'danger'> = { open: 'success', closed: 'muted', tie: 'warning', cancelled: 'danger' };

// ---------- seznam ----------

function PollRow({ p }: { p: Row }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
      <Link to={`/ankety/${p.id}`} className="flex-1 font-medium underline">
        {p.pinned ? '📌 ' : ''}
        {p.title}
      </Link>
      <Badge tone={STATUS_TONE[p.status] ?? 'muted'}>{t(`polls.status.${p.status}`)}</Badge>
      {p.status === 'open' && (
        <span className="text-sm text-muted">
          <Countdown endsAt={p.endsAt} />
        </span>
      )}
      {p.canVote && <Badge tone="primary">{t('polls.canVote')}</Badge>}
      {p.voted && <span className="text-sm text-muted">✓ {t('polls.youVoted')}</span>}
      {p.summary && <span className="text-sm">{p.summary}</span>}
    </li>
  );
}

export function PollsPage() {
  const { me } = useSession();
  const [tab, setTab] = useState<'open' | 'mine' | 'closed'>('open');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    get<{ polls: Row[] }>(`/api/polls?scope=${tab}`)
      .then((d) => setRows(d.polls))
      .catch((e) => setError(errorText(e)));
  }, [tab]);
  useEffect(() => {
    setRows(null);
    load();
    return onSocket('poll:changed', load);
  }, [load]);
  return (
    <main className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-heading text-2xl font-bold">{t('polls.title.page')}</h1>
        {can(me, 'anketa.vytvorit') && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('polls.new')}
          </Button>
        )}
      </div>
      <Tabs tabs={[{ id: 'open' as const, label: t('polls.tab.open') }, { id: 'mine' as const, label: t('polls.tab.mine') }, { id: 'closed' as const, label: t('polls.tab.closed') }]} value={tab} onChange={setTab} />
      {error && <Notice kind="error">{error}</Notice>}
      {!rows && !error && <Spinner label={t('app.loading')} />}
      {rows && rows.length === 0 && <Notice>{t('polls.empty')}</Notice>}
      <ul className="flex flex-col gap-2">{rows?.map((p) => <PollRow key={p.id} p={p} />)}</ul>
      {creating && (
        <PollEditor
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/ankety/${id}`);
          }}
        />
      )}
    </main>
  );
}

/** Otevřené ankety, v nichž může hráč hlasovat (pro lobby a hlavní stránku). */
export function PollsPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const load = useCallback(() => {
    get<{ polls: Row[] }>('/api/polls?scope=open')
      .then((d) => setRows(d.polls.filter((p) => p.canVote || p.pinned)))
      .catch(() => setRows([]));
  }, []);
  useEffect(() => {
    load();
    return onSocket('poll:changed', load);
  }, [load]);
  if (rows.length === 0) return null;
  return (
    <Card title={t('polls.title.page')}>
      <ul className="flex flex-col gap-2">
        {rows.slice(0, 5).map((p) => (
          <PollRow key={p.id} p={p} />
        ))}
      </ul>
    </Card>
  );
}

// ---------- hlasování ----------

type Answer = Record<string, unknown>;

function VoteForm({ poll, onDone }: { poll: PollView; onDone: () => void }) {
  const prev = (poll.myAnswer ?? {}) as Answer;
  const [single, setSingle] = useState<string>((prev.option as string) ?? '');
  const [multi, setMulti] = useState<string[]>((prev.options as string[]) ?? []);
  const [order, setOrder] = useState<string[]>((prev.order as string[]) ?? []);
  const [scores, setScores] = useState<Record<string, number>>((prev.scores as Record<string, number>) ?? {});
  const [slots, setSlots] = useState<Record<string, string>>((prev.slots as Record<string, string>) ?? {});
  const [text, setText] = useState<string>((prev.text as string) ?? '');
  const [extra, setExtra] = useState('');
  const [error, setError] = useState('');
  const send = async (answer: Answer) => {
    setError('');
    try {
      await post(`/api/polls/${poll.id}/vote`, { answer });
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const label2 = (id: string) => label(poll.options.find((o) => o.id === id) ?? { id, label: id });
  const max = poll.maxChoices ?? poll.options.length;
  return (
    <div className="flex flex-col gap-3">
      {poll.type === 'yesno' && (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void send({ type: 'yesno', value: 'yes' })}>
            {t('polls.yes')}
          </Button>
          <Button variant="danger" onClick={() => void send({ type: 'yesno', value: 'no' })}>
            {t('polls.no')}
          </Button>
          <Button onClick={() => void send({ type: 'yesno', value: 'abstain' })}>{t('polls.abstain')}</Button>
        </div>
      )}
      {poll.type === 'single' && (
        <>
          <ul className="flex flex-col gap-1">
            {poll.options.map((o) => (
              <li key={o.id}>
                <label className="flex items-center gap-2">
                  <input type="radio" name="opt" checked={single === o.id} onChange={() => setSingle(o.id)} />
                  {label(o)}
                </label>
              </li>
            ))}
          </ul>
          <Button variant="primary" disabled={!single} onClick={() => void send({ type: 'single', option: single })}>
            {t('polls.vote')}
          </Button>
        </>
      )}
      {poll.type === 'multi' && (
        <>
          <p className="text-sm text-muted">{t('polls.pickBetween', { a: poll.minChoices ?? 1, b: max })}</p>
          <ul className="flex flex-col gap-1">
            {poll.options.map((o) => (
              <li key={o.id}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={multi.includes(o.id)}
                    disabled={!multi.includes(o.id) && multi.length >= max}
                    onChange={(e) => setMulti(e.target.checked ? [...multi, o.id] : multi.filter((x) => x !== o.id))}
                  />
                  {label(o)}
                </label>
              </li>
            ))}
          </ul>
          <Button variant="primary" disabled={multi.length < (poll.minChoices ?? 1)} onClick={() => void send({ type: 'multi', options: multi })}>
            {t('polls.vote')}
          </Button>
        </>
      )}
      {poll.type === 'ranked' && (
        <>
          <p className="text-sm text-muted">{t('polls.rankHint')}</p>
          <ol className="flex flex-col gap-1">
            {order.map((id, i) => (
              <li key={id} className="flex items-center gap-2">
                <span className="w-6 font-mono">{i + 1}.</span>
                <span className="flex-1">{label2(id)}</span>
                <Button disabled={i === 0} onClick={() => setOrder(order.map((x, j) => (j === i - 1 ? id : j === i ? order[i - 1]! : x)))}>↑</Button>
                <Button onClick={() => setOrder(order.filter((x) => x !== id))}>✕</Button>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            {poll.options.filter((o) => !order.includes(o.id)).map((o) => (
              <Button key={o.id} onClick={() => setOrder([...order, o.id])}>
                + {label(o)}
              </Button>
            ))}
          </div>
          <Button variant="primary" disabled={order.length === 0} onClick={() => void send({ type: 'ranked', order })}>
            {t('polls.vote')}
          </Button>
        </>
      )}
      {poll.type === 'rating' && (
        <>
          <ul className="flex flex-col gap-2">
            {poll.options.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-32 flex-1">{label(o)}</span>
                <span role="group" aria-label={label(o)} className="flex gap-1">
                  {Array.from({ length: poll.ratingMax ?? 5 }, (_, i) => i + 1).map((n) => (
                    <button key={n} aria-pressed={scores[o.id] === n} className={`h-8 w-8 rounded-sm border ${scores[o.id] === n ? 'border-primary bg-primary text-on-primary' : 'border-line bg-surface'}`} onClick={() => setScores({ ...scores, [o.id]: n })}>
                      {n}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <Button variant="primary" disabled={Object.keys(scores).length === 0} onClick={() => void send({ type: 'rating', scores })}>
            {t('polls.vote')}
          </Button>
        </>
      )}
      {poll.type === 'schedule' && (
        <>
          <ul className="flex flex-col gap-2">
            {poll.options.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-40 flex-1">{label(o)}</span>
                <span role="group" aria-label={label(o)} className="flex gap-1">
                  {(['yes', 'maybe', 'no'] as const).map((v) => (
                    <button key={v} aria-pressed={slots[o.id] === v} className={`rounded-sm border px-2 py-1 text-sm ${slots[o.id] === v ? 'border-primary bg-primary text-on-primary' : 'border-line bg-surface'}`} onClick={() => setSlots({ ...slots, [o.id]: v })}>
                      {t(`polls.slot.${v}`)}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <Button variant="primary" disabled={Object.keys(slots).length === 0} onClick={() => void send({ type: 'schedule', slots })}>
            {t('polls.vote')}
          </Button>
        </>
      )}
      {poll.type === 'text' && (
        <>
          <TextArea label={t('polls.yourAnswer')} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
          <Button variant="primary" disabled={!text.trim()} onClick={() => void send({ type: 'text', text })}>
            {t('polls.vote')}
          </Button>
        </>
      )}
      {poll.allowAddOptions && !['yesno', 'text'].includes(poll.type) && (
        <div className="flex items-end gap-2">
          <TextInput label={t('polls.addOwn')} value={extra} maxLength={120} onChange={(e) => setExtra(e.target.value)} />
          <Button
            disabled={!extra.trim()}
            onClick={async () => {
              try {
                await post(`/api/polls/${poll.id}/option`, { label: extra });
                setExtra('');
                onDone();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('polls.add')}
          </Button>
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}

// ---------- výsledky ----------

function Results({ poll }: { poll: PollView }) {
  const r = poll.result;
  if (!r) return <Notice>{t('polls.resultsHidden')}</Notice>;
  const name = (id: string) => (poll.type === 'yesno' ? t(`polls.${id}`) : label(poll.options.find((o) => o.id === id) ?? { id, label: id }));
  const top = Math.max(1, ...r.options.map((o) => o.score));
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {r.options.map((o) => (
          <li key={o.id}>
            <div className="flex justify-between text-sm">
              <span className={r.winners.includes(o.id) && r.final ? 'font-bold' : ''}>
                {r.winners.includes(o.id) && r.final ? '🏆 ' : ''}
                {name(o.id)}
              </span>
              <span className="font-mono">
                {poll.type === 'rating' ? `${o.extra?.average ?? 0} ⌀` : o.score} · {o.voters}×
                {poll.type === 'schedule' && o.extra ? ` · ${t('polls.available', { n: o.extra.available ?? 0 })}` : ''}
              </span>
            </div>
            <progress className="h-2 w-full" max={top} value={o.score} aria-label={name(o.id)} />
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted">{t('polls.participation', { v: r.voted, e: r.eligible, p: r.participationPercent })}</p>
      {r.final && r.outcome !== 'open' && <Badge tone={r.outcome === 'passed' ? 'success' : r.outcome === 'tie' ? 'warning' : 'danger'}>{t(`poll.result.${r.outcome}`)}</Badge>}
      {r.texts && r.texts.length > 0 && (
        <ul className="flex flex-col gap-1">
          {r.texts.map((x, i) => (
            <li key={i} className="rounded-sm bg-raised px-2 py-1 text-sm">
              {x.text}
            </li>
          ))}
        </ul>
      )}
      {poll.voters && poll.voters.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm">{t('polls.whoVoted')}</summary>
          <ul className="mt-1 text-sm">
            {poll.voters.map((v, i) => (
              <li key={i}>
                {v.nickname}: <span className="text-muted">{describe(poll, v.answer)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function describe(poll: PollView, a: Answer): string {
  const nm = (id: string) => poll.options.find((o) => o.id === id)?.label ?? id;
  switch (a.type) {
    case 'yesno':
      return t(`polls.${a.value as string}`);
    case 'single':
      return nm(a.option as string);
    case 'multi':
      return (a.options as string[]).map(nm).join(', ');
    case 'ranked':
      return (a.order as string[]).map(nm).join(' > ');
    case 'rating':
      return Object.entries(a.scores as Record<string, number>).map(([k, v]) => `${nm(k)}: ${v}`).join(', ');
    case 'schedule':
      return Object.entries(a.slots as Record<string, string>).map(([k, v]) => `${nm(k)}: ${t(`polls.slot.${v}`)}`).join(', ');
    default:
      return String(a.text ?? '');
  }
}

// ---------- detail ----------

export function PollPage({ id }: { id: string }) {
  const [poll, setPoll] = useState<PollView | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => {
    get<PollView>(`/api/polls/${id}`)
      .then((p) => {
        setPoll(p);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(() => {
    load();
    return onSocket<{ id: string }>('poll:changed', (e) => e.id === id && load());
  }, [load, id]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!poll) return <Spinner label={t('app.loading')} />;
  const act = async (path: string, body?: unknown) => {
    setMsg('');
    try {
      await post(`/api/polls/${id}/${path}`, body);
      load();
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  return (
    <main className="flex flex-col gap-3">
      <Link to="/ankety" className="underline">
        {t('polls.back')}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-heading text-2xl font-bold">{poll.title}</h1>
        <Badge tone={STATUS_TONE[poll.status] ?? 'muted'}>{t(`polls.status.${poll.status}`)}</Badge>
        {poll.status === 'open' && (
          <span className="text-sm text-muted">
            <Countdown endsAt={poll.endsAt} />
          </span>
        )}
      </div>
      {poll.description && <p className="whitespace-pre-wrap">{poll.description}</p>}
      <p className="text-sm text-muted">
        {t('polls.by', { nick: poll.founder?.nickname ?? '?' })} · {t(`polls.anonymity.${poll.anonymity}`)} · {t(`polls.threshold.${poll.threshold.kind}`)}
        {poll.quorum.kind !== 'none' ? ` · ${t('polls.quorumShort', { v: poll.quorum.value ?? 0, k: t(`polls.quorum.${poll.quorum.kind}`) })}` : ''}
        {poll.eligibility === 'live' ? ` · ${t('polls.eligibility.live')}` : ''}
      </p>
      {msg && <Notice kind="error">{msg}</Notice>}
      {poll.status === 'open' && (
        <Card title={poll.voted ? t('polls.changeVote') : t('polls.yourVote')}>
          {poll.canVote ? <VoteForm poll={poll} onDone={load} /> : poll.voted ? <p>{t('polls.voted')}</p> : <Notice>{t('polls.cannotVote')}</Notice>}
        </Card>
      )}
      {poll.status === 'tie' && poll.manager && (
        <Card title={t('polls.tieDecide')}>
          <div className="flex flex-wrap gap-2">
            {poll.tiePending.map((o) => (
              <Button key={o} onClick={() => void act('tie', { option: o })}>
                {label(poll.options.find((x) => x.id === o) ?? { id: o, label: o })}
              </Button>
            ))}
          </div>
        </Card>
      )}
      <Card title={t('polls.resultsTitle')}>
        <Results poll={poll} />
      </Card>
      {poll.action && (
        <Card title={t('polls.action.title')}>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <strong>{t(`polls.action.${poll.action.kind}`)}</strong>
              <Badge tone={poll.action.state === 'done' ? 'success' : poll.action.state === 'failed' || poll.action.state === 'rejected' ? 'danger' : poll.action.state === 'pendingConfirm' ? 'warning' : 'muted'}>{t(`polls.action.state.${poll.action.state}`)}</Badge>
            </div>
            {poll.action.state === 'failed' && poll.action.message && <Notice kind="error">{t('polls.action.failedWhy', { code: poll.action.message })}</Notice>}
            {poll.action.createdId && (poll.action.kind === 'scheduleTournament' || poll.action.kind === 'useTemplate') && (
              <Link to={poll.action.kind === 'scheduleTournament' ? `/turnaj/${poll.action.createdId}` : `/stul/${poll.action.createdId}`} className="underline">
                {t('polls.action.created')}
              </Link>
            )}
            {poll.action.state === 'pendingConfirm' && poll.canConfirm && (
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => void act('action', { approve: true })}>
                  {t('polls.action.confirm')}
                </Button>
                <Button variant="danger" onClick={() => void act('action', { approve: false })}>
                  {t('polls.action.reject')}
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}
      {poll.manager && (poll.status === 'open' || poll.status === 'tie') && (
        <div className="flex flex-wrap gap-2">
          {poll.status === 'open' && <Button onClick={() => confirm(t('polls.closeConfirm')) && void act('close')}>{t('polls.close')}</Button>}
          {poll.status === 'open' && (
            <Button
              onClick={() => {
                const m = Number(prompt(t('polls.extendPrompt'), '60'));
                if (m > 0) void act('extend', { minutes: m });
              }}
            >
              {t('polls.extend')}
            </Button>
          )}
          <Button variant="danger" onClick={() => confirm(t('polls.cancelConfirm')) && void act('cancel')}>
            {t('polls.cancel')}
          </Button>
          <Button onClick={() => void act('pin', { on: !poll.pinned })}>{poll.pinned ? t('polls.unpin') : t('polls.pin')}</Button>
          <a className="rounded-md border border-line bg-surface px-3 py-1" href={`/api/polls/${id}/export.csv`}>
            {t('polls.export')}
          </a>
        </div>
      )}
      {poll.manager && poll.status !== 'open' && poll.status !== 'tie' && (
        <a className="underline" href={`/api/polls/${id}/export.csv`}>
          {t('polls.export')}
        </a>
      )}
    </main>
  );
}

/** Anketa založená pro konkrétní stůl: hráč u stolu ji vidí jako upozornění nad stolem. */
export function TablePolls({ tableId, alsoIds = [] }: { tableId: string; alsoIds?: string[] }) {
  const [rows, setRows] = useState<Row[]>([]);
  const load = useCallback(() => {
    get<{ polls: (Row & { target: { kind: string; id: string | null } })[] }>('/api/polls?scope=open')
      .then((d) => setRows(d.polls.filter((p) => p.canVote && p.target.kind === 'table' && (p.target.id === tableId || (p.target.id !== null && alsoIds.includes(p.target.id))))))
      .catch(() => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, alsoIds.join(',')]);
  useEffect(() => {
    load();
    return onSocket('poll:changed', load);
  }, [load]);
  if (rows.length === 0) return null;
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-md border border-primary bg-surface p-3">
      {rows.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center gap-2">
          <strong>{p.title}</strong>
          <Link to={`/ankety/${p.id}`} className="rounded-md border border-line bg-raised px-3 py-1">
            {t('polls.card.vote')}
          </Link>
        </div>
      ))}
    </div>
  );
}
