import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../api';
import { onSocket } from '../net';
import { useSession } from '../session';
import { Badge, Button, Card, DataTable, Notice, Select, Td } from '../ui';

type Method = 'icm' | 'chipChop' | 'equal' | 'custom';

interface VoteView {
  id: string;
  status: 'open' | 'passed' | 'rejected' | 'expired' | 'cancelled';
  proposer: string | null;
  deadline: number;
  payload: { method: Method; amounts: Record<string, number>; keep: number; total: number; chips: Record<string, number> };
  voters: { userId: string; vote: boolean | null; voted: boolean }[];
  myVote: boolean | null;
  canVote: boolean;
  tally: { yes: number | null; no: number | null; voted: number; total: number };
}

interface Options {
  serverTime: number;
  blocked: string | null;
  enabled: boolean;
  maxPlayers: number;
  allowed: Method[];
  participants: { userId: string; name: string; chips: number }[];
  total: number;
  keepMax: number;
  methods: Partial<Record<Method, Record<string, number>>>;
  vote: VoteView | null;
  deal: { method: Method; keep: number } | null;
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Dohoda o rozdělení výher: návrh (srovnání metod vedle sebe, vlastní částky, ponechání části na hru)
 * a hlasování. Částky počítá server, klient je jen zobrazuje.
 */
export function DealPanel({ id, canManage = false, onlyOpen = false }: { id: string; canManage?: boolean; onlyOpen?: boolean }) {
  const { me } = useSession();
  const [opt, setOpt] = useState<Options | null>(null);
  const [error, setError] = useState('');
  const [method, setMethod] = useState<Method>('icm');
  const [keep, setKeep] = useState(0);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    get<Options>(`/api/tournaments/${id}/deal`)
      .then((o) => {
        setOpt(o);
        setFetchedAt(Date.now());
        setMethod((m) => (o.allowed.includes(m) ? m : (o.allowed[0] ?? 'icm')));
      })
      .catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(() => {
    load();
    const off = onSocket<{ id: string }>('tournament:changed', (m) => {
      if (m.id === id) load();
    });
    const poll = setInterval(load, 8000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      off();
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [id, load]);

  if (!opt || !opt.enabled) return null;
  const vote = opt.vote;
  const open = vote?.status === 'open';
  if (onlyOpen && !open) return null;
  const nameOf = (uid: string) => opt.participants.find((p) => p.userId === uid)?.name ?? '';
  const mine = opt.participants.some((p) => p.userId === me?.user.id);

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      await post(`/api/tournaments/${id}/${path}`, body);
      setError('');
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- probíhající hlasování ----
  if (open && vote) {
    const remaining = vote.deadline - opt.serverTime - (now - fetchedAt);
    return (
      <Card title={t('deal.title')}>
        <div className="flex flex-col gap-2">
          <p>
            <Badge tone="warning">{t('deal.status.open')}</Badge> <strong>{t(`deal.method.${vote.payload.method}`)}</strong> · {mmss(remaining)}
          </p>
          <p className="text-sm text-muted">{vote.proposer ? t('deal.proposedBy', { nick: nameOf(vote.proposer) }) : t('deal.proposedByOrganizer')}</p>
          <DataTable sortable={false} head={[t('deal.player'), t('deal.chips'), t('tournament.amount'), '']}>
            {vote.voters.map((v) => (
              <tr key={v.userId}>
                <Td>{nameOf(v.userId)}</Td>
                <Td className="font-mono">{vote.payload.chips[v.userId]}</Td>
                <Td className="font-mono">{vote.payload.amounts[v.userId]}</Td>
                <Td>{v.vote === true ? '✓' : v.vote === false ? '✗' : v.voted ? '•' : '?'}</Td>
              </tr>
            ))}
          </DataTable>
          {vote.payload.keep > 0 && <p className="text-sm">{t('deal.doneKeep', { keep: vote.payload.keep })}</p>}
          <p className="text-sm text-muted">{t('deal.votes', { voted: vote.tally.voted, total: vote.tally.total })}</p>
          <div className="flex flex-wrap gap-2">
            {vote.canVote && (
              <>
                <Button variant="primary" disabled={busy || vote.myVote === true} onClick={() => void act('deal/vote', { yes: true })}>
                  {t('deal.agree')}
                </Button>
                <Button variant="danger" disabled={busy || vote.myVote === false} onClick={() => void act('deal/vote', { yes: false })}>
                  {t('deal.disagree')}
                </Button>
              </>
            )}
            {(vote.proposer === me?.user.id || canManage) && (
              <Button disabled={busy} onClick={() => void act('deal/cancel')}>
                {t('deal.cancel')}
              </Button>
            )}
          </div>
          {error && <Notice kind="error">{error}</Notice>}
        </div>
      </Card>
    );
  }

  if (onlyOpen) return null;

  // ---- uzavřená dohoda ----
  if (opt.deal) {
    return (
      <Card title={t('deal.title')}>
        <p>{t('deal.done', { method: t(`deal.method.${opt.deal.method}`) })}</p>
        {opt.deal.keep > 0 && <p className="text-sm">{t('deal.doneKeep', { keep: opt.deal.keep })}</p>}
      </Card>
    );
  }

  // ---- návrh ----
  const customTotal = Object.values(custom).reduce((n, x) => n + (Number(x) || 0), 0);
  const total = opt.total - keep;
  const canPropose = opt.blocked === null && (mine || canManage);
  return (
    <Card title={t('deal.title')}>
      <div className="flex flex-col gap-3">
        {vote && vote.status !== 'open' && <Notice>{t(`deal.status.${vote.status}`)}</Notice>}
        {opt.blocked && <p className="text-muted">{t(`deal.blocked.${opt.blocked}`, { max: opt.maxPlayers })}</p>}
        {opt.participants.length >= 2 && opt.total > 0 && (
          <>
            <p className="text-sm">{t('deal.total', { total: opt.total })}</p>
            <h3 className="font-medium">{t('deal.compare')}</h3>
            <DataTable sortable={false} head={[t('deal.player'), t('deal.chips'), ...opt.allowed.filter((m) => m !== 'custom').map((m) => t(`deal.method.${m}`))]}>
              {opt.participants.map((p) => (
                <tr key={p.userId}>
                  <Td>{p.name}</Td>
                  <Td className="font-mono">{p.chips}</Td>
                  {opt.allowed.filter((m) => m !== 'custom').map((m) => (
                    <Td key={m} className="font-mono">
                      {opt.methods[m]?.[p.userId] ?? ''}
                    </Td>
                  ))}
                </tr>
              ))}
            </DataTable>
          </>
        )}
        {canPropose && (
          <div className="flex flex-col gap-2">
            <Select label={t('deal.method')} value={method} onChange={(e) => setMethod(e.target.value as Method)}>
              {opt.allowed.map((m) => (
                <option key={m} value={m}>
                  {t(`deal.method.${m}`)}
                </option>
              ))}
            </Select>
            {opt.keepMax > 0 && (
              <label className="flex flex-col text-sm">
                {t('deal.keep')}
                <input type="number" min={0} max={opt.keepMax} value={keep} onChange={(e) => setKeep(Math.max(0, Math.min(opt.keepMax, Number(e.target.value))))} className="w-32 rounded-sm border border-line bg-surface px-2 py-1" />
                <span className="text-muted">{t('deal.keepHint', { max: opt.keepMax })}</span>
              </label>
            )}
            {method === 'custom' && (
              <div className="flex flex-col gap-1">
                {opt.participants.map((p) => (
                  <label key={p.userId} className="flex items-center gap-2">
                    <span className="w-32">{p.name}</span>
                    <input type="number" min={0} value={custom[p.userId] ?? ''} onChange={(e) => setCustom({ ...custom, [p.userId]: e.target.value })} className="w-32 rounded-sm border border-line bg-surface px-2 py-1" />
                  </label>
                ))}
                <span className={customTotal === total ? 'text-success' : 'text-danger'}>
                  {customTotal} / {t('deal.customHint', { total })}
                </span>
              </div>
            )}
            <div>
              <Button
                variant="primary"
                disabled={busy || (method === 'custom' && customTotal !== total)}
                onClick={() => void act('deal/propose', { method, keep, ...(method === 'custom' ? { custom: Object.fromEntries(opt.participants.map((p) => [p.userId, Number(custom[p.userId]) || 0])) } : {}) })}
              >
                {t('deal.propose')}
              </Button>
            </div>
          </div>
        )}
        {error && <Notice kind="error">{error}</Notice>}
      </div>
    </Card>
  );
}
