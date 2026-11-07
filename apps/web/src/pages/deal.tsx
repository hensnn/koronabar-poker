import { useCallback, useEffect, useRef, useState } from 'react';
import { currencyFormsOf, formatCurrency, t } from '@kb/shared';
import { errorText, get, post } from '../api';
import { onSocket } from '../net';
import { useSession } from '../session';
import { useSettings } from '../settings';
import { dealFinance, type DealFinance } from './deal-finance';
import { Badge, Button, Card, DataTable, isConfirmKey, Notice, Select, Td, useArrowChoices } from '../ui';

type Method = 'icm' | 'chipChop' | 'equal' | 'custom';

interface VoteView {
  id: string;
  status: 'open' | 'passed' | 'rejected' | 'expired' | 'cancelled';
  proposer: string | null;
  deadline: number;
  payload: { method: Method; amounts: Record<string, number>; keep: number; total: number; chips: Record<string, number>; places?: number[]; fair?: Record<string, number> };
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
  /** Výplaty za místa 1 až k, referenční ICM a zbytek bounty (starší server je neposílá). */
  places?: number[];
  fair?: Record<string, number> | null;
  bountyBank?: number;
  vote: VoteView | null;
  deal: { method: Method; keep: number; amounts?: Record<string, number>; participants?: string[] } | null;
}

type Money = (n: number) => string;
const num1 = (n: number): string => n.toLocaleString('cs-CZ', { maximumFractionDigits: 1 });
/** Rozdíl v měně se znaménkem (+120 Korun, −50 Korun). */
const signedMoney = (n: number, money: Money): string => (n > 0 ? `+${money(n)}` : n < 0 ? `−${money(-n)}` : money(0));

/**
 * Finanční shrnutí dohody větou po větě: co se dělí, co se ponechává na hru, co dostane čtenář, co by dostal bez dohody
 * a co se po přijetí stane. Všechny částky jsou v měně (ne v žetonech).
 */
function DealSummary({ f, money, meId, bountyBank = 0, accepted = false }: { f: DealFinance; money: Money; meId?: string; bountyBank?: number; accepted?: boolean }) {
  const mine = f.rows.find((r) => r.userId === meId);
  const k = f.rows.length;
  return (
    <ul className="flex flex-col gap-1 rounded-md border border-line bg-raised p-2 text-sm">
      <li>{t('deal.sum.total', { total: money(f.total), k })}</li>
      {f.keep > 0 && <li>{t('deal.sum.keep', { keep: money(f.keep) })}</li>}
      <li>{t('deal.sum.shared', { shared: money(f.shared) })}</li>
      {mine && (
        <li className="font-semibold">
          {t('deal.mine', { amount: money(mine.amount), pct: num1(mine.sharePct) })}
          {mine.vsFair !== null && <span className="font-normal text-muted"> {t('deal.mineVsFair', { diff: signedMoney(mine.vsFair, money) })}</span>}
        </li>
      )}
      {mine && f.range && (
        <li className="text-muted">{t('deal.range', { min: money(f.range.min), max: money(f.range.max), k })}</li>
      )}
      {!accepted && f.keep === 0 && <li>{t('deal.after.end')}</li>}
      {!accepted && f.keep > 0 && <li>{t('deal.after.keep', { keep: money(f.keep) })}</li>}
      {f.keep === 0 && bountyBank > 0 && <li>{t('deal.after.bounty', { bank: money(bountyBank) })}</li>}
      {!accepted && <li className="text-muted">{t('deal.after.no')}</li>}
    </ul>
  );
}

/** Tabulka dohody: žetony a jejich podíl, dohodnutá částka, podíl z dělené částky a rozdíl proti ICM; moje řádka je zvýrazněná. */
function DealRows({ f, money, meId, votes }: { f: DealFinance; money: Money; meId?: string; votes?: Record<string, boolean | null | 'voted'> }) {
  const hasFair = f.rows.some((r) => r.vsFair !== null);
  return (
    <DataTable sortable={false} head={[t('deal.player'), t('deal.col.chips'), t('deal.col.gets'), t('deal.col.share'), ...(hasFair ? [t('deal.col.vsIcm')] : []), ...(votes ? [''] : [])]}>
      {f.rows.map((r) => (
        <tr key={r.userId} className={r.userId === meId ? 'bg-raised font-semibold' : ''}>
          <Td>{r.name}</Td>
          <Td className="font-mono whitespace-nowrap">
            {r.chips} <span className="text-muted">({num1(r.chipPct)} %)</span>
          </Td>
          <Td className="font-mono whitespace-nowrap">{money(r.amount)}</Td>
          <Td className="font-mono">{num1(r.sharePct)} %</Td>
          {hasFair && (
            <Td className={`font-mono whitespace-nowrap ${r.vsFair === null ? '' : r.vsFair > 0 ? 'text-success' : r.vsFair < 0 ? 'text-danger' : ''}`}>
              <span title={t('deal.icmHint')}>{r.vsFair === null ? '' : signedMoney(r.vsFair, money)}</span>
            </Td>
          )}
          {votes && <Td>{votes[r.userId] === true ? '✓' : votes[r.userId] === false ? '✗' : votes[r.userId] === 'voted' ? '•' : '?'}</Td>}
        </tr>
      ))}
    </DataTable>
  );
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
  const settings = useSettings();
  const forms = currencyFormsOf(settings.values);
  const money: Money = (n) => formatCurrency(n, forms);
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

  // Klávesnice u hlasování o dohodě: Enter nebo mezerník souhlasí (hlavní odpověď), Tab a šipky přepínají mezi odpověďmi.
  const choiceRef = useRef<HTMLDivElement>(null);
  const canAnswer = opt?.vote?.status === 'open' && opt.vote.canVote;
  const firstAnswer = canAnswer && opt?.vote?.myVote === null;
  useArrowChoices(choiceRef, !!canAnswer);
  useEffect(() => {
    if (!firstAnswer) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isConfirmKey(e) || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      void post(`/api/tournaments/${id}/deal/vote`, { yes: true })
        .then(() => load())
        .catch((err) => setError(errorText(err)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [firstAnswer, id, load]);

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
    const f = dealFinance({
      participants: vote.voters.map((v) => ({ userId: v.userId, name: nameOf(v.userId), chips: vote.payload.chips[v.userId] ?? 0 })),
      amounts: vote.payload.amounts,
      keep: vote.payload.keep,
      total: vote.payload.total,
      places: vote.payload.places,
      fair: vote.payload.fair,
    });
    return (
      <Card title={t('deal.title')}>
        <div ref={choiceRef} className="kd-choice flex flex-col gap-2">
          <p>
            <Badge tone="warning">{t('deal.status.open')}</Badge> <strong>{t(`deal.method.${vote.payload.method}`)}</strong> · {mmss(remaining)}
          </p>
          <p className="text-sm text-muted">{vote.proposer ? t('deal.proposedBy', { nick: nameOf(vote.proposer) }) : t('deal.proposedByOrganizer')}</p>
          <DealSummary f={f} money={money} meId={me?.user.id} bountyBank={opt.bountyBank} />
          <DealRows f={f} money={money} meId={me?.user.id} votes={Object.fromEntries(vote.voters.map((v) => [v.userId, v.vote ?? (v.voted ? 'voted' : null)]))} />
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
    const deal = opt.deal;
    // Žetony a výplaty za místa jsou v přijatém hlasování; bez něj (starší data) se ukáže aspoň, kdo co dostane.
    const passed = vote?.status === 'passed' ? vote : null;
    const ids = deal.participants ?? Object.keys(deal.amounts ?? {});
    const amounts = deal.amounts ?? {};
    const f = dealFinance({
      participants: ids.map((uid) => ({ userId: uid, name: nameOf(uid), chips: passed?.payload.chips[uid] ?? 0 })),
      amounts,
      keep: deal.keep,
      total: passed?.payload.total ?? Object.values(amounts).reduce((n, x) => n + x, 0) + deal.keep,
      places: passed?.payload.places,
      fair: passed?.payload.fair,
    });
    return (
      <Card title={t('deal.title')}>
        <div className="flex flex-col gap-2">
          <p>
            <Badge tone="success">{t('deal.status.passed')}</Badge> {t('deal.done', { method: t(`deal.method.${deal.method}`) })}
          </p>
          {Object.keys(amounts).length > 0 && (
            <>
              <DealSummary f={f} money={money} meId={me?.user.id} accepted />
              <DealRows f={f} money={money} meId={me?.user.id} />
            </>
          )}
          {deal.keep > 0 && <p className="text-sm">{t('deal.doneKeepMoney', { keep: money(deal.keep) })}</p>}
        </div>
      </Card>
    );
  }

  // ---- návrh ----
  const customTotal = Object.values(custom).reduce((n, x) => n + (Number(x) || 0), 0);
  const total = opt.total - keep;
  const canPropose = opt.blocked === null && (mine || canManage);
  // Náhled návrhu: co by dohoda dala, kdyby ji všichni přijali. U vlastních částek z toho, co je zadané; u ostatních metod ze srovnání
  // (server je s ponechanou částí počítá až při odeslání, proto bez náhledu, dokud se nějaká část ponechává).
  const previewAmounts: Record<string, number> | null =
    method === 'custom'
      ? customTotal === total && opt.participants.length > 0
        ? Object.fromEntries(opt.participants.map((p) => [p.userId, Number(custom[p.userId]) || 0]))
        : null
      : keep === 0
        ? (opt.methods[method] ?? null)
        : null;
  const preview = previewAmounts && opt.participants.length >= 2 ? dealFinance({ participants: opt.participants, amounts: previewAmounts, keep, total: opt.total, places: opt.places, fair: opt.fair }) : null;
  return (
    <Card title={t('deal.title')}>
      <div className="flex flex-col gap-3">
        {vote && vote.status !== 'open' && <Notice>{t(`deal.status.${vote.status}`)}</Notice>}
        {opt.blocked && <p className="text-muted">{t(`deal.blocked.${opt.blocked}`, { max: opt.maxPlayers })}</p>}
        {opt.participants.length >= 2 && opt.total > 0 && (
          <>
            <p className="text-sm">{t('deal.total', { total: money(opt.total) })}</p>
            {mine && opt.places && opt.places.length > 0 && (
              <p className="text-sm text-muted">{t('deal.range', { min: money(opt.places[opt.places.length - 1]!), max: money(opt.places[0]!), k: opt.places.length })}</p>
            )}
            <h3 className="font-medium">{t('deal.compare')}</h3>
            <DataTable sortable={false} head={[t('deal.player'), t('deal.col.chips'), ...opt.allowed.filter((m) => m !== 'custom').map((m) => t(`deal.method.${m}`))]}>
              {[...opt.participants].sort((a, b) => b.chips - a.chips).map((p) => {
                const chipsAll = opt.participants.reduce((n, x) => n + x.chips, 0);
                return (
                  <tr key={p.userId} className={p.userId === me?.user.id ? 'bg-raised font-semibold' : ''}>
                    <Td>{p.name}</Td>
                    <Td className="font-mono whitespace-nowrap">
                      {p.chips} <span className="text-muted">({num1(chipsAll > 0 ? (p.chips / chipsAll) * 100 : 0)} %)</span>
                    </Td>
                    {opt.allowed.filter((m) => m !== 'custom').map((m) => (
                      <Td key={m} className="font-mono whitespace-nowrap">
                        {opt.methods[m]?.[p.userId] !== undefined ? money(opt.methods[m]![p.userId]!) : ''}
                      </Td>
                    ))}
                  </tr>
                );
              })}
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
                <span className="text-muted">{t('deal.keepHint', { max: money(opt.keepMax) })}</span>
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
            {preview && <DealSummary f={preview} money={money} meId={me?.user.id} bountyBank={opt.bountyBank} />}
            {!preview && keep > 0 && method !== 'custom' && <p className="text-sm text-muted">{t('deal.previewKeep', { keep: money(keep), shared: money(total) })}</p>}
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
