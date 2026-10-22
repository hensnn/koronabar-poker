import { useCallback, useEffect, useMemo, useState } from 'react';
import { balancePercents, BP, computePayouts, defaultPercents, t, type SettingValue, type SettingValues } from '@kb/shared';
import { errorText, get, post } from '../api';
import { onSocket } from '../net';
import { Link, navigate } from '../router';
import { can, useSession } from '../session';
import { Badge, Button, Card, DataTable, Notice, Spinner, Tabs, Td } from '../ui';
import { DealPanel } from './deal';
import { SummaryTable, type TournamentSummary } from './tournament-result';
import { ShareToChat } from './chat-extras';
import { CalendarPanel, fmtDate, PlansPanel, ScheduleDialog, SeriesPanel } from './planning';
import { CreateDialog, EditDialog, type Template } from './lobby';
import { MoneyPreview, RebuyCard, StructureEditor, TournamentBasics } from './structure-editor';
import { RulesDialog } from './rules';
import { LiveDirectorPanel } from './live';
import { useAnnounceRoom } from '../announcer/host';
import { BetsPanel } from './bets';
import { useFeatures } from '../features';
import { decideText } from '../table/decide-text';

interface Summary {
  id: string;
  name: string;
  owner: string | null;
  ownerId: string | null;
  status: 'registering' | 'running' | 'finished' | 'cancelled';
  players: number;
  alive: number;
  seats: number;
  buyIn: number;
  fee: number;
  startingStack: number;
  live: boolean;
}

interface LevelDto {
  smallBlind: number;
  bigBlind: number;
  ante: number;
}

interface View {
  id: string;
  name: string;
  owner: string | null;
  ownerId: string | null;
  status: Summary['status'];
  paused: boolean;
  onBreak: boolean;
  serverTime: number;
  buyIn: number;
  fee: number;
  startingStack: number;
  seats: number;
  minPlayers: number;
  players: number;
  alive: number;
  bubble: boolean;
  levelNumber: number;
  level: LevelDto | null;
  nextLevel: LevelDto | null;
  levels: LevelDto[];
  levelMode: string;
  levelMinutes: number;
  levelHands: number;
  handsInLevel: number;
  clockKind: 'level' | 'break' | null;
  clockMs: number | null;
  lateRegLevels: number;
  lateRegOpen: boolean;
  rebuy: { enabled: boolean; untilLevel: number; cost: number; chips: number; max: number };
  addon: { enabled: boolean; fromLevel: number; untilLevel: number; cost: number; chips: number };
  reentry: { enabled: boolean; max: number };
  breakEveryLevels: number;
  breakMinutes: number;
  prizePool: number;
  fees: { fee: number; houseCutPercent: number; fundPercent: number; fundId: string; guarantee: number; collected: { pool: number; house: number; fund: number }; overlay: number };
  payouts: { place: number; amount: number }[];
  schedule: { startAt: number; opensAt: number; registrationOpen: boolean; postponed: number; seriesId: string | null; unregisterUntil: number; autoPaused: boolean; invited: string[] | null } | null;
  deal: { enabled: boolean; open: boolean; done: { method: string; keep: number } | null; blocked: string | null };
  bounty: { type: string; percent: number; pkoCash: number; payout: string; bank: number };
  standings: { userId: string; name: string; chips: number | null; seat: number | null; tableNo: number | null; place: number; status: string; payout: number | null; head: number | null; bounty: number }[];
  live: { chipsInPlay: number; avgStack: number | null; director: boolean; suggestions: { userId: string; name: string; fromNo: number; toTable: string; toNo: number; reason: 'balance' | 'break' }[] } | null;
  tables: { id: string; no: number; players: { userId: string; name: string; seat: number; chips: number }[] }[];
  maxTables: number;
  results: { userId: string; name: string; place: number; payout: number; bounty?: number }[] | null;
  summary?: TournamentSummary[] | null;
  pending: Record<string, SettingValue>;
  me: { registered: boolean; status: string | null; entries: number; rebuys: number; addon: boolean; decideUntil: number | null; tableId: string | null; canRegister: boolean; canUnregister: boolean; canRebuy: boolean; canAddon: boolean; canReenter: boolean };
  can: { manage: boolean; start: boolean; pause: boolean; cancel: boolean };
}

const STATUS_TONE = { registering: 'primary', running: 'success', finished: 'muted', cancelled: 'danger' } as const;

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const levelText = (l: LevelDto | null): string => (l ? `${l.smallBlind}/${l.bigBlind}${l.ante ? ` + ${t('tournament.ante')} ${l.ante}` : ''}` : '–');

// ---------- přehled turnajů ----------

export function TournamentsPage() {
  const { me } = useSession();
  const [data, setData] = useState<{ tournaments: Summary[]; templates: Template[] } | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [tab, setTab] = useState<'list' | 'calendar' | 'series'>('list');
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const reload = useCallback(() => {
    get<{ tournaments: Summary[]; templates: Template[] }>('/api/tournaments')
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    reload();
    const off = onSocket('tournament:changed', reload);
    const timer = setInterval(reload, 10_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [reload]);

  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;
  const list = data.tournaments.filter((x) => filter === 'all' || x.status === 'registering' || x.status === 'running');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="font-heading text-2xl font-bold">{t('tournament.title')}</h1>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={filter === 'all'} onChange={(e) => setFilter(e.target.checked ? 'all' : 'open')} />
            {t('tournament.showFinished')}
          </label>
          {can(me, 'turnaj.naplanovat') && <Button onClick={() => setScheduling(true)}>{t('planning.schedule')}</Button>}
          {can(me, 'turnaj.vytvorit') && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('tournament.create')}
            </Button>
          )}
        </div>
      </div>
      <Tabs
        tabs={[
          { id: 'list', label: t('planning.tabList') },
          { id: 'calendar', label: t('planning.tabCalendar') },
          { id: 'series', label: t('planning.tabSeries') },
        ]}
        value={tab}
        onChange={setTab}
      />
      {error && <Notice kind="error">{error}</Notice>}
      {tab === 'calendar' && (
        <>
          <CalendarPanel />
          <PlansPanel />
        </>
      )}
      {tab === 'series' && <SeriesPanel templates={data.templates} />}
      {tab === 'list' && list.length === 0 && <Notice>{t('tournament.empty')}</Notice>}
      <div className={tab === 'list' ? 'grid gap-3 sm:grid-cols-2' : 'hidden'}>
        {list.map((x) => (
          <Card key={x.id} title={x.name}>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Badge tone={STATUS_TONE[x.status]}>{t(`tournament.status.${x.status}`)}</Badge>
                <Badge tone="primary">
                  {x.status === 'running' ? `${x.alive}/${x.players}` : `${x.players}/${x.seats}`} {t('lobby.players')}
                </Badge>
                {x.live && <Badge tone="warning">{t('live.badge')}</Badge>}
              </div>
              <p>
                {t('tournament.buyIn')}: <span className="font-mono">{x.buyIn}</span>
                {x.fee > 0 && (
                  <>
                    {' '}
                    + {t('tournament.fee')} <span className="font-mono">{x.fee}</span>
                  </>
                )}{' '}
                · {t('tournament.startingStack')}: <span className="font-mono">{x.startingStack}</span>
              </p>
              {x.owner && <p className="text-sm text-muted">{t('lobby.owner', { nick: x.owner })}</p>}
              <div>
                <Button variant="primary" onClick={() => navigate(`/turnaj/${x.id}`)}>
                  {t('tournament.open')}
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
      {scheduling && (
        <ScheduleDialog
          templates={data.templates}
          onClose={() => {
            setScheduling(false);
            reload();
          }}
        />
      )}
      {creating && (
        <CreateDialog
          templates={data.templates}
          kind="tournament"
          postPath="/api/tournaments"
          title={t('tournament.create')}
          nameLabel={t('tournament.name')}
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/turnaj/${id}`)}
          top={({ values, set }) => <TournamentBasics values={values} set={set} />}
          extras={({ values, set }) => (
            <>
              {can(me, 'zivahra.rizeni') && (
                <label className="flex flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <input type="checkbox" checked={!!values['tournament.live']} onChange={(e) => set('tournament.live', e.target.checked)} />
                    {t('live.createCheckbox')}
                  </span>
                  <span className="text-sm text-muted">{t('live.createHint')}</span>
                </label>
              )}
              <StructureEditor values={values} set={set} />
              <MoneyPreview values={values} />
              <RebuyCard values={values} set={set} />
              {values['tournament.payoutPreset'] === 'custom' && <PayoutEditor values={values} set={set} />}
            </>
          )}
        />
      )}
    </div>
  );
}

// ---------- editory struktury a výplat ----------

const fmtPct = (bp: number): string => String(bp / 100);

/** Vlastní výplaty: posuvníky s dorovnáním na 100 % a zámky. Výsledek se zapíše do nastavení jako text „50,30,20“. */
function PayoutEditor({ values, set }: { values: SettingValues; set: (k: string, v: SettingValue) => void }) {
  const initial = useMemo(() => {
    const raw = String(values['tournament.payoutCustom'] ?? '');
    const nums = raw.split(/[\s,;]+/).filter(Boolean).map((x) => Math.round(Number(x) * 100));
    return nums.length && nums.every(Number.isFinite) && nums.reduce((a, b) => a + b, 0) === BP ? nums : defaultPercents(3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [pct, setPct] = useState<number[]>(initial);
  const [locked, setLocked] = useState<boolean[]>(initial.map(() => false));
  const update = (next: number[]) => {
    setPct(next);
    set('tournament.payoutCustom', next.map(fmtPct).join(','));
  };
  const resize = (n: number) => {
    const places = Math.max(1, Math.min(20, n));
    setLocked(Array.from({ length: places }, () => false));
    update(defaultPercents(places));
  };
  const pool = Number(values['tournament.buyIn']) * Number(values['table.seats']);
  const preview = useMemo(() => {
    try {
      return computePayouts(pool, pct, { roundTo: Number(values['tournament.payoutRoundTo']), remainder: values['tournament.payoutRemainder'] as 'first' | 'house' | 'spread' });
    } catch {
      return null;
    }
  }, [pool, pct, values]);
  return (
    <Card title={t('tournament.payoutEditor')}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span>{t('tournament.paidPlaces')}</span>
          <Button onClick={() => resize(pct.length - 1)} disabled={pct.length <= 1} aria-label={t('tournament.fewerPlaces')}>
            −
          </Button>
          <span className="font-mono">{pct.length}</span>
          <Button onClick={() => resize(pct.length + 1)} aria-label={t('tournament.morePlaces')}>
            +
          </Button>
        </div>
        <ul className="flex flex-col gap-1">
          {pct.map((p, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-14">{t('tournament.place', { n: i + 1 })}</span>
              <input type="range" min={0} max={BP} step={25} value={p} disabled={locked[i]} aria-label={t('tournament.place', { n: i + 1 })} className="flex-1" onChange={(e) => update(balancePercents(pct, i, Number(e.target.value), locked))} />
              <span className="w-16 text-right font-mono">{fmtPct(p)} %</span>
              <span className="w-24 text-right font-mono text-muted">{preview ? preview.amounts[i] : ''}</span>
              <label className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={locked[i]} onChange={(e) => setLocked(locked.map((x, k) => (k === i ? e.target.checked : x)))} />
                {t('tournament.lock')}
              </label>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">{t('tournament.payoutPreviewHint', { pool })}</p>
      </div>
    </Card>
  );
}

// ---------- detail turnaje ----------

export function TournamentPage({ id }: { id: string }) {
  const { me } = useSession();
  const features = useFeatures();
  useAnnounceRoom(id);
  const [view, setView] = useState<View | null>(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [rules, setRules] = useState(false);

  const load = useCallback(() => {
    get<View>(`/api/tournaments/${id}`)
      .then((v) => {
        setView(v);
        setFetchedAt(Date.now());
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(() => {
    load();
    const off = onSocket<{ id: string }>('tournament:changed', (m) => {
      if (m.id === id) load();
    });
    const poll = setInterval(load, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      off();
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [id, load]);

  if (!view) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;

  const act = async (action: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    try {
      await post(`/api/tournaments/${id}/${action}`);
      setError('');
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const startPauseVote = async () => {
    setBusy(true);
    try {
      const r = await post<{ id: string }>(`/api/tournaments/${id}/pause-vote`);
      navigate(`/ankety/${r.id}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const m = view.me;
  const remaining = view.clockMs !== null ? (view.paused ? view.clockMs : view.clockMs - (now - fetchedAt)) : null;
  const decideLeft = m.decideUntil ? m.decideUntil - view.serverTime - (now - fetchedAt) : null;
  const running = view.status === 'running';
  const canPlay = m.registered && running;
  void me;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/turnaje" className="underline">
          {t('tournament.back')}
        </Link>
        <h1 className="font-heading text-2xl font-bold">{view.name}</h1>
        <ShareToChat kind="turnaj" id={view.id} />
        <Badge tone={STATUS_TONE[view.status]}>{t(`tournament.status.${view.status}`)}</Badge>
        {view.paused && <Badge tone="warning">{t('tournament.paused')}</Badge>}
        {view.onBreak && <Badge tone="warning">{t('tournament.onBreak')}</Badge>}
        {view.bubble && <Badge tone="danger">{t('tournament.bubble')}</Badge>}
        {view.live && <Badge tone="warning">{t('live.badge')}</Badge>}
        {view.owner && <span className="text-sm text-muted">{t('lobby.owner', { nick: view.owner })}</span>}
      </div>

      {error && <Notice kind="error">{error}</Notice>}

      {m.status === 'deciding' && (
        <Notice kind="error">
          {decideText(m, decideLeft !== null ? mmss(decideLeft) : '')}
        </Notice>
      )}

      <div className="flex flex-wrap gap-2">
        {m.canRegister && (
          <Button variant="primary" disabled={busy} onClick={() => void act('register', t('tournament.confirmRegister', { cost: view.buyIn, fee: view.fee }))}>
            {t('tournament.register')} ({view.buyIn + view.fee})
          </Button>
        )}
        {m.canUnregister && (
          <Button disabled={busy} onClick={() => void act('unregister')}>
            {t('tournament.unregister')}
          </Button>
        )}
        {m.canRebuy && (
          <Button variant="primary" disabled={busy} onClick={() => void act('rebuy', t('tournament.confirmRebuy', { cost: view.rebuy.cost, chips: view.rebuy.chips }))}>
            {t('tournament.rebuy')} ({view.rebuy.cost})
          </Button>
        )}
        {m.canAddon && (
          <Button variant="primary" disabled={busy} onClick={() => void act('addon', t('tournament.confirmAddon', { cost: view.addon.cost, chips: view.addon.chips }))}>
            {t('tournament.addon')} ({view.addon.cost})
          </Button>
        )}
        {m.canReenter && (
          <Button disabled={busy} onClick={() => void act('reenter', t('tournament.confirmRegister', { cost: view.buyIn, fee: view.fee }))}>
            {t('tournament.reenter')} ({view.buyIn + view.fee})
          </Button>
        )}
        {(canPlay || running) && !view.live && (
          <Button variant={canPlay ? 'primary' : 'secondary'} onClick={() => navigate(`/stul/${m.tableId ?? view.tables[0]?.id ?? view.id}`)}>
            {canPlay ? (view.tables.length > 1 ? t('tournament.toMyTable') : t('tournament.toTable')) : t('tournament.watch')}
          </Button>
        )}
        {view.can.start && (
          <Button variant="primary" disabled={busy || view.players < view.minPlayers} onClick={() => void act('start')}>
            {t('tournament.start')}
          </Button>
        )}
        {features.polls && running && !view.paused && m.status === 'playing' && (
          <Button title={t('tournament.pauseVoteHelp')} disabled={busy} onClick={() => void startPauseVote()}>
            {t('tournament.pauseVote')}
          </Button>
        )}
        {view.can.pause && (
          <Button disabled={busy} onClick={() => void act(view.paused ? 'resume' : 'pause')}>
            {view.paused ? t('tournament.resume') : t('tournament.pause')}
          </Button>
        )}
        <Button onClick={() => setRules(true)}>{t('lobby.rules')}</Button>
        {view.can.manage && view.status !== 'finished' && view.status !== 'cancelled' && (
          <Button variant={running ? 'secondary' : 'primary'} onClick={() => setEditing(true)}>
            ✎ {t('tournament.editRules')}
          </Button>
        )}
        {view.can.cancel && (
          <Button variant="danger" disabled={busy} onClick={() => void act('cancel', t('tournament.confirmCancel'))}>
            {t('tournament.cancel')}
          </Button>
        )}
      </div>
      {view.status === 'registering' && view.players < view.minPlayers && <Notice>{t('tournament.needPlayers', { min: view.minPlayers })}</Notice>}
      {Object.keys(view.pending).length > 0 && <Notice>{t('lobby.pending', { keys: Object.keys(view.pending).join(', ') })}</Notice>}

      {view.live?.director && (
        <LiveDirectorPanel
          id={view.id}
          status={view.status}
          standings={view.standings}
          canRebuy={view.rebuy.enabled}
          canAddon={view.addon.enabled}
          canReenter={view.reentry.enabled}
          suggestions={view.live.suggestions}
          multiTable={view.tables.length > 1}
          onDone={load}
        />
      )}
      {view.live && running && (
        <Card>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            <dt className="text-muted">{t('live.avgStack')}</dt>
            <dd className="font-mono">{view.live.avgStack ?? '–'}</dd>
            <dt className="text-muted">{t('live.chipsInPlay')}</dt>
            <dd className="font-mono">{view.live.chipsInPlay}</dd>
          </dl>
          <p className="mt-2 text-sm text-muted">{t('live.noTable')}</p>
        </Card>
      )}

      {running && view.deal.enabled && <DealPanel id={view.id} canManage={view.can.manage} />}

      <div className="grid gap-3 sm:grid-cols-2">
        <Card title={t('tournament.info')}>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            <dt className="text-muted">{t('tournament.buyIn')}</dt>
            <dd className="font-mono">{view.buyIn}</dd>
            <dt className="text-muted">{t('tournament.fee')}</dt>
            <dd className="font-mono">{view.fee}</dd>
            <dt className="text-muted">{t('tournament.startingStack')}</dt>
            <dd className="font-mono">
              {view.startingStack}
            </dd>
            <dt className="text-muted">{t('tournament.playersLabel')}</dt>
            <dd className="font-mono">{running ? `${view.alive}/${view.players}` : `${view.players}/${view.seats}`}</dd>
            {view.schedule && view.status === 'registering' && (
              <>
                <dt className="text-muted">{t('planning.startsAt')}</dt>
                <dd>
                  {fmtDate(view.schedule.startAt)} {view.schedule.postponed > 0 && <Badge tone="warning">{t('planning.postponed', { n: view.schedule.postponed })}</Badge>}
                </dd>
                <dt className="text-muted">{t('planning.registration')}</dt>
                <dd>{view.schedule.registrationOpen ? t('planning.registrationUntil', { time: fmtDate(view.schedule.unregisterUntil) }) : t('planning.registrationFrom', { time: fmtDate(view.schedule.opensAt) })}</dd>
                {view.schedule.invited && (
                  <>
                    <dt className="text-muted">{t('planning.invited')}</dt>
                    <dd>{t('planning.invitedOnly', { n: view.schedule.invited.length })}</dd>
                  </>
                )}
              </>
            )}
            {view.schedule?.autoPaused && (
              <>
                <dt className="text-muted">{t('tournament.paused')}</dt>
                <dd>{t('planning.autoPaused')}</dd>
              </>
            )}
            <dt className="text-muted">{t('tournament.prizePool')}</dt>
            <dd className="font-mono">{view.prizePool}</dd>
            {view.bounty.type !== 'none' && (
              <>
                <dt className="text-muted">{t('tournament.bounty')}</dt>
                <dd>
                  {t(view.bounty.type === 'fixed' ? 'tournament.bountyInfoFixed' : view.bounty.type === 'pko' ? 'tournament.bountyInfoPko' : 'tournament.bountyInfoMystery', {
                    percent: view.bounty.percent,
                    cash: view.bounty.pkoCash,
                    payout: t(`tournament.payout.${view.bounty.payout}`),
                  })}
                </dd>
              </>
            )}
            {view.fees.guarantee > 0 && (
              <>
                <dt className="text-muted">{t('tournament.guarantee')}</dt>
                <dd className="font-mono">{view.fees.guarantee}</dd>
              </>
            )}
            {(view.fees.houseCutPercent > 0 || view.fees.fundPercent > 0 || view.fees.fee > 0) && (
              <>
                <dt className="text-muted">{t('tournament.whereMoneyGoes')}</dt>
                <dd>
                  {t('tournament.feesInfo', { house: view.fees.houseCutPercent, fund: view.fees.fundPercent, fundName: view.fees.fundId, fee: view.fees.fee })}
                </dd>
              </>
            )}
            {view.results && view.fees.overlay > 0 && (
              <>
                <dt className="text-muted">{t('tournament.overlay')}</dt>
                <dd className="font-mono">{view.fees.overlay}</dd>
              </>
            )}
            {view.rebuy.enabled && (
              <>
                <dt className="text-muted">{t('tournament.rebuy')}</dt>
                <dd>{t('tournament.rebuyInfo', { cost: view.rebuy.cost, chips: view.rebuy.chips, level: view.rebuy.untilLevel, max: view.rebuy.max })}</dd>
              </>
            )}
            {view.addon.enabled && (
              <>
                <dt className="text-muted">{t('tournament.addon')}</dt>
                <dd>{t('tournament.addonInfo', { cost: view.addon.cost, chips: view.addon.chips, from: view.addon.fromLevel, to: view.addon.untilLevel })}</dd>
              </>
            )}
            {view.reentry.enabled && (
              <>
                <dt className="text-muted">{t('tournament.reenter')}</dt>
                <dd>{t('tournament.reentryInfo', { max: view.reentry.max })}</dd>
              </>
            )}
            {view.lateRegLevels > 0 && (
              <>
                <dt className="text-muted">{t('tournament.lateReg')}</dt>
                <dd>{view.lateRegOpen || view.status === 'registering' ? t('tournament.lateRegUntil', { level: view.lateRegLevels }) : t('tournament.lateRegClosed')}</dd>
              </>
            )}
          </dl>
        </Card>

        <Card title={t('tournament.clock')}>
          <div className="flex flex-col gap-1">
            <p className="text-lg">
              {t('tournament.level', { n: view.levelNumber })}: <strong className="font-mono">{levelText(view.level ?? view.levels[0] ?? null)}</strong>
            </p>
            {running && remaining !== null && (
              <p className="font-mono text-3xl" role="timer" aria-label={view.clockKind === 'break' ? t('tournament.breakLeft') : t('tournament.levelLeft')}>
                {mmss(remaining)}
                <span className="ml-2 text-base text-muted">{view.clockKind === 'break' ? t('tournament.breakLeft') : t('tournament.levelLeft')}</span>
              </p>
            )}
            {running && view.levelMode === 'hands' && view.clockKind !== 'break' && (
              <p className="font-mono text-xl">
                {view.handsInLevel}/{view.levelHands} {t('tournament.hands')}
              </p>
            )}
            {view.nextLevel && (
              <p className="text-muted">
                {t('tournament.next')}: <span className="font-mono">{levelText(view.nextLevel)}</span>
              </p>
            )}
            {view.status === 'registering' && <p className="text-muted">{view.levelMode === 'hands' ? t('tournament.levelEveryHands', { n: view.levelHands }) : t('tournament.levelEvery', { minutes: view.levelMinutes })}</p>}
            {view.breakEveryLevels > 0 && <p className="text-sm text-muted">{t('tournament.breakInfo', { every: view.breakEveryLevels, minutes: view.breakMinutes })}</p>}
          </div>
        </Card>
      </div>

      {view.tables.length > 1 && running && !view.live && (
        <Card title={t('tournament.tablesTitle')}>
          <p className="mb-2 text-sm text-muted">{t('tournament.tablesHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {view.tables.map((tb) => (
              <section key={tb.id} className={`rounded-md border p-3 ${tb.id === m.tableId ? 'border-primary' : 'border-line'}`}>
                <header className="mb-1 flex items-center gap-2">
                  <strong>{t('tournament.tableCard', { n: tb.no })}</strong>
                  {tb.id === m.tableId && <Badge tone="primary">{t('tournament.myTable')}</Badge>}
                  <Button className="ml-auto" onClick={() => navigate(`/stul/${tb.id}`)}>
                    {t('tournament.watchTable')}
                  </Button>
                </header>
                <ul className="flex flex-col gap-0.5 text-sm">
                  {tb.players.map((p) => (
                    <li key={p.userId} className="flex justify-between gap-2">
                      <span>
                        {p.seat}. {p.name}
                      </span>
                      <span className="font-mono">{p.chips}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className={view.results && view.summary && view.summary.length > 0 ? 'sm:col-span-2' : ''}>
        <Card title={view.results ? t('tournament.results') : t('tournament.standings')}>
          {view.results && view.summary && view.summary.length > 0 ? (
            <>
              <SummaryTable summary={view.summary} meId={me?.user.id} />
              <p className="mt-2">
                <a className="rounded-md border border-line bg-surface px-3 py-1 text-sm" href={`/api/tournaments/${view.id}/export.csv`}>
                  {t('tournament.exportCsv')}
                </a>
              </p>
              <p className="mt-2 text-xs text-muted">{t('tournament.resultNote')}</p>
            </>
          ) : view.standings.length === 0 ? (
            <p className="text-muted">{t('tournament.noPlayers')}</p>
          ) : (
            <DataTable head={[t('tournament.placeShort'), t('tournament.player'), view.status === 'running' ? (view.live ? t('live.seat') : t('table.chipsShort')) : '', ...(view.bounty.type !== 'none' ? [view.bounty.type === 'mystery' ? t('tournament.bountyEarned') : t('tournament.head'), ...(view.bounty.type !== 'mystery' ? [t('tournament.bountyEarned')] : [])] : []), view.results ? t('tournament.won') : t('tournament.statusCol')]}>
              {view.standings.map((p) => (
                <tr key={p.userId}>
                  <Td className="font-mono">{view.status === 'registering' ? '' : `${p.place}.`}</Td>
                  <Td>{p.name}</Td>
                  <Td className="font-mono">{view.live ? (p.seat !== null && p.status !== 'out' ? p.seat + 1 : '') : (p.chips ?? '')}</Td>
                  {view.bounty.type === 'fixed' || view.bounty.type === 'pko' ? <Td className="font-mono">{p.head ?? ''}</Td> : null}
                  {view.bounty.type !== 'none' ? <Td className="font-mono">{p.bounty || ''}</Td> : null}
                  <Td className="font-mono">{view.results ? (p.payout ?? 0) : t(`tournament.player.${p.status}`)}</Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Card>
        </div>
        <Card title={t('tournament.payouts')}>
          {view.payouts.length === 0 ? (
            <p className="text-muted">{t('tournament.noPayouts')}</p>
          ) : (
            <DataTable sortable={false} head={[t('tournament.placeShort'), t('tournament.amount')]}>
              {view.payouts.map((p) => (
                <tr key={p.place}>
                  <Td className="font-mono">{p.place}.</Td>
                  <Td className="font-mono">{p.amount}</Td>
                </tr>
              ))}
            </DataTable>
          )}
          <p className="mt-2 text-sm text-muted">{t('tournament.payoutNote')}</p>
        </Card>
      </div>

      {features.bets && <BetsPanel tournamentId={view.id} />}

      <Card title={t('tournament.structure')}>
        <details>
          <summary className="cursor-pointer">{t('tournament.levelsCount', { n: view.levels.length })}</summary>
          <DataTable sortable={false} head={[t('tournament.levelCol'), t('lobby.blinds'), t('tournament.ante')]}>
            {view.levels.map((l, i) => (
              <tr key={i} className={i + 1 === view.levelNumber && running ? 'bg-raised' : ''}>
                <Td className="font-mono">{i + 1}</Td>
                <Td className="font-mono">
                  {l.smallBlind}/{l.bigBlind}
                </Td>
                <Td className="font-mono">{l.ante || '–'}</Td>
              </tr>
            ))}
          </DataTable>
        </details>
      </Card>

      {rules && <RulesDialog detailsPath={`/api/tournaments/${view.id}/details`} kind="tournament" onClose={() => setRules(false)} />}
      {editing && (
        <EditDialog
          tableId={view.id}
          kind="tournament"
          basePath="/api/tournaments"
          top={({ values, set }) => <TournamentBasics values={values} set={set} />}
          extras={({ values, set }) => (
            <>
              <StructureEditor values={values} set={set} />
              <MoneyPreview values={values} />
              <RebuyCard values={values} set={set} />
            </>
          )}
          onClose={() => {
            setEditing(false);
            load();
          }}
        />
      )}
    </div>
  );
}
