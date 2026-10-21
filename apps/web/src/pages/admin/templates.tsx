import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolveSettings, scopeAllowed, t, validateValues, type SettingValue } from '@kb/shared';
import { del, errorText, get, post, put } from '../../api';
import { registry } from '../../settings';
import { blockingIssues, SettingsForm, UnsavedBar } from '../../settings/SettingsForm';
import { Badge, Button, DataTable, Modal, Notice, Select, Td, TextArea, TextInput } from '../../ui';
import { MoneyPreview, RebuyCard, StructureEditor, TournamentBasics } from '../structure-editor';

interface Template {
  id: string;
  kind: 'cash' | 'tournament' | 'live';
  name: string;
  description: string;
  tags: string[];
  builtin: boolean;
  /** Vestavěná šablona, kterou správce přepsal (jde obnovit). */
  overridden?: boolean;
  values: Record<string, SettingValue>;
}

const KIND_RANK: Record<Template['kind'], number> = { tournament: 0, cash: 1, live: 2 };

const templateScoped = (d: { scopes?: readonly string[] }) => scopeAllowed(d.scopes as never, 'template');

/** Správa šablon: vestavěné jen ke čtení (lze zkopírovat), vlastní se zakládají, upravují a mažou. */
export function TemplatesPage() {
  const [rows, setRows] = useState<Template[]>([]);
  const [error, setError] = useState('');
  const [deleted, setDeleted] = useState<{ id: string; kind: Template['kind']; name: string }[]>([]);
  const [editor, setEditor] = useState<{ base: Template | null; kind: Template['kind']; copy?: boolean } | null>(null);
  const reload = useCallback(() => {
    get<{ templates: Template[]; deleted?: { id: string; kind: Template['kind']; name: string }[] }>('/api/admin/templates')
      // Ve správě jsou šablony seskupené podle druhu (turnaje, cash, živé); uvnitř druhu platí pořadí z nabídky.
      .then((d) => {
        setRows([...d.templates].sort((x, y) => KIND_RANK[x.kind] - KIND_RANK[y.kind]));
        setDeleted(d.deleted ?? []);
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(reload, [reload]);
  const label = (x: Template) => (x.builtin ? t(x.name) : x.name);
  const move = async (x: Template, dir: -1 | 1) => {
    const same = rows.filter((r) => r.kind === x.kind).map((r) => r.id);
    const i = same.indexOf(x.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= same.length) return;
    [same[i], same[j]] = [same[j]!, same[i]!];
    try {
      await put('/api/admin/templates/order', { kind: x.kind, ids: same });
      reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Notice>{t('templates.info')}</Notice>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => setEditor({ base: null, kind: 'tournament' })}>
          {t('templates.newTournament')}
        </Button>
        <Button variant="primary" onClick={() => setEditor({ base: null, kind: 'cash' })}>
          {t('templates.newCash')}
        </Button>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <DataTable head={[t('templates.name'), t('templates.kind'), t('templates.origin'), '']}>
        {rows.map((x) => (
          <tr key={x.id}>
            <Td>
              <strong>{label(x)}</strong>
              <div className="text-sm text-muted">{x.builtin ? t(x.description) : x.description}</div>
            </Td>
            <Td>{t(`templates.kind.${x.kind}`)}</Td>
            <Td>{x.builtin ? <Badge>{t('templates.builtin')}</Badge> : x.overridden ? <Badge tone="warning">{t('templates.overridden')}</Badge> : <Badge tone="primary">{t('templates.custom')}</Badge>}</Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                <Button aria-label={t('table.moveUp')} onClick={() => void move(x, -1)}>
                  ↑
                </Button>
                <Button aria-label={t('table.moveDown')} onClick={() => void move(x, 1)}>
                  ↓
                </Button>
                <Button onClick={() => setEditor({ base: x, kind: x.kind })}>{t('lobby.edit')}</Button>
                <Button onClick={() => setEditor({ base: x, kind: x.kind, copy: true })}>{t('templates.copy')}</Button>
                {x.overridden && (
                  <Button
                    onClick={async () => {
                      if (!confirm(t('templates.restoreConfirm', { name: label(x) }))) return;
                      try {
                        await post(`/api/admin/templates/${x.id}/restore`);
                        reload();
                      } catch (e) {
                        setError(errorText(e));
                      }
                    }}
                  >
                    {t('templates.restore')}
                  </Button>
                )}
                {(
                  <Button
                    variant="danger"
                    onClick={async () => {
                      if (!confirm(t(x.builtin || x.overridden ? 'templates.deleteBuiltinConfirm' : 'templates.deleteConfirm', { name: label(x) }))) return;
                      try {
                        await del(`/api/admin/templates/${x.id}`);
                        reload();
                      } catch (e) {
                        setError(errorText(e));
                      }
                    }}
                  >
                    {t('templates.delete')}
                  </Button>
                )}
              </div>
            </Td>
          </tr>
        ))}
      </DataTable>
      {deleted.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="font-bold">{t('templates.deletedTitle')}</h3>
          <ul className="flex flex-col gap-1">
            {deleted.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <span className="flex-1">{t(d.name)}</span>
                <Button
                  onClick={async () => {
                    try {
                      await post(`/api/admin/templates/${d.id}/restore`);
                      reload();
                    } catch (e) {
                      setError(errorText(e));
                    }
                  }}
                >
                  {t('templates.restore')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {editor && (
        <TemplateEditor
          base={editor.base}
          kind={editor.kind}
          copy={!!editor.copy}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

/** Editor šablony: název, popis a celý formulář nastavení (jen parametry, které šablona smí určit). */
function TemplateEditor({ base, kind, copy, onClose, onSaved }: { base: Template | null; kind: Template['kind']; copy: boolean; onClose: () => void; onSaved: () => void }) {
  // Úprava = existující šablona (i vestavěná: uloží se jako její přepsání); kopie = nová vlastní šablona.
  const editing = !!base && !copy;
  const [name, setName] = useState(base ? (copy ? `${base.builtin ? t(base.name) : base.name} (${t('templates.copySuffix')})` : base.builtin ? t(base.name) : base.name) : '');
  const [description, setDescription] = useState(base ? (base.builtin ? t(base.description) : base.description) : '');
  const [values, setValues] = useState<Record<string, SettingValue>>(base?.values ?? {});
  const [dirty, setDirty] = useState<string[]>([]);
  const [error, setError] = useState('');
  const resolved = useMemo(() => resolveSettings(registry, [{ scope: 'template', values }]), [values]);
  const issues = useMemo(() => validateValues(registry, values), [values]);
  const problems = blockingIssues(issues, dirty.length ? dirty : Object.keys(values));
  const gameKind = kind === 'live' ? 'tournament' : kind;
  const [advanced, setAdvanced] = useState(gameKind !== 'tournament');
  const setOne = (k: string, v: SettingValue) => {
    setValues((cur) => ({ ...cur, [k]: v }));
    setDirty((d) => (d.includes(k) ? d : [...d, k]));
  };
  const save = async () => {
    try {
      const body = { name, description, kind, values };
      if (editing) await put(`/api/admin/templates/${base.id}`, body);
      else await post('/api/admin/templates', body);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal title={editing ? `${t('lobby.edit')}: ${base.builtin ? t(base.name) : base.name}` : t('templates.new')} onClose={onClose} dirty={dirty.length > 0 || (editing ? name !== (base.builtin ? t(base.name) : base.name) : name.trim().length > 0)}>
      <div className="flex flex-col gap-3">
        <TextInput label={t('templates.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        <TextArea label={t('templates.description')} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        <Select label={t('templates.kind')} value={kind} disabled>
          <option value={kind}>{t(`templates.kind.${kind}`)}</option>
        </Select>
        {gameKind === 'tournament' && <TournamentBasics values={resolved.values} set={setOne} />}
        {gameKind === 'tournament' && (
          <>
            <StructureEditor values={resolved.values} set={setOne} />
            <MoneyPreview values={resolved.values} />
            <RebuyCard values={resolved.values} set={setOne} />
          </>
        )}
        {gameKind === 'tournament' && <Button onClick={() => setAdvanced(!advanced)}>{advanced ? t('lobby.hideAdvanced') : t('lobby.showAdvanced')}</Button>}
        {advanced && (
          <>
            <p className="text-sm text-muted">{t('basics.advancedHelp')}</p>
          <SettingsForm
            registry={registry}
            values={resolved.values}
            origins={Object.fromEntries(registry.all().map((d) => [d.key, d.key in values ? 'template' : 'default']))}
            editScope="template"
            onChange={(k, v) => {
              setValues({ ...values, [k]: v });
              setDirty((d) => (d.includes(k) ? d : [...d, k]));
            }}
            onReset={(k) => {
              setValues(Object.fromEntries(Object.entries(values).filter(([x]) => x !== k)));
              setDirty((d) => (d.includes(k) ? d : [...d, k]));
            }}
            issues={issues}
            allowedKeys={templateScoped}
            gameKind={gameKind}
            pendingKeys={dirty}
          />
            </>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button variant="primary" disabled={problems.length > 0 || name.trim().length < 2} onClick={() => void save()}>
            {t('lobby.save')}
          </Button>
          <Button onClick={() => (dirty.length === 0 || confirm(t('modal.discardConfirm'))) && onClose()}>{t('table.cancel')}</Button>
        </div>
        <UnsavedBar
          count={dirty.length}
          disabled={problems.length > 0 || name.trim().length < 2}
          onSave={() => void save()}
          problems={problems}
          onDiscard={() => {
            setValues(base?.values ?? {});
            setDirty([]);
          }}
        />
      </div>
    </Modal>
  );
}
