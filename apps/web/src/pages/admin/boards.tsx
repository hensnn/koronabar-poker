import { useCallback, useEffect, useState } from 'react';
import { BOARD_COLUMNS, BOARD_SORTS, defaultBoardConfig, sanitizeBoardConfig, t, type PublicBoardConfig } from '@kb/shared';
import { del, errorText, get, post, put } from '../../api';
import { Button, Card, Modal, NumInput, Notice, Select, TextInput } from '../../ui';
import { BoardAppearanceEditor } from './boards-appearance';

interface BoardRow {
  id: string;
  name: string;
  token: string;
  enabled: boolean;
  config: PublicBoardConfig;
}
interface UserRow {
  id: string;
  nickname: string;
}

const PERIODS = [0, 30, 90, 365];
const linkOf = (token: string) => `${window.location.origin}/verejne/${token}`;

/** Správa → Veřejné přehledy: žebříčky hráčů na tajném odkazu bez přihlášení. */
export function BoardsPage() {
  const [boards, setBoards] = useState<BoardRow[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [editing, setEditing] = useState<BoardRow | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const reload = useCallback(() => {
    get<{ boards: BoardRow[]; enabled: boolean }>('/api/admin/public-boards')
      .then((r) => {
        setBoards(r.boards);
        setEnabled(r.enabled);
      })
      .catch((e) => setMsg({ kind: 'error', text: errorText(e) }));
  }, []);
  useEffect(() => {
    reload();
    get<UserRow[]>('/api/admin/users').then(setUsers).catch(() => undefined);
  }, [reload]);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ kind: 'success', text: ok });
      reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    }
  };
  const copy = (token: string) => act(() => navigator.clipboard.writeText(linkOf(token)), t('boards.copied'));
  return (
    <div className="flex flex-col gap-3">
      <Card title={t('admin.boards')} actions={<Button variant="primary" onClick={() => act(() => post('/api/admin/public-boards', { name: t('boards.defaultName') }))}>{t('boards.add')}</Button>}>
        <p className="mb-2 text-sm text-muted">{t('boards.intro')}</p>
        {!enabled && <Notice kind="error">{t('boards.featureOff')}</Notice>}
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      </Card>
      {boards.length === 0 && <p className="text-sm text-muted">{t('boards.empty')}</p>}
      {boards.map((b) => (
        <Card key={b.id} title={b.name}>
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-sm">
              {t('boards.link')}
              <input readOnly value={linkOf(b.token)} className="w-full rounded-sm border border-line bg-surface px-2 py-1 font-mono text-text" onFocus={(e) => e.currentTarget.select()} />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => copy(b.token)}>{t('boards.copy')}</Button>
              <a className="rounded-sm border border-line px-3 py-1 text-sm" href={linkOf(b.token)} target="_blank" rel="noreferrer">{t('boards.open')}</a>
              <Button onClick={() => setEditing(b)}>{t('boards.edit')}</Button>
              <Button onClick={() => act(() => put(`/api/admin/public-boards/${b.id}`, { enabled: !b.enabled }))}>{b.enabled ? t('boards.enabled') : t('boards.disabled')}</Button>
              <Button onClick={() => window.confirm(t('boards.rotateConfirm')) && act(() => post(`/api/admin/public-boards/${b.id}/rotate`))}>{t('boards.rotate')}</Button>
              <Button variant="danger" onClick={() => window.confirm(t('boards.deleteConfirm')) && act(() => del(`/api/admin/public-boards/${b.id}`))}>{t('boards.delete')}</Button>
            </div>
          </div>
        </Card>
      ))}
      {editing && (
        <BoardForm
          board={editing}
          users={users}
          onClose={() => setEditing(null)}
          onSave={async (name, config) => {
            await act(() => put(`/api/admin/public-boards/${editing.id}`, { name, config }), t('boards.saved'));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function BoardForm({ board, users, onClose, onSave }: { board: BoardRow; users: UserRow[]; onClose: () => void; onSave: (name: string, c: PublicBoardConfig) => Promise<void> }) {
  const [name, setName] = useState(board.name);
  const [c, setC] = useState<PublicBoardConfig>(() => sanitizeBoardConfig(board.config ?? defaultBoardConfig()));
  const set = <K extends keyof PublicBoardConfig>(k: K, v: PublicBoardConfig[K]) => setC((o) => ({ ...o, [k]: v }));
  const nick = (id: string) => users.find((u) => u.id === id)?.nickname ?? id;
  return (
    <Modal title={t('boards.edit')} onClose={onClose} dirty wide>
      <div className="flex flex-col gap-3">
        <TextInput label={t('boards.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <TextInput label={t('boards.f.title')} hint={t('boards.f.title.help')} value={c.title} onChange={(e) => set('title', e.target.value)} maxLength={80} />
        <TextInput label={t('boards.f.subtitle')} value={c.subtitle} onChange={(e) => set('subtitle', e.target.value)} maxLength={200} />
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm">{t('boards.f.columns')}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {BOARD_COLUMNS.map((col) => (
              <label key={col} className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={c.columns.includes(col)} onChange={(e) => set('columns', BOARD_COLUMNS.filter((x) => (x === col ? e.target.checked : c.columns.includes(x))))} />
                {t(`boards.col.${col}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label={t('boards.f.sort')} value={c.sort} onChange={(e) => set('sort', e.target.value as PublicBoardConfig['sort'])}>
            {BOARD_SORTS.map((s) => <option key={s} value={s}>{t(`boards.sort.${s}`)}</option>)}
          </Select>
          <Select label={t('boards.f.period')} value={String(c.periodDays)} onChange={(e) => set('periodDays', Number(e.target.value))}>
            {PERIODS.map((p) => <option key={p} value={p}>{t(`boards.period.${p}`)}</option>)}
          </Select>
          <label className="flex flex-col gap-1 text-sm">{t('boards.f.limit')}<NumInput value={c.limit} min={0} max={500} onChange={(n) => set('limit', n)} /><span className="text-xs text-muted">{t('boards.f.limit.help')}</span></label>
          <label className="flex flex-col gap-1 text-sm">{t('boards.f.refresh')}<NumInput value={c.refreshSeconds} min={0} max={3600} onChange={(n) => set('refreshSeconds', n)} /><span className="text-xs text-muted">{t('boards.f.refresh.help')}</span></label>
          <label className="flex flex-col gap-1 text-sm">{t('boards.f.minGames')}<NumInput value={c.minGames} min={0} onChange={(n) => set('minGames', n)} /></label>
          <label className="flex flex-col gap-1 text-sm">{t('boards.f.minHands')}<NumInput value={c.minHands} min={0} onChange={(n) => set('minHands', n)} /></label>
        </div>
        <p className="text-xs text-muted">{t('boards.f.min.help')}</p>
        <Select label={t('boards.f.nameMode')} value={c.nameMode} onChange={(e) => set('nameMode', e.target.value as PublicBoardConfig['nameMode'])}>
          <option value="full">{t('boards.f.nameMode.full')}</option>
          <option value="initial">{t('boards.f.nameMode.initial')}</option>
        </Select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={c.showMoney} onChange={(e) => set('showMoney', e.target.checked)} />{t('boards.f.showMoney')}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={c.showChart} onChange={(e) => set('showChart', e.target.checked)} />{t('boards.f.showChart')}</label>
        {c.showChart && <label className="flex flex-col gap-1 text-sm">{t('boards.f.chartPlayers')}<NumInput value={c.chartPlayers} min={1} max={10} onChange={(n) => set('chartPlayers', n)} /><span className="text-xs text-muted">{t('boards.f.chartPlayers.help')}</span></label>}
        <BoardAppearanceEditor config={c} onChange={(a) => set('appearance', a)} />
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm">{t('boards.f.hidden')}</legend>
          <p className="text-xs text-muted">{t('boards.f.hidden.help')}</p>
          <div className="flex flex-wrap gap-1">
            {c.hiddenUserIds.map((id) => (
              <Button key={id} onClick={() => set('hiddenUserIds', c.hiddenUserIds.filter((x) => x !== id))}>{nick(id)} ✕</Button>
            ))}
          </div>
          <Select label={t('boards.f.hidden.add')} value="" onChange={(e) => e.target.value && set('hiddenUserIds', [...c.hiddenUserIds, e.target.value])}>
            <option value="">—</option>
            {users.filter((u) => !c.hiddenUserIds.includes(u.id)).map((u) => <option key={u.id} value={u.id}>{u.nickname}</option>)}
          </Select>
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('boards.cancel')}</Button>
          <Button variant="primary" onClick={() => onSave(name, c)}>{t('boards.save')}</Button>
        </div>
      </div>
    </Modal>
  );
}
