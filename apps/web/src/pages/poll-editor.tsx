import { useEffect, useState } from 'react';
import { EVERYONE, t, type PollCondition } from '@kb/shared';
import { del, errorText, get, post } from '../api';
import { useChatStore } from '../chat-store';
import { can, useSession } from '../session';
import { useSettings } from '../settings';
import { Button, Modal, Notice, Select, TextArea, TextInput } from '../ui';
import { ConditionEditor, EligiblePreview } from './poll-conditions';

type PType = 'yesno' | 'single' | 'multi' | 'ranked' | 'rating' | 'schedule' | 'text';
const TYPES: PType[] = ['yesno', 'single', 'multi', 'ranked', 'rating', 'schedule', 'text'];

interface Draft {
  title: string;
  description: string;
  type: PType;
  options: { label: string; emoji: string; at: string; value: string }[];
  minChoices: string;
  maxChoices: string;
  ratingMax: string;
  allowAddOptions: boolean;
  threshold: string;
  percent: string;
  quorumKind: 'none' | 'count' | 'percent';
  quorumValue: string;
  nonVoters: string;
  tie: string;
  anonymity: string;
  results: string;
  weightMode: string;
  weightStep: string;
  weightTable: string;
  weightCap: string;
  allowChange: boolean;
  eligibility: string;
  duration: string;
  channel: string;
  condition: PollCondition;
  pinned: boolean;
  actionKind: string;
  actionConfirm: boolean;
  actionName: string;
  actionTemplate: string;
  actionGameKind: string;
  actionGameId: string;
  actionSettings: string;
  actionSettingKey: string;
  actionRole: string;
  actionUser: string;
}

type ActionKind = 'scheduleTournament' | 'useTemplate' | 'changeSettings' | 'pauseGame' | 'endGame' | 'assignRole';
const ACTIONS_BY_TYPE: Record<string, ActionKind[]> = {
  yesno: ['useTemplate', 'changeSettings', 'pauseGame', 'endGame', 'assignRole'],
  single: ['scheduleTournament', 'useTemplate', 'changeSettings', 'assignRole'],
  schedule: ['scheduleTournament'],
};
/** Akce, u kterých každá možnost nese vlastní hodnotu (šablona, hráč, hodnota nastavení). */
const optionValueKind = (type: string, action: string): 'template' | 'user' | 'setting' | null =>
  type !== 'single' ? null : action === 'useTemplate' ? 'template' : action === 'assignRole' ? 'user' : action === 'changeSettings' ? 'setting' : null;
const parseSettings = (text: string): Record<string, unknown> =>
  Object.fromEntries(
    text
      .split(',')
      .map((p) => p.split('=').map((x) => x.trim()))
      .filter(([k, v]) => k && v !== undefined && v !== '')
      .map(([k, v]) => [k!, /^-?\d+(\.\d+)?$/.test(v!) ? Number(v) : v === 'true' || v === 'false' ? v === 'true' : v]),
  );

function actionBody(d: Draft): Record<string, unknown> | null {
  if (!d.actionKind) return null;
  const params: Record<string, unknown> = {};
  switch (d.actionKind as ActionKind) {
    case 'scheduleTournament':
      Object.assign(params, { name: d.actionName, templateId: d.actionTemplate });
      break;
    case 'useTemplate':
      Object.assign(params, { name: d.actionName }, d.type === 'yesno' ? { templateId: d.actionTemplate } : {});
      break;
    case 'changeSettings':
      Object.assign(params, { gameKind: d.actionGameKind, id: d.actionGameId }, d.type === 'single' ? { settingKey: d.actionSettingKey } : { settings: parseSettings(d.actionSettings) });
      break;
    case 'pauseGame':
      params.tournamentId = d.actionGameId;
      break;
    case 'endGame':
      Object.assign(params, { gameKind: d.actionGameKind, id: d.actionGameId });
      break;
    case 'assignRole':
      Object.assign(params, { roleKey: d.actionRole }, d.type === 'yesno' ? { userId: d.actionUser } : {});
      break;
  }
  return { kind: d.actionKind, requireConfirm: d.actionConfirm, params };
}

interface TemplateRow {
  id: string;
  name: string;
  data: Record<string, unknown>;
}

const parseTable = (s: string): Record<string, number> => Object.fromEntries(s.split(',').map((p) => p.split('=').map((x) => x.trim())).filter(([k, v]) => k && Number(v) > 0).map(([k, v]) => [k!, Number(v)]));

function body(d: Draft) {
  const needsOptions = !['yesno', 'text'].includes(d.type);
  const config: Record<string, unknown> = {
    type: d.type,
    options: needsOptions
      ? d.options.filter((o) => o.label.trim()).map((o) => ({ label: o.label.trim(), ...(o.emoji.trim() ? { emoji: o.emoji.trim() } : {}), ...(o.at ? { at: new Date(o.at).getTime() } : {}), ...(o.value.trim() ? { value: o.value.trim() } : {}) }))
      : [],
    threshold: { kind: d.threshold, ...(d.threshold === 'percent' ? { percent: Number(d.percent) } : {}) },
    quorum: d.quorumKind === 'none' ? { kind: 'none' } : { kind: d.quorumKind, value: Number(d.quorumValue) },
    nonVoters: d.nonVoters,
    tie: d.tie,
    anonymity: d.anonymity,
    weights: { mode: d.weightMode, ...(d.weightMode === 'byLevel' ? { step: Number(d.weightStep) } : {}), ...(d.weightMode === 'byRole' ? { table: parseTable(d.weightTable) } : {}), ...(d.weightCap ? { cap: Number(d.weightCap) } : {}) },
    allowChange: d.allowChange,
    earlyClose: true,
    allowAddOptions: needsOptions && d.allowAddOptions,
  };
  if (d.type === 'multi') {
    config.minChoices = Number(d.minChoices) || 1;
    config.maxChoices = Number(d.maxChoices) || d.options.length;
  }
  if (d.type === 'rating') config.ratingMax = Number(d.ratingMax) || 5;
  return {
    title: d.title,
    description: d.description,
    config,
    condition: d.condition,
    eligibility: d.eligibility,
    durationMinutes: Number(d.duration),
    results: d.results,
    pinned: d.pinned,
    target: d.channel ? { kind: 'channel', id: d.channel } : { kind: 'global' },
    action: actionBody(d),
  };
}

/** Editor ankety: otázka, typ a možnosti, pravidla vyhodnocení, tajnost, váhy, okruh hlasujících a živý náhled oprávněných. */
export function PollEditor({ onClose, onCreated, table }: { onClose: () => void; onCreated: (id: string) => void; table?: { id: string } }) {
  const settings = useSettings();
  const v = settings.values;
  const { channels } = useChatStore();
  const [d, setD] = useState<Draft>({
    title: '',
    description: '',
    type: 'yesno',
    options: [{ label: '', emoji: '', at: '', value: '' }, { label: '', emoji: '', at: '', value: '' }],
    minChoices: '1',
    maxChoices: '',
    ratingMax: '5',
    allowAddOptions: false,
    threshold: String(v['poll.defaultThreshold']),
    percent: '60',
    quorumKind: 'none',
    quorumValue: '3',
    nonVoters: String(v['poll.defaultNonVoters']),
    tie: String(v['poll.defaultTie']),
    anonymity: String(v['poll.defaultAnonymity']),
    results: String(v['poll.defaultResults']),
    weightMode: 'equal',
    weightStep: '5',
    weightTable: '',
    weightCap: '',
    allowChange: !!v['poll.defaultAllowChange'],
    eligibility: String(v['poll.defaultEligibility']),
    duration: String(v['poll.defaultDurationMinutes']),
    channel: '',
    condition: table ? { type: 'atTable', id: table.id } : EVERYONE,
    pinned: false,
    actionKind: '',
    actionConfirm: true,
    actionName: '',
    actionTemplate: '',
    actionGameKind: 'table',
    actionGameId: '',
    actionSettings: '',
    actionSettingKey: '',
    actionRole: '',
    actionUser: '',
  });
  const { me } = useSession();
  const canAction = can(me, 'anketa.akce') && !!ACTIONS_BY_TYPE[d.type];
  const [lists, setLists] = useState<{ cash: { id: string; name: string }[]; tournament: { id: string; name: string }[]; users: { id: string; nickname: string }[] }>({ cash: [], tournament: [], users: [] });
  useEffect(() => {
    if (!can(me, 'anketa.akce')) return;
    Promise.all([
      get<{ templates: { id: string; name: string }[] }>('/api/lobby').catch(() => ({ templates: [] })),
      get<{ templates: { id: string; name: string }[] }>('/api/tournaments').catch(() => ({ templates: [] })),
      get<{ id: string; nickname: string }[]>('/api/directory').catch(() => []),
    ]).then(([a, b, u]) => setLists({ cash: a.templates, tournament: b.templates, users: u }));
  }, [me]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));
  const loadTemplates = () => get<{ templates: TemplateRow[] }>('/api/poll-templates').then((r) => setTemplates(r.templates)).catch(() => undefined);
  useEffect(() => void loadTemplates(), []);

  const needsOptions = !['yesno', 'text'].includes(d.type);
  const fromTemplate = (tpl: TemplateRow) => {
    const dr = tpl.data.draft as Partial<Draft> | undefined;
    if (dr) setD((cur) => ({ ...cur, ...dr }));
  };

  return (
    <Modal title={t('polls.new')} onClose={onClose}>
      <div className="flex max-h-[75vh] flex-col gap-3 overflow-y-auto pr-1">
        {templates.length > 0 && (
          <div className="flex flex-wrap items-end gap-2">
            <Select label={t('polls.template.use')} value="" onChange={(e) => { const tpl = templates.find((x) => x.id === e.target.value); if (tpl) fromTemplate(tpl); }}>
              <option value="">–</option>
              {templates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <TextInput label={t('polls.title')} value={d.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
        <TextArea label={t('polls.description')} value={d.description} maxLength={1000} onChange={(e) => set({ description: e.target.value })} />
        <Select label={t('polls.type')} value={d.type} onChange={(e) => set({ type: e.target.value as PType })}>
          {TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`polls.type.${x}`)}
            </option>
          ))}
        </Select>

        {needsOptions && (
          <fieldset className="flex flex-col gap-2 rounded-md border border-line p-2">
            <legend>{d.type === 'schedule' ? t('polls.slots') : t('polls.options')}</legend>
            {d.options.map((o, i) => (
              <div key={i} className="flex gap-2">
                <input className="w-16 rounded-sm border border-line bg-surface px-2 py-1" aria-label={t('polls.emoji')} placeholder="😀" value={o.emoji} maxLength={8} onChange={(e) => set({ options: d.options.map((x, j) => (j === i ? { ...x, emoji: e.target.value } : x)) })} />
                {d.actionKind === 'scheduleTournament' && (
                  <input type="datetime-local" className="rounded-sm border border-line bg-surface px-2 py-1" aria-label={t('polls.action.optionAt')} value={o.at} onChange={(e) => set({ options: d.options.map((x, j) => (j === i ? { ...x, at: e.target.value } : x)) })} />
                )}
                {optionValueKind(d.type, d.actionKind) === 'template' && (
                  <select className="rounded-sm border border-line bg-surface px-2 py-1" aria-label={t('polls.action.templateId')} value={o.value} onChange={(e) => set({ options: d.options.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}>
                    <option value="">–</option>
                    {lists.cash.map((tp) => (
                      <option key={tp.id} value={tp.id}>
                        {tp.name}
                      </option>
                    ))}
                  </select>
                )}
                {optionValueKind(d.type, d.actionKind) === 'user' && (
                  <select className="rounded-sm border border-line bg-surface px-2 py-1" aria-label={t('polls.action.userId')} value={o.value} onChange={(e) => set({ options: d.options.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}>
                    <option value="">–</option>
                    {lists.users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.nickname}
                      </option>
                    ))}
                  </select>
                )}
                {optionValueKind(d.type, d.actionKind) === 'setting' && (
                  <input className="w-28 rounded-sm border border-line bg-surface px-2 py-1" aria-label={t('polls.action.optionValue')} placeholder={t('polls.action.optionValue')} value={o.value} onChange={(e) => set({ options: d.options.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                )}
                <input className="flex-1 rounded-sm border border-line bg-surface px-2 py-1" aria-label={t('polls.option', { n: i + 1 })} placeholder={d.type === 'schedule' ? t('polls.slotPlaceholder') : t('polls.option', { n: i + 1 })} value={o.label} maxLength={120} onChange={(e) => set({ options: d.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                {d.options.length > 2 && <Button onClick={() => set({ options: d.options.filter((_, j) => j !== i) })}>✕</Button>}
              </div>
            ))}
            {d.options.length < 30 && <Button onClick={() => set({ options: [...d.options, { label: '', emoji: '', at: '', value: '' }] })}>{t('polls.addOption')}</Button>}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={d.allowAddOptions} onChange={(e) => set({ allowAddOptions: e.target.checked })} />
              {t('polls.allowAdd')}
            </label>
          </fieldset>
        )}
        {d.type === 'multi' && (
          <div className="grid grid-cols-2 gap-2">
            <TextInput label={t('polls.minChoices')} type="number" min={1} value={d.minChoices} onChange={(e) => set({ minChoices: e.target.value })} />
            <TextInput label={t('polls.maxChoices')} type="number" min={1} value={d.maxChoices} onChange={(e) => set({ maxChoices: e.target.value })} />
          </div>
        )}
        {d.type === 'rating' && <TextInput label={t('polls.ratingMax')} type="number" min={2} max={10} value={d.ratingMax} onChange={(e) => set({ ratingMax: e.target.value })} />}

        <fieldset className="flex flex-col gap-2 rounded-md border border-line p-2">
          <legend>{t('polls.rules')}</legend>
          {d.type !== 'text' && (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <Select label={t('polls.threshold')} value={d.threshold} onChange={(e) => set({ threshold: e.target.value })}>
                  {['simple', 'majorityOfAll', 'twoThirds', 'threeQuarters', 'unanimous', 'percent'].map((x) => (
                    <option key={x} value={x}>
                      {t(`polls.threshold.${x}`)}
                    </option>
                  ))}
                </Select>
                {d.threshold === 'percent' && <TextInput label={t('polls.percent')} type="number" min={1} max={100} value={d.percent} onChange={(e) => set({ percent: e.target.value })} />}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Select label={t('polls.quorum')} value={d.quorumKind} onChange={(e) => set({ quorumKind: e.target.value as Draft['quorumKind'] })}>
                  <option value="none">{t('polls.quorum.none')}</option>
                  <option value="count">{t('polls.quorum.count')}</option>
                  <option value="percent">{t('polls.quorum.percent')}</option>
                </Select>
                {d.quorumKind !== 'none' && <TextInput label={t('polls.quorumValue')} type="number" min={1} value={d.quorumValue} onChange={(e) => set({ quorumValue: e.target.value })} />}
              </div>
              {d.type === 'yesno' && (
                <Select label={t('polls.nonVoters')} value={d.nonVoters} onChange={(e) => set({ nonVoters: e.target.value })}>
                  {['ignore', 'no', 'yes'].map((x) => (
                    <option key={x} value={x}>
                      {t(`polls.nonVoters.${x}`)}
                    </option>
                  ))}
                </Select>
              )}
              <Select label={t('polls.tie')} value={d.tie} onChange={(e) => set({ tie: e.target.value })}>
                {['founder', 'random', 'extend', 'role'].map((x) => (
                  <option key={x} value={x}>
                    {t(`polls.tie.${x}`)}
                  </option>
                ))}
              </Select>
            </>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <Select label={t('polls.anonymity')} value={d.anonymity} onChange={(e) => set({ anonymity: e.target.value })}>
              {['public', 'anonymous', 'secret'].map((x) => (
                <option key={x} value={x}>
                  {t(`polls.anonymity.${x}`)}
                </option>
              ))}
            </Select>
            <Select label={t('polls.results')} value={d.results} onChange={(e) => set({ results: e.target.value })}>
              {['always', 'afterVote', 'afterClose'].map((x) => (
                <option key={x} value={x}>
                  {t(`polls.results.${x}`)}
                </option>
              ))}
            </Select>
          </div>
          {d.anonymity === 'secret' && <p className="text-sm text-muted">{t('polls.secretNote')}</p>}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d.allowChange && d.anonymity !== 'secret'} disabled={d.anonymity === 'secret'} onChange={(e) => set({ allowChange: e.target.checked })} />
            {t('polls.allowChange')}
          </label>
        </fieldset>

        <fieldset className="flex flex-col gap-2 rounded-md border border-line p-2">
          <legend>{t('polls.weights')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <Select label={t('polls.weightMode')} value={d.weightMode} onChange={(e) => set({ weightMode: e.target.value })}>
              {['equal', 'byRole', 'byLevel', 'byRating'].map((x) => (
                <option key={x} value={x}>
                  {t(`polls.weight.${x}`)}
                </option>
              ))}
            </Select>
            <TextInput label={t('polls.weightCap')} type="number" min={1} value={d.weightCap} onChange={(e) => set({ weightCap: e.target.value })} />
          </div>
          {d.weightMode === 'byLevel' && <TextInput label={t('polls.weightStep')} type="number" min={1} value={d.weightStep} onChange={(e) => set({ weightStep: e.target.value })} />}
          {d.weightMode === 'byRole' && <TextInput label={t('polls.weightTable')} hint={t('polls.weightTableHint')} value={d.weightTable} onChange={(e) => set({ weightTable: e.target.value })} />}
        </fieldset>

        <fieldset className="flex flex-col gap-2 rounded-md border border-line p-2">
          <legend>{t('polls.voters')}</legend>
          <ConditionEditor value={d.condition} onChange={(condition) => set({ condition })} />
          <EligiblePreview condition={d.condition} />
          <Select label={t('polls.eligibility')} value={d.eligibility} onChange={(e) => set({ eligibility: e.target.value })}>
            <option value="fixed">{t('polls.eligibility.fixed')}</option>
            <option value="live">{t('polls.eligibility.live')}</option>
          </Select>
        </fieldset>

        {canAction && (
          <fieldset className="flex flex-col gap-2 rounded-md border border-line p-2">
            <legend>{t('polls.action.title')}</legend>
            <p className="text-sm text-muted">{t('polls.action.hint')}</p>
            <Select label={t('polls.action.title')} value={d.actionKind} onChange={(e) => set({ actionKind: e.target.value })}>
              <option value="">{t('polls.action.none')}</option>
              {ACTIONS_BY_TYPE[d.type]!.map((k) => (
                <option key={k} value={k}>
                  {t(`polls.action.${k}`)}
                </option>
              ))}
            </Select>
            {d.actionKind && (
              <>
                {['scheduleTournament', 'useTemplate'].includes(d.actionKind) && <TextInput label={t('polls.action.name')} value={d.actionName} maxLength={60} onChange={(e) => set({ actionName: e.target.value })} />}
                {(d.actionKind === 'scheduleTournament' || (d.actionKind === 'useTemplate' && d.type === 'yesno')) && (
                  <Select label={t('polls.action.templateId')} value={d.actionTemplate} onChange={(e) => set({ actionTemplate: e.target.value })}>
                    <option value="">–</option>
                    {(d.actionKind === 'scheduleTournament' ? lists.tournament : lists.cash).map((tp) => (
                      <option key={tp.id} value={tp.id}>
                        {tp.name}
                      </option>
                    ))}
                  </Select>
                )}
                {['changeSettings', 'endGame'].includes(d.actionKind) && (
                  <Select label={t('polls.action.gameKind')} value={d.actionGameKind} onChange={(e) => set({ actionGameKind: e.target.value })}>
                    <option value="table">{t('polls.action.table')}</option>
                    <option value="tournament">{t('polls.action.tournament')}</option>
                  </Select>
                )}
                {['changeSettings', 'endGame', 'pauseGame'].includes(d.actionKind) && <TextInput label={t('polls.action.gameId')} value={d.actionGameId} onChange={(e) => set({ actionGameId: e.target.value })} />}
                {d.actionKind === 'changeSettings' && d.type === 'yesno' && <TextInput label={t('polls.action.settings')} value={d.actionSettings} onChange={(e) => set({ actionSettings: e.target.value })} />}
                {d.actionKind === 'changeSettings' && d.type === 'single' && <TextInput label={t('polls.action.settingKey')} value={d.actionSettingKey} onChange={(e) => set({ actionSettingKey: e.target.value })} />}
                {d.actionKind === 'assignRole' && <TextInput label={t('polls.action.roleKey')} value={d.actionRole} onChange={(e) => set({ actionRole: e.target.value })} />}
                {d.actionKind === 'assignRole' && d.type === 'yesno' && (
                  <Select label={t('polls.action.userId')} value={d.actionUser} onChange={(e) => set({ actionUser: e.target.value })}>
                    <option value="">–</option>
                    {lists.users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.nickname}
                      </option>
                    ))}
                  </Select>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={d.actionConfirm} onChange={(e) => set({ actionConfirm: e.target.checked })} />
                  {t('polls.action.requireConfirm')}
                </label>
              </>
            )}
          </fieldset>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          <TextInput label={t('polls.duration')} type="number" min={1} value={d.duration} onChange={(e) => set({ duration: e.target.value })} />
          {!table && (
            <Select label={t('polls.where')} value={d.channel} onChange={(e) => set({ channel: e.target.value })}>
              <option value="">{t('polls.whereMain')}</option>
              {channels
                .filter((c) => c.kind !== 'table')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.pinned} onChange={(e) => set({ pinned: e.target.checked })} />
          {t('polls.pin')}
        </label>

        {templates.length > 0 && (
          <ul className="flex flex-wrap gap-2 text-sm">
            {templates.map((x) => (
              <li key={x.id}>
                <Button onClick={() => void del(`/api/poll-templates/${x.id}`).then(loadTemplates)}>
                  {t('polls.template.delete', { name: x.name })}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            onClick={async () => {
              const name = prompt(t('polls.template.name'));
              if (!name) return;
              try {
                await post('/api/poll-templates', { name, data: { draft: { ...d, title: '' } } });
                void loadTemplates();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('polls.template.save')}
          </Button>
          <Button onClick={onClose}>{t('table.cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy || !d.title.trim()}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const r = await post<{ id: string }>('/api/polls', table ? { ...body(d), target: { kind: 'table', id: table.id } } : body(d));
                onCreated(r.id);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('polls.create')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
