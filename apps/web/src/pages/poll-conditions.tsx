import { useEffect, useState } from 'react';
import { LEAF_TYPES, t, type LeafType, type PollCondition, type PollGroup, type PollLeaf } from '@kb/shared';
import { get, post } from '../api';
import { useChatStore } from '../chat-store';
import { Button, Select, TextInput } from '../ui';

interface Dir {
  id: string;
  nickname: string;
}
interface Pickers {
  users: Dir[];
  tables: { id: string; name: string }[];
  tournaments: { id: string; name: string }[];
  channels: { id: string; name: string }[];
}

let cache: Pickers | null = null;

/** Seznamy pro výběr konkrétních hráčů, stolů, turnajů a kanálů v podmínkách. */
function usePickers(): Pickers {
  const [p, setP] = useState<Pickers>(cache ?? { users: [], tables: [], tournaments: [], channels: [] });
  const { channels } = useChatStore();
  useEffect(() => {
    if (cache) return;
    Promise.all([
      get<Dir[]>('/api/directory').catch(() => []),
      get<{ tables: { id: string; name: string }[] }>('/api/lobby').catch(() => ({ tables: [] })),
      get<{ tournaments: { id: string; name: string }[] }>('/api/tournaments').catch(() => ({ tournaments: [] })),
    ]).then(([users, lobby, trn]) => {
      cache = { users, tables: lobby.tables, tournaments: trn.tournaments, channels: [] };
      setP(cache);
    });
  }, []);
  return { ...p, channels: channels.filter((c) => c.kind !== 'table').map((c) => ({ id: c.id, name: c.name })) };
}

const num = (v: string): number | undefined => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

function NumberField({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  return <TextInput label={label} type="number" value={value ?? ''} onChange={(e) => onChange(num(e.target.value))} />;
}

function LeafFields({ leaf, onChange }: { leaf: PollLeaf; onChange: (l: PollLeaf) => void }) {
  const pick = usePickers();
  const set = (patch: Partial<PollLeaf>) => onChange({ ...leaf, ...patch });
  const idSelect = (items: { id: string; name: string }[]) => (
    <Select label={t('polls.cond.pickOne')} value={leaf.id ?? ''} onChange={(e) => set({ id: e.target.value || undefined })}>
      <option value="">–</option>
      {items.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
        </option>
      ))}
    </Select>
  );
  const keys = (label: string) => <TextInput label={label} hint={t('polls.cond.commaHint')} value={(leaf.keys ?? []).join(', ')} onChange={(e) => set({ keys: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />;
  const range = (a = t('polls.cond.min'), b = t('polls.cond.max')) => (
    <div className="grid grid-cols-2 gap-2">
      <NumberField label={a} value={leaf.min} onChange={(min) => set({ min })} />
      <NumberField label={b} value={leaf.max} onChange={(max) => set({ max })} />
    </div>
  );
  switch (leaf.type) {
    case 'online':
      return null;
    case 'atTable':
      return idSelect(pick.tables);
    case 'inTournament':
      return (
        <>
          {idSelect(pick.tournaments)}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!leaf.aliveOnly} onChange={(e) => set({ aliveOnly: e.target.checked })} />
            {t('polls.cond.aliveOnly')}
          </label>
        </>
      );
    case 'registered':
      return idSelect(pick.tournaments);
    case 'inChannel':
      return idSelect(pick.channels);
    case 'role':
      return keys(t('polls.cond.roleKeys'));
    case 'rank':
      return keys(t('polls.cond.rankNames'));
    case 'division':
      return keys(t('polls.cond.divisionNames'));
    case 'minPower':
      return <NumberField label={t('polls.cond.minPower')} value={leaf.min} onChange={(min) => set({ min })} />;
    case 'level':
    case 'accountAge':
    case 'wins':
    case 'balance':
      return range();
    case 'rating':
      return (
        <>
          <Select label={t('polls.cond.ratingScope')} value={leaf.scope ?? 'tournament'} onChange={(e) => set({ scope: e.target.value as 'tournament' | 'cash' })}>
            <option value="tournament">{t('rating.tournament')}</option>
            <option value="cash">{t('rating.cash')}</option>
          </Select>
          {range()}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!leaf.notProvisional} onChange={(e) => set({ notProvisional: e.target.checked })} />
            {t('polls.cond.notProvisional')}
          </label>
        </>
      );
    case 'activity':
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Select label={t('polls.cond.metric')} value={leaf.metric ?? 'hands'} onChange={(e) => set({ metric: e.target.value as 'hands' | 'games' })}>
              <option value="hands">{t('polls.cond.hands')}</option>
              <option value="games">{t('polls.cond.games')}</option>
            </Select>
            <Select label={t('polls.cond.period')} value={leaf.period ?? 'total'} onChange={(e) => set({ period: e.target.value as 'total' | 'season' | 'days' })}>
              <option value="total">{t('polls.cond.periodTotal')}</option>
              <option value="season">{t('polls.cond.periodSeason')}</option>
              <option value="days">{t('polls.cond.periodDays')}</option>
            </Select>
          </div>
          {leaf.period === 'days' && <NumberField label={t('polls.cond.days')} value={leaf.days} onChange={(days) => set({ days })} />}
          {range()}
        </>
      );
    case 'lastActive':
      return <NumberField label={t('polls.cond.withinDays')} value={leaf.days} onChange={(days) => set({ days })} />;
    case 'series':
      return <TextInput label={t('polls.cond.seriesId')} hint={t('polls.cond.seriesHint')} value={leaf.id ?? ''} onChange={(e) => set({ id: e.target.value || undefined })} />;
    case 'leaderboardTop':
      return <NumberField label={t('polls.cond.topN')} value={leaf.max} onChange={(max) => set({ max })} />;
    case 'players':
      return (
        <fieldset className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-sm border border-line p-2">
          <legend className="text-sm">{t('polls.cond.players')}</legend>
          {pick.users.map((u) => (
            <label key={u.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={(leaf.keys ?? []).includes(u.id)}
                onChange={(e) => set({ keys: e.target.checked ? [...(leaf.keys ?? []), u.id] : (leaf.keys ?? []).filter((x) => x !== u.id) })}
              />
              {u.nickname}
            </label>
          ))}
        </fieldset>
      );
  }
}

const emptyLeaf = (type: LeafType): PollLeaf => ({ type });

/** Skládací editor podmínek: skupiny „všechny / alespoň jedna“, negace „kromě“ a jednotlivé podmínky. */
export function ConditionEditor({ value, onChange, onRemove, depth = 0 }: { value: PollCondition; onChange: (v: PollCondition) => void; onRemove?: () => void; depth?: number }) {
  if (value.type === 'group') {
    const g = value as PollGroup;
    const setChild = (i: number, c: PollCondition) => onChange({ ...g, children: g.children.map((x, j) => (j === i ? c : x)) });
    return (
      <div className={`flex flex-col gap-2 rounded-md border border-line p-2 ${depth > 0 ? 'bg-raised' : ''}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Select label={t('polls.cond.groupMode')} value={g.mode} onChange={(e) => onChange({ ...g, mode: e.target.value as 'all' | 'any' })}>
            <option value="all">{t('polls.cond.modeAll')}</option>
            <option value="any">{t('polls.cond.modeAny')}</option>
          </Select>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!g.not} onChange={(e) => onChange({ ...g, not: e.target.checked })} />
            {t('polls.cond.not')}
          </label>
          {onRemove && (
            <Button variant="danger" onClick={onRemove}>
              {t('polls.cond.remove')}
            </Button>
          )}
        </div>
        {g.children.length === 0 && <p className="text-sm text-muted">{g.mode === 'all' ? t('polls.cond.emptyAll') : t('polls.cond.emptyAny')}</p>}
        {g.children.map((c, i) => (
          <ConditionEditor key={i} value={c} depth={depth + 1} onChange={(v) => setChild(i, v)} onRemove={() => onChange({ ...g, children: g.children.filter((_, j) => j !== i) })} />
        ))}
        <div className="flex flex-wrap items-end gap-2">
          <AddLeaf onAdd={(type) => onChange({ ...g, children: [...g.children, emptyLeaf(type)] })} />
          {depth < 4 && (
            <Button onClick={() => onChange({ ...g, children: [...g.children, { type: 'group', mode: 'any', children: [] }] })}>{t('polls.cond.addGroup')}</Button>
          )}
        </div>
      </div>
    );
  }
  const leaf = value as PollLeaf;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-2">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{t(`polls.cond.type.${leaf.type}`)}</strong>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!leaf.not} onChange={(e) => onChange({ ...leaf, not: e.target.checked })} />
          {t('polls.cond.not')}
        </label>
        {onRemove && <Button onClick={onRemove}>{t('polls.cond.remove')}</Button>}
      </div>
      <LeafFields leaf={leaf} onChange={onChange} />
    </div>
  );
}

function AddLeaf({ onAdd }: { onAdd: (t: LeafType) => void }) {
  const [type, setType] = useState<LeafType>('online');
  return (
    <>
      <Select label={t('polls.cond.add')} value={type} onChange={(e) => setType(e.target.value as LeafType)}>
        {LEAF_TYPES.map((x) => (
          <option key={x} value={x}>
            {t(`polls.cond.type.${x}`)}
          </option>
        ))}
      </Select>
      <Button onClick={() => onAdd(type)}>{t('polls.cond.addLeaf')}</Button>
    </>
  );
}

/** Živý počet a seznam hráčů, kteří podmínky teď splňují. */
export function EligiblePreview({ condition }: { condition: PollCondition }) {
  const [res, setRes] = useState<{ count: number; players: Dir[] } | null>(null);
  const [err, setErr] = useState(false);
  const key = JSON.stringify(condition);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      post<{ count: number; players: { userId: string; nickname: string }[] }>('/api/polls/preview', { condition })
        .then((r) => {
          setRes({ count: r.count, players: r.players.map((p) => ({ id: p.userId, nickname: p.nickname })) });
          setErr(false);
        })
        .catch(() => setErr(true));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [key]);
  if (err) return <p className="text-sm text-danger">{t('polls.cond.invalid')}</p>;
  if (!res) return null;
  return (
    <div role="status" className="text-sm">
      <strong>{t('polls.cond.eligibleNow', { n: res.count })}</strong>
      {res.count > 0 && <span className="text-muted">: {res.players.map((p) => p.nickname).join(', ')}{res.count > res.players.length ? '…' : ''}</span>}
    </div>
  );
}
