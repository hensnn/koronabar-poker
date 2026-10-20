import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../api';
import { onSocket } from '../net';
import { useSession } from '../session';
import { Badge, Button, Card, Modal, Notice, Select, TextInput } from '../ui';

interface Person {
  userId: string;
  nickname: string;
}
interface MyStake {
  side: 'yes' | 'no';
  amount: number;
  status: string;
  payout: number;
}
interface BetDto {
  id: string;
  kind: 'pool' | 'direct';
  subject: string;
  params: { userId?: string; a?: string; b?: string; place?: number; text?: string };
  title: string;
  status: string;
  outcome: string | null;
  proposedOutcome: string | null;
  proposedAt: number | null;
  creator: Person | null;
  subjects: Person[];
  totals: { yes: number; no: number };
  stakes: (Person & { side: 'yes' | 'no'; amount: number; status: string; payout: number })[];
  mine: MyStake[];
  feePercent: number;
}
interface BountyDto {
  id: string;
  target: Person;
  poster: Person;
  amount: number;
  status: string;
}
interface Data {
  enabled: boolean;
  limits: { min: number; max: number; feePercent: number; customEnabled: boolean; defaultClose: string; disputeHours: number };
  canCreate: boolean;
  canStake: boolean;
  referee: boolean;
  players: Person[];
  bets: BetDto[];
  headBounties: { enabled: boolean; limits: { min: number; max: number; maxPerPoster: number }; bounties: BountyDto[] };
}

const label = (b: BetDto): string => {
  const [a, c] = [b.subjects[0]?.nickname ?? '?', b.subjects[1]?.nickname ?? '?'];
  switch (b.subject) {
    case 'winner':
      return t('bets.label.winner', { nick: a });
    case 'firstOut':
      return t('bets.label.firstOut', { nick: a });
    case 'duel':
      return t('bets.label.duel', { a, b: c });
    case 'place':
      return t('bets.label.place', { nick: a, place: b.params.place ?? '?' });
    default:
      return b.params.text ?? b.title;
  }
};

const sideText = (s: string) => t(s === 'yes' ? 'bets.sideYes' : 'bets.sideNo');
const outcomeText = (o: string | null) => (o ? t(`bets.outcome.${o}`) : '');

/** Sázky a odměny na hlavu u jednoho turnaje. */
export function BetsPanel({ tournamentId }: { tournamentId: string }) {
  const { me } = useSession();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    get<Data>(`/api/tournaments/${tournamentId}/bets`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, [tournamentId]);
  useEffect(() => {
    load();
    return onSocket<{ tournamentId: string }>('bets:changed', (m) => m.tournamentId === tournamentId && load());
  }, [tournamentId, load]);

  if (!data || (!data.enabled && !data.headBounties.enabled)) return error ? <Notice kind="error">{error}</Notice> : null;
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
      {error && <Notice kind="error">{error}</Notice>}
      {data.enabled && (
        <Card
          title={t('bets.title')}
          actions={
            data.canCreate ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                {t('bets.create')}
              </Button>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">{t('bets.help')}</p>
            {data.bets.length === 0 && <p className="text-muted">{t('bets.empty')}</p>}
            {data.bets.map((b) => (
              <BetCard key={b.id} bet={b} data={data} meId={me?.user.id ?? ''} run={run} />
            ))}
          </div>
        </Card>
      )}
      {data.headBounties.enabled && <BountyCard data={data} meId={me?.user.id ?? ''} tournamentId={tournamentId} run={run} />}
      {creating && (
        <CreateBet
          tournamentId={tournamentId}
          data={data}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function BetCard({ bet, data, meId, run }: { bet: BetDto; data: Data; meId: string; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [side, setSide] = useState<'yes' | 'no'>('yes');
  const [amount, setAmount] = useState(String(data.limits.min));
  const total = bet.totals.yes + bet.totals.no;
  const mine = bet.mine;
  const isCreator = bet.creator?.userId === meId;
  const onlyMine = bet.stakes.every((x) => x.userId === meId);
  const first = bet.stakes[0];
  const direct = bet.kind === 'direct';
  const needsCounter = direct && bet.status === 'open' && bet.stakes.length === 1 && first!.userId !== meId;
  const odds = (s: 'yes' | 'no') => {
    const mineSide = bet.totals[s];
    return mineSide > 0 && total > mineSide ? (((total * (100 - bet.feePercent)) / 100) / mineSide).toFixed(2) : null;
  };
  const losing = bet.status === 'proposed' && mine.some((x) => x.side !== bet.proposedOutcome);
  const stake = (sd: 'yes' | 'no', amt: number) => void run(() => post(`/api/bets/${bet.id}/stake`, { side: sd, amount: amt }));

  return (
    <section className="flex flex-col gap-2 rounded-md border border-line p-3">
      <header className="flex flex-wrap items-center gap-2">
        <strong className="flex-1">{label(bet)}</strong>
        <Badge tone={bet.status === 'open' ? 'success' : bet.status === 'disputed' ? 'danger' : 'muted'}>{t(`bets.status.${bet.status}`)}</Badge>
        <Badge>{t(`bets.kind.${bet.kind}`)}</Badge>
        {bet.outcome && <Badge tone="primary">{outcomeText(bet.outcome)}</Badge>}
      </header>
      <p className="text-sm text-muted">
        {bet.creator && t('bets.by', { nick: bet.creator.nickname })} · {t('bets.pool', { yes: bet.totals.yes, no: bet.totals.no })}
        {bet.feePercent > 0 && ` · ${t('bets.fee', { n: bet.feePercent })}`}
      </p>
      {bet.status === 'open' && !direct && (odds('yes') || odds('no')) && (
        <p className="text-xs text-muted">
          {odds('yes') && t('bets.odds', { side: sideText('yes'), x: odds('yes')! })} {odds('no') && t('bets.odds', { side: sideText('no'), x: odds('no')! })}
        </p>
      )}
      {mine.length > 0 && <p className="text-sm">{t('bets.mine', { list: mine.map((x) => `${sideText(x.side)} ${x.amount}${x.payout ? ` → ${x.payout}` : ''}`).join(', ') })}</p>}
      {bet.stakes.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-muted">{t('bets.stakes')}</summary>
          <ul className="text-sm">
            {bet.stakes.map((x, i) => (
              <li key={i}>
                {x.nickname}: {sideText(x.side)} {x.amount}
                {x.payout ? ` → ${x.payout}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}

      {bet.status === 'open' && data.canStake && (
        <div className="flex flex-wrap items-end gap-2">
          {needsCounter ? (
            <Button variant="primary" onClick={() => stake(first!.side === 'yes' ? 'no' : 'yes', first!.amount)}>
              {t('bets.accept', { side: sideText(first!.side === 'yes' ? 'no' : 'yes'), amount: first!.amount })}
            </Button>
          ) : !direct ? (
            <>
              <Select label={t('bets.yourSide')} value={side} onChange={(e) => setSide(e.target.value as 'yes' | 'no')}>
                <option value="yes">{t('bets.sideYes')}</option>
                <option value="no">{t('bets.sideNo')}</option>
              </Select>
              <TextInput label={t('bets.amount')} type="number" min={data.limits.min} max={data.limits.max} value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Button variant="primary" onClick={() => stake(side, Number(amount))}>
                {t('bets.stakeButton')}
              </Button>
            </>
          ) : null}
        </div>
      )}
      {bet.status === 'open' && (isCreator || data.referee) && (
        <div className="flex flex-wrap gap-2">
          {!direct && <Button onClick={() => void run(() => post(`/api/bets/${bet.id}/close`))}>{t('bets.closeBet')}</Button>}
          {(onlyMine || data.referee) && (
            <Button
              variant="danger"
              onClick={() => {
                if (confirm(t('bets.confirmCancel'))) void run(() => post(`/api/bets/${bet.id}/cancel`));
              }}
            >
              {t('bets.cancelBet')}
            </Button>
          )}
        </div>
      )}
      {bet.subject === 'custom' && (bet.status === 'locked' || bet.status === 'open') && (isCreator || data.referee) && bet.stakes.some((x) => x.side === 'yes') && bet.stakes.some((x) => x.side === 'no') && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{t('bets.propose')}:</span>
          <Button onClick={() => void run(() => post(`/api/bets/${bet.id}/result`, { outcome: 'yes' }))}>{t('bets.proposeYes')}</Button>
          <Button onClick={() => void run(() => post(`/api/bets/${bet.id}/result`, { outcome: 'no' }))}>{t('bets.proposeNo')}</Button>
        </div>
      )}
      {bet.status === 'proposed' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{t('bets.proposed', { outcome: outcomeText(bet.proposedOutcome), hours: data.limits.disputeHours })}</span>
          {losing && (
            <>
              <Button variant="primary" onClick={() => void run(() => post(`/api/bets/${bet.id}/respond`, { accept: true }))}>
                {t('bets.confirm')}
              </Button>
              <Button variant="danger" onClick={() => void run(() => post(`/api/bets/${bet.id}/respond`, { accept: false }))}>
                {t('bets.dispute')}
              </Button>
            </>
          )}
        </div>
      )}
      {(bet.status === 'disputed' || bet.status === 'proposed') && data.referee && !bet.stakes.some((x) => x.userId === meId) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{t('bets.decide')}:</span>
          <Button onClick={() => void run(() => post(`/api/bets/${bet.id}/decide`, { outcome: 'yes' }))}>{t('bets.sideYes')}</Button>
          <Button onClick={() => void run(() => post(`/api/bets/${bet.id}/decide`, { outcome: 'no' }))}>{t('bets.sideNo')}</Button>
          <Button onClick={() => void run(() => post(`/api/bets/${bet.id}/decide`, { outcome: 'void' }))}>{t('bets.decideVoid')}</Button>
        </div>
      )}
    </section>
  );
}

function CreateBet({ tournamentId, data, onClose, onDone }: { tournamentId: string; data: Data; onClose: () => void; onDone: () => void }) {
  const [subject, setSubject] = useState('winner');
  const [userId, setUserId] = useState('');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [place, setPlace] = useState('1');
  const [text, setText] = useState('');
  const [direct, setDirect] = useState(false);
  const [close, setClose] = useState(data.limits.defaultClose);
  const [side, setSide] = useState<'yes' | 'no'>('yes');
  const [amount, setAmount] = useState(String(data.limits.min));
  const [error, setError] = useState('');
  const players = (
    <>
      <option value="">{t('bounty.pickTarget')}</option>
      {data.players.map((p) => (
        <option key={p.userId} value={p.userId}>
          {p.nickname}
        </option>
      ))}
    </>
  );
  const params = subject === 'duel' ? { a, b } : subject === 'custom' ? { text } : subject === 'place' ? { userId, place: Number(place) } : { userId };
  return (
    <Modal title={t('bets.createTitle')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <Notice kind="error">{error}</Notice>}
        <Select label={t('bets.subject')} value={subject} onChange={(e) => setSubject(e.target.value)}>
          {(['winner', 'firstOut', 'duel', 'place', ...(data.limits.customEnabled ? ['custom'] : [])] as string[]).map((s) => (
            <option key={s} value={s}>
              {t(`bets.subject.${s}`)}
            </option>
          ))}
        </Select>
        {(subject === 'winner' || subject === 'firstOut' || subject === 'place') && (
          <Select label={t('bets.player')} value={userId} onChange={(e) => setUserId(e.target.value)}>
            {players}
          </Select>
        )}
        {subject === 'place' && <TextInput label={t('bets.place')} type="number" min={1} value={place} onChange={(e) => setPlace(e.target.value)} />}
        {subject === 'duel' && (
          <>
            <Select label={t('bets.playerA')} value={a} onChange={(e) => setA(e.target.value)}>
              {players}
            </Select>
            <Select label={t('bets.playerB')} value={b} onChange={(e) => setB(e.target.value)}>
              {players}
            </Select>
          </>
        )}
        {subject === 'custom' && <TextInput label={t('bets.text')} hint={t('bets.textHint')} maxLength={200} value={text} onChange={(e) => setText(e.target.value)} />}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} />
          {t('bets.direct')}
        </label>
        <Select label={t('bets.close')} value={close} onChange={(e) => setClose(e.target.value)}>
          {['start', 'rebuyEnd', 'manual'].map((c) => (
            <option key={c} value={c}>
              {t(`bets.close.${c}`)}
            </option>
          ))}
        </Select>
        <div className="flex flex-wrap items-end gap-2">
          <Select label={t('bets.yourSide')} value={side} onChange={(e) => setSide(e.target.value as 'yes' | 'no')}>
            <option value="yes">{t('bets.sideYes')}</option>
            <option value="no">{t('bets.sideNo')}</option>
          </Select>
          <TextInput label={t('bets.amount')} type="number" min={data.limits.min} max={data.limits.max} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await post(`/api/tournaments/${tournamentId}/bets`, { subject, params, direct, close, side, amount: Number(amount) });
                onDone();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('bets.create')}
          </Button>
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Formulář pro vypsání odměny na hlavu: hledaný hráč a částka v mezích nastavených správcem. */
function BountyForm({ data, meId, tournamentId, run }: { data: Data; meId: string; tournamentId: string; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const hb = data.headBounties;
  const [target, setTarget] = useState('');
  const [amount, setAmount] = useState(String(hb.limits.min));
  return (
    <div className="flex flex-col gap-2">
      <Select label={t('bounty.target')} value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">{t('bounty.pickTarget')}</option>
        {data.players
          .filter((p) => p.userId !== meId)
          .map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.nickname}
            </option>
          ))}
      </Select>
      <TextInput label={`${t('bounty.amount')} (${hb.limits.min}–${hb.limits.max})`} type="number" min={hb.limits.min} max={hb.limits.max} value={amount} onChange={(e) => setAmount(e.target.value)} />
      <div>
        <Button variant="primary" disabled={!target} onClick={() => void run(() => post(`/api/tournaments/${tournamentId}/bounties`, { targetId: target, amount: Number(amount) }))}>
          {t('bounty.post')}
        </Button>
      </div>
    </div>
  );
}

/** Okno pro vypsání odměny na hlavu přímo od stolu (z widgetu Odměny); chyby se ukážou v okně a po úspěchu se zavře. */
export function PostBountyDialog({ tournamentId, onClose }: { tournamentId: string; onClose: () => void }) {
  const { me } = useSession();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    get<Data>(`/api/tournaments/${tournamentId}/bets`).then(setData).catch((e) => setError(errorText(e)));
  }, [tournamentId]);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal title={t('bounty.post')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('bounty.help')}</p>
        {error && (
          <p role="alert" className="rounded-md border-2 border-danger px-2 py-1 text-sm text-danger">
            {error}
          </p>
        )}
        {data && data.headBounties.enabled ? <BountyForm data={data} meId={me?.user.id ?? ''} tournamentId={tournamentId} run={run} /> : !error && <p className="text-muted">{t('app.loading')}</p>}
        <div className="flex justify-end">
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}

function BountyCard({ data, meId, tournamentId, run }: { data: Data; meId: string; tournamentId: string; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const hb = data.headBounties;
  const open = hb.bounties.filter((x) => x.status === 'open' || x.status === 'pendingWinner');
  const sums = new Map<string, number>();
  for (const x of open) sums.set(x.target.userId, (sums.get(x.target.userId) ?? 0) + x.amount);
  return (
    <Card title={t('bounty.title')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('bounty.help')}</p>
        {hb.bounties.length === 0 && <p className="text-muted">{t('bounty.empty')}</p>}
        <ul className="flex flex-col gap-1">
          {hb.bounties.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2 text-sm">
              <strong>{x.target.nickname}</strong>
              <span className="font-mono">{x.amount}</span>
              <span className="text-muted">{t('bounty.by', { nick: x.poster.nickname })}</span>
              <Badge tone={x.status === 'open' ? 'warning' : 'muted'}>{t(`bounty.status.${x.status}`)}</Badge>
              {x.status === 'open' && sums.get(x.target.userId) !== x.amount && <span className="text-xs text-muted">{t('bounty.total', { n: sums.get(x.target.userId) ?? 0 })}</span>}
            </li>
          ))}
        </ul>
        <BountyForm data={data} meId={meId} tournamentId={tournamentId} run={run} />
      </div>
    </Card>
  );
}
