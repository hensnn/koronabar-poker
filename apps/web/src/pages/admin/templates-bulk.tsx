import { useMemo, useState } from 'react';
import { resolveSettings, scopeAllowed, t, validateValues, type SettingValue } from '@kb/shared';
import { errorText, put } from '../../api';
import { registry } from '../../settings';
import { blockingIssues, SettingsForm } from '../../settings/SettingsForm';
import { Button, Modal, Notice, Select } from '../../ui';

export interface BulkTemplate {
  id: string;
  kind: 'cash' | 'tournament' | 'live';
  name: string;
  description: string;
  tags: string[];
  builtin: boolean;
  values: Record<string, SettingValue>;
}

const templateScoped = (d: { scopes?: readonly string[] }) => scopeAllowed(d.scopes as never, 'template');

/** Hromadná změna: vybraná nastavení se zapíšou do všech zaškrtnutých šablon jednoho druhu, ostatní hodnoty šablon zůstanou. */
export function BulkTemplateEditor({ templates, onClose, onSaved }: { templates: BulkTemplate[]; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<BulkTemplate['kind']>('tournament');
  const ofKind = templates.filter((x) => x.kind === kind);
  const [picked, setPicked] = useState<string[]>(() => templates.filter((x) => x.kind === 'tournament').map((x) => x.id));
  const [changes, setChanges] = useState<Record<string, SettingValue>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = ofKind.filter((x) => picked.includes(x.id));
  const label = (x: BulkTemplate) => (x.builtin ? t(x.name) : x.name);
  const gameKind = kind === 'live' ? 'tournament' : kind;
  // Zobrazené hodnoty vycházejí z první vybrané šablony; zapíše se jen to, co správce změní.
  const shown = useMemo(() => resolveSettings(registry, [{ scope: 'template', values: { ...(chosen[0]?.values ?? {}), ...changes } }]), [chosen, changes]);
  const issues = useMemo(() => validateValues(registry, { ...(chosen[0]?.values ?? {}), ...changes }), [chosen, changes]);
  const problems = blockingIssues(issues, Object.keys(changes));
  const keys = Object.keys(changes);
  const save = async () => {
    setBusy(true);
    try {
      for (const x of chosen) await put(`/api/admin/templates/${x.id}`, { name: x.name, description: x.description, kind: x.kind, tags: x.tags, values: { ...x.values, ...changes } });
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('templates.bulk.title')} onClose={onClose} dirty={keys.length > 0}>
      <div className="flex flex-col gap-3">
        <Notice>{t('templates.bulk.help')}</Notice>
        <Select
          label={t('templates.kind')}
          value={kind}
          onChange={(e) => {
            const k = e.target.value as BulkTemplate['kind'];
            setKind(k);
            setPicked(templates.filter((x) => x.kind === k).map((x) => x.id));
            setChanges({});
          }}
        >
          {(['tournament', 'cash', 'live'] as const).map((k) => (
            <option key={k} value={k}>
              {t(`templates.kind.${k}`)}
            </option>
          ))}
        </Select>
        <fieldset className="flex flex-col gap-1">
          <legend className="font-medium">{t('templates.bulk.which')}</legend>
          {ofKind.map((x) => (
            <label key={x.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={picked.includes(x.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, x.id] : picked.filter((id) => id !== x.id))} />
              {label(x)}
            </label>
          ))}
        </fieldset>
        <SettingsForm
          registry={registry}
          values={shown.values}
          origins={Object.fromEntries(registry.all().map((d) => [d.key, d.key in changes ? 'template' : 'default']))}
          editScope="template"
          onChange={(k, v) => setChanges({ ...changes, [k]: v })}
          onReset={(k) => setChanges(Object.fromEntries(Object.entries(changes).filter(([x]) => x !== k)))}
          issues={issues}
          allowedKeys={templateScoped}
          gameKind={gameKind}
          pendingKeys={keys}
        />
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={busy || keys.length === 0 || chosen.length === 0 || problems.length > 0} onClick={() => void save()}>
            {t('templates.bulk.apply', { n: keys.length, m: chosen.length })}
          </Button>
          <Button onClick={() => (keys.length === 0 || confirm(t('modal.discardConfirm'))) && onClose()}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}
