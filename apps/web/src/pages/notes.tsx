import { useState } from 'react';
import { t } from '@kb/shared';
import { errorText } from '../api';
import { LABEL_BG, addLabel, deleteNote, noteFor, removeLabel, saveNote, updateLabel, useNotes } from '../notes-client';
import { Button, Card, DataTable, Modal, Notice, Select, Td, TextArea, TextInput } from '../ui';

/** Dialog poznámky a štítku k jednomu hráči (otevírá se u stolu). */
export function NoteDialog({ userId, nickname, onClose }: { userId: string; nickname: string; onClose: () => void }) {
  const st = useNotes();
  const cur = noteFor(st, userId);
  const [note, setNote] = useState(cur?.note.note ?? '');
  const [labelId, setLabelId] = useState(cur?.note.labelId ?? '');
  const [error, setError] = useState('');
  return (
    <Modal title={t('notes.dialogTitle', { nick: nickname })} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <Notice kind="error">{error}</Notice>}
        <TextArea label={t('notes.note')} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
        <Select label={t('notes.label')} value={labelId} onChange={(e) => setLabelId(e.target.value)}>
          <option value="">{t('notes.noLabel')}</option>
          {st.labels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await saveNote(userId, note, labelId || null);
                onClose();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('notes.save')}
          </Button>
          {cur && (
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await deleteNote(userId);
                  onClose();
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              {t('notes.remove')}
            </Button>
          )}
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Barevná tečka štítku u hráče; kliknutím se otevře poznámka. */
export function NoteDot({ userId, onOpen }: { userId: string; onOpen: () => void }) {
  const st = useNotes();
  const cur = noteFor(st, userId);
  const label = cur?.label;
  const title = [label ? t('notes.badge', { name: label.name }) : '', cur?.note.note ?? ''].filter(Boolean).join(': ') || t('notes.open');
  return (
    <button type="button" aria-label={t('notes.open')} title={title} onClick={onOpen} className={`inline-block h-3 w-3 shrink-0 rounded-full border border-line ${label ? LABEL_BG[label.color] : cur ? 'bg-muted' : 'bg-raised'}`} />
  );
}

/** Správa štítků a přehled všech poznámek (v profilu). */
export function NotesSection() {
  const st = useNotes();
  const [name, setName] = useState('');
  const [color, setColor] = useState('primary');
  const [error, setError] = useState('');
  const [edit, setEdit] = useState<{ userId: string; nickname: string } | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Card title={t('notes.title')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('notes.help')}</p>
        {error && <Notice kind="error">{error}</Notice>}
        <section className="flex flex-col gap-2">
          <h3 className="font-bold">{t('notes.labels')}</h3>
          <ul className="flex flex-col gap-1">
            {st.labels.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2">
                <span className={`inline-block h-4 w-4 rounded-full border border-line ${LABEL_BG[l.color]}`} />
                <input
                  aria-label={t('notes.labelName')}
                  className="rounded-sm border border-line bg-surface px-2 py-1"
                  defaultValue={l.name}
                  maxLength={20}
                  onBlur={(e) => e.target.value.trim() && e.target.value !== l.name && void run(() => updateLabel(l.id, e.target.value, l.color))}
                />
                <select aria-label={t('notes.labelColor')} className="rounded-sm border border-line bg-surface px-2 py-1" value={l.color} onChange={(e) => void run(() => updateLabel(l.id, l.name, e.target.value))}>
                  {st.colors.map((c) => (
                    <option key={c} value={c}>
                      {t(`notes.color.${c}`)}
                    </option>
                  ))}
                </select>
                <Button variant="danger" onClick={() => void run(() => removeLabel(l.id))}>
                  {t('notes.deleteLabel')}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <TextInput label={t('notes.labelName')} value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
            <Select label={t('notes.labelColor')} value={color} onChange={(e) => setColor(e.target.value)}>
              {st.colors.map((c) => (
                <option key={c} value={c}>
                  {t(`notes.color.${c}`)}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              disabled={!name.trim()}
              onClick={() =>
                void run(async () => {
                  await addLabel(name, color);
                  setName('');
                })
              }
            >
              {t('notes.addLabel')}
            </Button>
          </div>
        </section>
        {st.notes.length === 0 ? (
          <p className="text-muted">{t('notes.empty')}</p>
        ) : (
          <DataTable head={[t('notes.player'), t('notes.label'), t('notes.note'), '']}>
            {st.notes.map((n) => {
              const label = st.labels.find((l) => l.id === n.labelId);
              return (
                <tr key={n.targetId}>
                  <Td>{n.nickname}</Td>
                  <Td>
                    {label && (
                      <span className="inline-flex items-center gap-1">
                        <span className={`inline-block h-3 w-3 rounded-full border border-line ${LABEL_BG[label.color]}`} />
                        {label.name}
                      </span>
                    )}
                  </Td>
                  <Td className="text-sm">{n.note}</Td>
                  <Td>
                    <Button onClick={() => setEdit({ userId: n.targetId, nickname: n.nickname })}>{t('notes.open')}</Button>
                  </Td>
                </tr>
              );
            })}
          </DataTable>
        )}
        <div>
          <a className="rounded-md border border-line bg-surface px-3 py-1" href="/api/notes/export.json">
            {t('notes.export')}
          </a>
        </div>
      </div>
      {edit && <NoteDialog userId={edit.userId} nickname={edit.nickname} onClose={() => setEdit(null)} />}
    </Card>
  );
}
