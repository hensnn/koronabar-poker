import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolveSettings, scopeAllowed, t, validateValues, type SettingValue } from '@kb/shared';
import { del, errorText, get, post, put } from '../../api';
import { registry } from '../../settings';
import { SettingsForm, UnsavedBar } from '../../settings/SettingsForm';
import { Badge, Button, DataTable, Modal, Notice, Select, Td, TextArea, TextInput } from '../../ui';
import { MoneyPreview, RebuyCard, StructureEditor } from '../structure-editor';

interface Template {
  id: string;
  kind: 'cash' | 'tournament' | 'live';
  name: string;
  description: string;
  tags: string[];
  builtin: boolean;
  values: Record<string, SettingValue>;
}

const templateScoped = (d: { scopes?: readonly string[] }) => scopeAllowed(d.scopes as never, 'template');

/** Správa šablon: vestavěné jen ke čtení (lze zkopírovat), vlastní se zakládají, upravují a mažou. */
export function TemplatesPage() {
  const [rows, setRows] = useState<Template[]>([]);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ base: Template | null; kind: Template['kind'] } | null>(null);
  const reload = useCallback(() => {
    get<{ templates: Template[] }>('/api/admin/templates')
      .then((d) => setRows(d.templates))
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(reload, [reload]);
  const label = (x: Template) => (x.builtin ? t(x.name) : x.name);
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
            <Td>{x.builtin ? <Badge>{t('templates.builtin')}</Badge> : <Badge tone="primary">{t('templates.custom')}</Badge>}</Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                <Button onClick={() => setEditor({ base: x, kind: x.kind })}>{x.builtin ? t('templates.copy') : t('lobby.edit')}</Button>
                {!x.builtin && (
                  <Button
                    variant="danger"
                    onClick={async () => {
                      if (!confirm(t('templates.deleteConfirm', { name: x.name }))) return;
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
      {editor && (
        <TemplateEditor
          base={editor.base}
          kind={editor.kind}
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
function TemplateEditor({ base, kind, onClose, onSaved }: { base: Template | null; kind: Template['kind']; onClose: () => void; onSaved: () => void }) {
  const editing = !!base && !base.builtin;
  const [name, setName] = useState(base ? (base.builtin ? `${t(base.name)} (${t('templates.copySuffix')})` : base.name) : '');
  const [description, setDescription] = useState(base ? (base.builtin ? t(base.description) : base.description) : '');
  const [values, setValues] = useState<Record<string, SettingValue>>(base?.values ?? {});
  const [dirty, setDirty] = useState<string[]>([]);
  const [error, setError] = useState('');
  const resolved = useMemo(() => resolveSettings(registry, [{ scope: 'template', values }]), [values]);
  const issues = useMemo(() => validateValues(registry, values), [values]);
  const gameKind = kind === 'live' ? 'tournament' : kind;
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
    <Modal title={editing ? `${t('lobby.edit')}: ${base.name}` : t('templates.new')} onClose={onClose} dirty={dirty.length > 0 || (editing ? name !== base.name : name.trim().length > 0)}>
      <div className="flex flex-col gap-3">
        <TextInput label={t('templates.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        <TextArea label={t('templates.description')} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        <Select label={t('templates.kind')} value={kind} disabled>
          <option value={kind}>{t(`templates.kind.${kind}`)}</option>
        </Select>
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
        {gameKind === 'tournament' && (
          <>
            <MoneyPreview values={resolved.values} set={setOne} />
            <RebuyCard values={resolved.values} set={setOne} />
            <StructureEditor values={resolved.values} set={setOne} />
          </>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button variant="primary" disabled={issues.length > 0 || name.trim().length < 2} onClick={() => void save()}>
            {t('lobby.save')}
          </Button>
          <Button onClick={() => (dirty.length === 0 || confirm(t('modal.discardConfirm'))) && onClose()}>{t('table.cancel')}</Button>
        </div>
        <UnsavedBar
          count={dirty.length}
          disabled={issues.length > 0 || name.trim().length < 2}
          onSave={() => void save()}
          onDiscard={() => {
            setValues(base?.values ?? {});
            setDirty([]);
          }}
        />
      </div>
    </Modal>
  );
}
