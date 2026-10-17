import { useCallback, useEffect, useState } from 'react';
import { HAND_RANKS, CONDITION_TYPES, t } from '@kb/shared';
import { del, errorText, get, patch, post } from '../api';
import { onSocket } from '../net';
import { can, useSession } from '../session';
import { Badge, Button, Card, DataTable, Modal, Notice, Select, Td, TextInput } from '../ui';

interface Cond {
  type: string;
  value: number;
  rank?: string;
}
export interface Ach {
  key: string;
  name: string;
  icon: string;
  description: string;
  condition: Cond;
  xp: number;
  builtin: boolean;
  enabled: boolean;
  earned: boolean;
  earnedAt: number | null;
  holders?: number;
}

/** Vitrína úspěchů hráče: získané zvýrazněné, ostatní zešedlé s popisem podmínky. */
export function AchievementShowcase() {
  const [list, setList] = useState<Ach[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    get<{ achievements: Ach[] }>('/api/achievements')
      .then((d) => setList(d.achievements))
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    load();
    return onSocket('progress:achievement', load);
  }, [load]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!list) return null;
  const got = list.filter((a) => a.earned).length;
  return (
    <Card title={`${t('achievements.title')} (${t('achievements.earned', { a: got, b: list.length })})`}>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((a) => (
          <li key={a.key} className={`flex items-start gap-3 rounded-md border px-3 py-2 ${a.earned ? 'border-primary bg-raised' : 'border-line opacity-60'}`}>
            <span className="text-3xl" aria-hidden>
              {a.earned ? a.icon : '🔒'}
            </span>
            <div className="flex flex-col">
              <strong>{a.name}</strong>
              <span className="text-sm text-muted">{a.description}</span>
              <span className="text-xs text-muted">{a.earned ? new Date(a.earnedAt!).toLocaleDateString('cs-CZ') : t('achievements.reward', { n: a.xp })}</span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function EditDialog({ item, onClose, onDone }: { item: Ach | null; onClose: () => void; onDone: () => void }) {
  const builtin = item?.builtin ?? false;
  const [key, setKey] = useState(item?.key ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [icon, setIcon] = useState(item?.icon ?? '⭐');
  const [description, setDescription] = useState(item?.description ?? '');
  const [xp, setXp] = useState(String(item?.xp ?? 20));
  const [type, setType] = useState(item?.condition.type ?? 'handsPlayed');
  const [value, setValue] = useState(String(item?.condition.value ?? 10));
  const [rank, setRank] = useState(item?.condition.rank ?? 'quads');
  const [error, setError] = useState('');
  const save = async () => {
    const body = { name, icon, description, xp: Number(xp), condition: type === 'handRank' ? { type, value: 1, rank } : { type, value: Number(value) } };
    try {
      if (item) await patch(`/api/achievements/${item.key}`, body);
      else await post('/api/achievements', { ...body, key });
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal title={item ? t('achievements.edit') : t('achievements.add')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {!item && <TextInput label={t('achievements.key')} hint={t('achievements.keyHint')} value={key} maxLength={30} onChange={(e) => setKey(e.target.value.toLowerCase())} />}
        <div className="grid gap-2 sm:grid-cols-2">
          <TextInput label={t('achievements.name')} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <TextInput label={t('achievements.icon')} value={icon} maxLength={8} onChange={(e) => setIcon(e.target.value)} />
        </div>
        <TextInput label={t('achievements.description')} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
        <TextInput label={t('achievements.xp')} type="number" min={0} value={xp} onChange={(e) => setXp(e.target.value)} />
        {!builtin && (
          <>
            <Select label={t('achievements.condition')} value={type} onChange={(e) => setType(e.target.value)}>
              {CONDITION_TYPES.map((c) => (
                <option key={c} value={c}>
                  {t(`achievements.cond.${c}`)}
                </option>
              ))}
            </Select>
            {type === 'handRank' ? (
              <Select label={t('achievements.rank')} value={rank} onChange={(e) => setRank(e.target.value)}>
                {HAND_RANKS.map((r) => (
                  <option key={r} value={r}>
                    {t(`achievements.rank.${r}`)}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput label={t('achievements.value')} type="number" min={1} value={value} onChange={(e) => setValue(e.target.value)} />
            )}
          </>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('table.cancel')}</Button>
          <Button variant="primary" onClick={() => void save()}>
            {t('achievements.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Správa katalogu úspěchů (jen s oprávněním `statistiky.uspechy`). */
export function AchievementAdmin() {
  const { me } = useSession();
  const [list, setList] = useState<Ach[]>([]);
  const [edit, setEdit] = useState<Ach | 'new' | null>(null);
  const [error, setError] = useState('');
  const allowed = can(me, 'statistiky.uspechy');
  const load = useCallback(() => {
    if (!allowed) return;
    get<{ achievements: Ach[] }>('/api/achievements/all')
      .then((d) => setList(d.achievements))
      .catch((e) => setError(errorText(e)));
  }, [allowed]);
  useEffect(load, [load]);
  if (!allowed) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Card
      title={t('achievements.manage')}
      actions={
        <Button variant="primary" onClick={() => setEdit('new')}>
          {t('achievements.add')}
        </Button>
      }
    >
      {error && <Notice kind="error">{error}</Notice>}
      <DataTable head={[t('achievements.name'), t('achievements.condition'), t('achievements.xp'), t('achievements.holders', { n: '' }).replace(/:?\s*$/, ''), '']}>
        {list.map((a) => (
          <tr key={a.key} className={a.enabled ? '' : 'opacity-60'}>
            <Td>
              {a.icon} {a.name} <Badge>{a.builtin ? t('achievements.builtin') : t('achievements.custom')}</Badge>
            </Td>
            <Td className="text-sm">
              {t(`achievements.cond.${a.condition.type}`)} {a.condition.type === 'handRank' ? t(`achievements.rank.${a.condition.rank}`) : a.condition.value}
            </Td>
            <Td className="font-mono">{a.xp}</Td>
            <Td className="font-mono">{a.holders ?? 0}</Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                <Button onClick={() => setEdit(a)}>{t('achievements.edit')}</Button>
                <Button aria-pressed={a.enabled} onClick={() => run(() => patch(`/api/achievements/${a.key}`, { enabled: !a.enabled }))}>
                  {a.enabled ? t('achievements.enabled') : '–'}
                </Button>
                {!a.builtin && (
                  <Button variant="danger" onClick={() => confirm(t('achievements.deleteConfirm', { name: a.name })) && void run(() => del(`/api/achievements/${a.key}`))}>
                    {t('achievements.delete')}
                  </Button>
                )}
              </div>
            </Td>
          </tr>
        ))}
      </DataTable>
      {edit && <EditDialog item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={load} />}
    </Card>
  );
}
