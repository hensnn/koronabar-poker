import { useCallback, useEffect, useMemo, useState } from 'react';
import { t, type SettingValue, type SettingValues } from '@kb/shared';
import { errorText, get, patch, post, del } from '../api';
import { onSocket } from '../net';
import { Link, navigate } from '../router';
import { can, useSession } from '../session';
import { Badge, Button, Card, DataTable, Modal, Notice, Select, Spinner, Td, TextInput } from '../ui';
import { CreateDialog, type Template } from './lobby';

const TZ = 'Europe/Prague';
export const fmtDate = (ms: number): string => new Date(ms).toLocaleString('cs-CZ', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

// ---------- kalendář ----------

interface CalEvent {
  id: string;
  name: string;
  startAt: number;
  opensAt: number;
  registrationOpen: boolean;
  postponed: number;
  players: number;
  seats: number;
  minPlayers: number;
  buyIn: number;
  fee: number;
  registered: boolean;
  seriesId: string | null;
}

/** Nadcházející plánované turnaje s odpočtem a odkazem na export do kalendáře. */
export function CalendarPanel() {
  const [data, setData] = useState<{ events: CalEvent[]; icsUrl: string } | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => {
    get<{ events: CalEvent[]; icsUrl: string }>('/api/calendar')
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    load();
    const off = onSocket('tournament:changed', load);
    const poll = setInterval(load, 15_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      off();
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);
  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;
  return (
    <div className="flex flex-col gap-3">
      {error && <Notice kind="error">{error}</Notice>}
      {data.events.length === 0 ? (
        <Notice>{t('planning.noUpcoming')}</Notice>
      ) : (
        <DataTable head={[t('planning.when'), t('planning.tournament'), t('planning.players'), t('tournament.buyIn'), t('planning.countdown'), t('planning.registration')]}>
          {data.events.map((e) => (
            <tr key={e.id}>
              <Td>{fmtDate(e.startAt)}</Td>
              <Td>
                <Link to={`/turnaj/${e.id}`} className="underline">
                  {e.registered && '✔ '}
                  {e.name}
                </Link>{' '}
                {e.postponed > 0 && <Badge tone="warning">{t('planning.postponed', { n: e.postponed })}</Badge>}
              </Td>
              <Td className="font-mono">
                {e.players}/{e.seats} ({t('planning.min', { n: e.minPlayers })})
              </Td>
              <Td className="font-mono">
                {e.buyIn}
                {e.fee > 0 ? ` + ${e.fee}` : ''}
              </Td>
              <Td className="font-mono">{mmss(e.startAt - now)}</Td>
              <Td>{e.registrationOpen ? <Badge tone="success">{t('planning.open')}</Badge> : <span className="text-sm text-muted">{t('planning.opensIn', { time: mmss(e.opensAt - now) })}</span>}</Td>
            </tr>
          ))}
        </DataTable>
      )}
      <Card title={t('planning.ics')}>
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">{t('planning.icsHelp')}</p>
          <div className="flex flex-wrap gap-2">
            <input readOnly aria-label={t('planning.ics')} value={data.icsUrl} className="min-w-64 flex-1 rounded-sm border border-line bg-surface px-2 py-1 font-mono text-sm" onFocus={(e) => e.currentTarget.select()} />
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(data.icsUrl);
                setCopied(true);
              }}
            >
              {copied ? t('planning.copied') : t('lobby.copyLink')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ---------- plánování ----------

type Recurrence = 'once' | 'daily' | 'weekly' | 'biweekly' | 'monthlyFirst' | 'monthlyLast';

const todayIso = (): string => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const localInput = (ms: number): string => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Naplánování jednoho turnaje, nebo opakovaného plánu (každý týden, první čtvrtek v měsíci…). */
export function ScheduleDialog({ templates, onClose }: { templates: Template[]; onClose: () => void }) {
  const [rec, setRec] = useState<Recurrence>('once');
  const [at, setAt] = useState(localInput(Date.now() + 24 * 3600_000));
  const [weekday, setWeekday] = useState(5);
  const [time, setTime] = useState('20:00');

  const body = useMemo(() => {
    if (rec === 'once') return { startAt: new Date(at).getTime() };
    const from = todayIso();
    if (rec === 'daily') return { rule: { type: 'daily', time, everyDays: 1, from } };
    if (rec === 'weekly' || rec === 'biweekly') return { rule: { type: 'weekly', weekday, time, everyWeeks: rec === 'weekly' ? 1 : 2, from } };
    return { rule: { type: 'monthlyNth', weekday, nth: rec === 'monthlyFirst' ? 1 : -1, time, from } };
  }, [rec, at, weekday, time]);

  return (
    <CreateDialog
      templates={templates}
      kind="tournament"
      postPath={rec === 'once' ? '/api/tournaments/schedule' : '/api/schedules'}
      bodyExtra={body}
      title={t('planning.schedule')}
      nameLabel={t('tournament.name')}
      onClose={onClose}
      onCreated={(id) => (rec === 'once' ? navigate(`/turnaj/${id}`) : onClose())}
      extras={() => (
        <Card title={t('planning.whenTitle')}>
          <div className="flex flex-col gap-2">
            <Select label={t('planning.repeat')} value={rec} onChange={(e) => setRec(e.target.value as Recurrence)}>
              {(['once', 'daily', 'weekly', 'biweekly', 'monthlyFirst', 'monthlyLast'] as Recurrence[]).map((r) => (
                <option key={r} value={r}>
                  {t(`planning.rec.${r}`)}
                </option>
              ))}
            </Select>
            {rec === 'once' ? (
              <label className="flex flex-col text-sm">
                {t('planning.startAt')}
                <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="rounded-sm border border-line bg-surface px-2 py-1" />
              </label>
            ) : (
              <div className="flex flex-wrap gap-3">
                {rec !== 'daily' && (
                  <Select label={t('planning.weekday')} value={String(weekday)} onChange={(e) => setWeekday(Number(e.target.value))}>
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                      <option key={d} value={d}>
                        {t(`planning.day.${d}`)}
                      </option>
                    ))}
                  </Select>
                )}
                <TextInput label={t('planning.time')} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
            )}
            <p className="text-sm text-muted">{t('planning.tzNote')}</p>
          </div>
        </Card>
      )}
    />
  );
}

// ---------- série ----------

interface SeriesListItem {
  id: string;
  name: string;
  config: { finalTopN: number };
}
interface SeriesDetail {
  id: string;
  name: string;
  ownerId: string | null;
  config: { mode: string; table: number[]; participation: number; linearFactor: number; bestOf: number; finalTopN: number };
  tournaments: { id: string; name: string; startAt: number | null; status: string; players: number }[];
  standings: { userId: string; name: string; total: number; played: number; wins: number; bestPlace: number; rank: number }[];
  finalists: string[];
  finalId: string | null;
}

export function SeriesPanel({ templates }: { templates: Template[] }) {
  const { me } = useSession();
  const [list, setList] = useState<SeriesListItem[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [finalFor, setFinalFor] = useState<string | null>(null);
  const load = useCallback(() => {
    get<SeriesListItem[]>('/api/series')
      .then(setList)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!open) return setDetail(null);
    get<SeriesDetail>(`/api/series/${open}`)
      .then(setDetail)
      .catch((e) => setError(errorText(e)));
  }, [open, finalFor]);

  if (!list) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;
  const mayCreate = can(me, 'turnaj.naplanovat');
  return (
    <div className="flex flex-col gap-3">
      {error && <Notice kind="error">{error}</Notice>}
      {mayCreate && (
        <div>
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('series.create')}
          </Button>
        </div>
      )}
      {list.length === 0 && <Notice>{t('series.empty')}</Notice>}
      {list.map((s) => (
        <Card key={s.id} title={s.name}>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? t('series.hide') : t('series.standings')}</Button>
              {s.config.finalTopN > 0 && detail?.id === s.id && !detail.finalId && (detail.ownerId === me?.user.id || can(me, 'turnaj.upravit_vse')) && (
                <Button onClick={() => setFinalFor(s.id)}>{t('series.scheduleFinal', { n: s.config.finalTopN })}</Button>
              )}
              {(detail?.id === s.id ? detail.ownerId === me?.user.id : false) && (
                <Button
                  variant="danger"
                  onClick={async () => {
                    if (!confirm(t('series.deleteConfirm'))) return;
                    await del(`/api/series/${s.id}`).catch((e) => setError(errorText(e)));
                    setOpen(null);
                    load();
                  }}
                >
                  {t('series.delete')}
                </Button>
              )}
            </div>
            {open === s.id && detail?.id === s.id && (
              <>
                {detail.standings.length === 0 ? (
                  <p className="text-muted">{t('series.noResults')}</p>
                ) : (
                  <DataTable head={[t('tournament.placeShort'), t('tournament.player'), t('series.points'), t('series.played'), t('series.wins')]}>
                    {detail.standings.map((r) => (
                      <tr key={r.userId} className={detail.finalists.includes(r.userId) ? 'bg-raised' : ''}>
                        <Td className="font-mono">{r.rank}.</Td>
                        <Td>{r.name}</Td>
                        <Td className="font-mono font-medium">{r.total}</Td>
                        <Td className="font-mono">{r.played}</Td>
                        <Td className="font-mono">{r.wins}</Td>
                      </tr>
                    ))}
                  </DataTable>
                )}
                {detail.finalists.length > 0 && <p className="text-sm text-muted">{t('series.finalistsNote', { n: detail.config.finalTopN })}</p>}
                {detail.finalId && (
                  <p>
                    <Link to={`/turnaj/${detail.finalId}`} className="underline">
                      {t('series.finalLink')}
                    </Link>
                  </p>
                )}
                <h3 className="font-medium">{t('series.tournaments')}</h3>
                <ul>
                  {detail.tournaments.map((x) => (
                    <li key={x.id}>
                      <Link to={`/turnaj/${x.id}`} className="underline">
                        {x.name}
                      </Link>{' '}
                      <span className="text-sm text-muted">
                        {x.startAt ? fmtDate(x.startAt) : ''} · {t(`tournament.status.${x.status}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Card>
      ))}
      {creating && <SeriesDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
      {finalFor && <FinalDialog seriesId={finalFor} templates={templates} onClose={() => setFinalFor(null)} />}
    </div>
  );
}

function SeriesDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [table, setTable] = useState('25, 18, 15, 12, 10, 8, 6, 4, 2, 1');
  const [participation, setParticipation] = useState(1);
  const [bestOf, setBestOf] = useState(0);
  const [finalTopN, setFinalTopN] = useState(0);
  const [error, setError] = useState('');
  return (
    <Modal title={t('series.create')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <TextInput label={t('series.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        <TextInput label={t('series.table')} hint={t('series.tableHint')} value={table} onChange={(e) => setTable(e.target.value)} />
        <TextInput label={t('series.participation')} type="number" min={0} value={participation} onChange={(e) => setParticipation(Number(e.target.value))} />
        <TextInput label={t('series.bestOf')} hint={t('series.bestOfHint')} type="number" min={0} value={bestOf} onChange={(e) => setBestOf(Number(e.target.value))} />
        <TextInput label={t('series.finalTopN')} hint={t('series.finalTopNHint')} type="number" min={0} max={10} value={finalTopN} onChange={(e) => setFinalTopN(Number(e.target.value))} />
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={name.trim().length < 2}
            onClick={async () => {
              try {
                await post('/api/series', { name, config: { table: table.split(/[\s,;]+/).filter(Boolean).map(Number), participation, bestOf, finalTopN } });
                onCreated();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('lobby.createSubmit')}
          </Button>
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}

function FinalDialog({ seriesId, templates, onClose }: { seriesId: string; templates: Template[]; onClose: () => void }) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [at, setAt] = useState(localInput(Date.now() + 7 * 24 * 3600_000));
  const [error, setError] = useState('');
  return (
    <Modal title={t('series.finalTitle')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Select label={t('lobby.template')} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.map((x) => (
            <option key={x.id} value={x.id}>
              {t(x.name)}
            </option>
          ))}
        </Select>
        <label className="flex flex-col text-sm">
          {t('planning.startAt')}
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="rounded-sm border border-line bg-surface px-2 py-1" />
        </label>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const r = await post<{ id: string }>(`/api/series/${seriesId}/final`, { templateId, startAt: new Date(at).getTime() });
                onClose();
                navigate(`/turnaj/${r.id}`);
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('series.scheduleFinalSubmit')}
          </Button>
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- opakované plány ----------

interface PlanRow {
  id: string;
  name: string;
  rule: { type: string; time?: string; weekday?: number; nth?: number; everyWeeks?: number };
  enabled: boolean;
  ownerId: string | null;
}

/** Přehled opakovaných plánů s možností je vypnout. */
export function PlansPanel() {
  const { me } = useSession();
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    get<PlanRow[]>('/api/schedules')
      .then(setPlans)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  if (!plans) return null;
  if (plans.length === 0) return null;
  const describe = (r: PlanRow['rule']): string => {
    if (r.type === 'daily') return t('planning.rec.daily') + ` ${r.time}`;
    if (r.type === 'weekly') return `${r.everyWeeks === 2 ? t('planning.rec.biweekly') : t('planning.rec.weekly')}: ${t(`planning.day.${r.weekday}`)} ${r.time}`;
    if (r.type === 'monthlyNth') return `${r.nth === -1 ? t('planning.rec.monthlyLast') : t('planning.rec.monthlyFirst')}: ${t(`planning.day.${r.weekday}`)} ${r.time}`;
    return t('planning.rec.once');
  };
  return (
    <Card title={t('planning.plans')}>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="flex flex-col gap-2">
        {plans.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2">
            <strong>{p.name}</strong>
            <span className="text-sm text-muted">{describe(p.rule)}</span>
            {!p.enabled && <Badge tone="warning">{t('planning.disabled')}</Badge>}
            {(p.ownerId === me?.user.id || can(me, 'turnaj.upravit_vse')) && (
              <>
                <Button
                  onClick={async () => {
                    await patch(`/api/schedules/${p.id}`, { enabled: !p.enabled }).catch((e) => setError(errorText(e)));
                    load();
                  }}
                >
                  {p.enabled ? t('planning.disable') : t('planning.enable')}
                </Button>
                <Button
                  variant="danger"
                  onClick={async () => {
                    if (!confirm(t('planning.deleteConfirm'))) return;
                    await del(`/api/schedules/${p.id}`).catch((e) => setError(errorText(e)));
                    load();
                  }}
                >
                  {t('series.delete')}
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export type { SettingValue, SettingValues };
