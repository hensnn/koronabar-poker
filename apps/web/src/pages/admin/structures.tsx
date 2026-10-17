import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseStructure, t } from '@kb/shared';
import { del, errorText, get, post, put } from '../../api';
import { Button, DataTable, Modal, Notice, NumInput, Td, TextArea, TextInput } from '../../ui';
import { LevelsTable } from '../structure-editor';

export interface BlindStructure {
  id: string;
  name: string;
  description: string;
  levels: string;
  startingStack: number;
  levelMinutes: number;
  updatedAt: number;
}

/** Správa → Struktury blindů: pojmenované struktury, které jde vybrat při zakládání turnaje (a přepočítat na jiný stack). */
export function StructuresPage() {
  const [rows, setRows] = useState<BlindStructure[]>([]);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<BlindStructure | null | 'new'>(null);
  const reload = useCallback(() => {
    get<{ structures: BlindStructure[] }>('/api/structures')
      .then((d) => setRows(d.structures))
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(reload, [reload]);
  return (
    <div className="flex flex-col gap-3">
      <Notice>{t('structures.info')}</Notice>
      <div>
        <Button variant="primary" onClick={() => setEditor('new')}>
          {t('structures.new')}
        </Button>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {rows.length === 0 && <Notice>{t('structures.empty')}</Notice>}
      {rows.length > 0 && (
        <DataTable head={[t('templates.name'), t('tournament.startingStack'), t('structure.levelMinutes'), t('structures.levels'), '']}>
          {rows.map((x) => (
            <tr key={x.id}>
              <Td>
                <strong>{x.name}</strong>
                {x.description && <div className="text-sm text-muted">{x.description}</div>}
              </Td>
              <Td className="font-mono">{x.startingStack}</Td>
              <Td className="font-mono">{x.levelMinutes}</Td>
              <Td className="max-w-md font-mono text-xs">
                <span className="block truncate" title={x.levels}>
                  {x.levels}
                </span>
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  <Button onClick={() => setEditor(x)}>{t('lobby.edit')}</Button>
                  <Button
                    variant="danger"
                    onClick={async () => {
                      if (!confirm(t('structures.deleteConfirm', { name: x.name }))) return;
                      try {
                        await del(`/api/admin/structures/${x.id}`);
                        reload();
                      } catch (e) {
                        setError(errorText(e));
                      }
                    }}
                  >
                    {t('templates.delete')}
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </DataTable>
      )}
      {editor && (
        <StructureDialog
          base={editor === 'new' ? null : editor}
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

/** Dialog pro založení/úpravu uložené struktury (i „Uložit jako…“ z editoru turnaje). */
export function StructureDialog({ base, initial, onClose, onSaved }: { base: BlindStructure | null; initial?: Partial<BlindStructure>; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(base?.name ?? initial?.name ?? '');
  const [description, setDescription] = useState(base?.description ?? initial?.description ?? '');
  const [levels, setLevels] = useState(base?.levels ?? initial?.levels ?? '');
  const [startingStack, setStartingStack] = useState(base?.startingStack ?? initial?.startingStack ?? 5000);
  const [levelMinutes, setLevelMinutes] = useState(base?.levelMinutes ?? initial?.levelMinutes ?? 15);
  const [error, setError] = useState('');
  const parsed = useMemo(() => {
    try {
      return { levels: parseStructure(levels), error: '' };
    } catch {
      return { levels: [], error: levels.trim() ? t('tournament.structureInvalid') : '' };
    }
  }, [levels]);
  const dirty = name !== (base?.name ?? '') || levels !== (base?.levels ?? '');
  const save = async () => {
    try {
      const body = { name, description, levels, startingStack, levelMinutes };
      if (base) await put(`/api/admin/structures/${base.id}`, body);
      else await post('/api/admin/structures', body);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal title={base ? `${t('lobby.edit')}: ${base.name}` : t('structures.new')} onClose={onClose} dirty={dirty}>
      <div className="flex flex-col gap-3">
        <TextInput label={t('templates.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        <TextArea label={t('templates.description')} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1 text-sm">
            {t('tournament.startingStack')}
            <NumInput className="w-28" min={1} value={startingStack} onChange={setStartingStack} />
          </label>
          <label className="flex items-center gap-1 text-sm">
            {t('structure.levelMinutes')}
            <NumInput className="w-20" min={1} max={240} value={levelMinutes} onChange={setLevelMinutes} />
          </label>
        </div>
        <TextArea label={t('structures.levels')} value={levels} onChange={(e) => setLevels(e.target.value)} placeholder={t('tournament.structurePlaceholder')} />
        {parsed.error && <span className="text-danger">{parsed.error}</span>}
        {parsed.levels.length > 0 && <LevelsTable levels={parsed.levels} breakEvery={0} />}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button variant="primary" disabled={parsed.levels.length === 0 || name.trim().length < 2} onClick={() => void save()}>
            {t('lobby.save')}
          </Button>
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}
