import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../session';
import { t } from '@kb/shared';
import { errorText, get, post } from '../../api';
import { Button, Card, Notice, TextInput } from '../../ui';

interface Counts {
  chatMessages: number;
  chatImages: number;
  notifications: number;
  historyItems: number;
  walletsNonZero: number;
  walletsTotal: number;
  xpEvents: number;
  players: number;
  achievements: number;
  ratings: number;
  hands: number;
  results: number;
  openTables: number;
  activeTournaments: number;
}

const AREAS = ['games', 'xp', 'achievements', 'rating', 'stats', 'wallets'] as const;
type Area = (typeof AREAS)[number];
const CONFIRM_WORD = 'VYNULOVAT';
const RESET_WORD = 'SMAZAT VŠE';

interface UserRow {
  id: string;
  nickname: string;
  status: string;
  roles: { role?: string }[];
}
const SINCE = ['history', 'stats', 'chat', 'notifications'] as const;
type SinceArea = (typeof SINCE)[number];
interface SinceCounts {
  historyItems: number;
  hands: number;
  results: number;
  chatMessages: number;
  chatImages: number;
  notifications: number;
}
const LAUNCH = ['games', 'progress', 'history', 'chat', 'notifications', 'wallets'] as const;
type LaunchArea = (typeof LAUNCH)[number];

/** Správa → Údržba: vynulování po testování (XP, úspěchy, rating, statistiky, peněženky, otevřené hry). */
export function MaintenancePage() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [areas, setAreas] = useState<Record<Area, boolean>>({ games: false, xp: false, achievements: false, rating: false, stats: false, wallets: false });
  const [word, setWord] = useState('');
  const [launch, setLaunch] = useState<Record<LaunchArea, boolean>>({ games: false, progress: false, history: false, chat: false, notifications: false, wallets: false });
  const [launchWord, setLaunchWord] = useState('');
  const [sinceText, setSinceText] = useState('');
  const [since, setSince] = useState<Record<SinceArea, boolean>>({ history: true, stats: true, chat: true, notifications: true });
  const [sinceCounts, setSinceCounts] = useState<SinceCounts | null>(null);
  const [sinceWord, setSinceWord] = useState('');
  const sinceMs = sinceText ? new Date(sinceText).getTime() : NaN;
  const sinceValid = Number.isFinite(sinceMs) && sinceMs < Date.now() + 86_400_000;
  const [users, setUsers] = useState<UserRow[]>([]);
  const [delIds, setDelIds] = useState<string[]>([]);
  const [resetWord, setResetWord] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => {
    get<Counts>('/api/admin/maintenance')
      .then(setCounts)
      .catch((e) => setMsg({ kind: 'error', text: errorText(e) }));
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => {
    if (!sinceValid) {
      setSinceCounts(null);
      return;
    }
    get<SinceCounts>(`/api/admin/maintenance/since?from=${sinceMs}`)
      .then(setSinceCounts)
      .catch(() => setSinceCounts(null));
  }, [sinceValid, sinceMs, msg]);
  const runSince = async () => {
    if (!confirm(t('since.confirm', { from: new Date(sinceMs).toLocaleString('cs-CZ') }))) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<{ done: Record<string, number> }>('/api/admin/maintenance/purge-since', { from: sinceMs, ...since });
      setMsg({ kind: 'success', text: t('since.done', { detail: Object.entries(r.done).map(([k, v]) => `${t(`since.done.${k}`)}: ${v}`).join(', ') }) });
      setSinceWord('');
      reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const hint = (a: Area): string => {
    if (!counts) return '';
    switch (a) {
      case 'games':
        return t('maintenance.count.games', { tables: counts.openTables, tournaments: counts.activeTournaments });
      case 'xp':
        return t('maintenance.count.xp', { events: counts.xpEvents, players: counts.players });
      case 'achievements':
        return t('maintenance.count.achievements', { n: counts.achievements });
      case 'rating':
        return t('maintenance.count.rating', { n: counts.ratings });
      case 'stats':
        return t('maintenance.count.stats', { hands: counts.hands, results: counts.results });
      case 'wallets':
        return t('maintenance.count.wallets');
    }
  };
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<{ done: Record<string, number> }>('/api/admin/maintenance/reset', areas);
      setMsg({ kind: 'success', text: t('maintenance.done', { detail: Object.entries(r.done).map(([k, v]) => `${t(`maintenance.done.${k}`)}: ${v}`).join(', ') }) });
      setWord('');
      reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    get<UserRow[]>('/api/admin/users').then(setUsers).catch(() => undefined);
  }, []);
  const { me } = useSession();
  const deletable = users.filter((u) => u.id !== me?.user.id && !u.roles.some((r) => /hlavní/i.test(r.role ?? '')));
  const anyLaunch = LAUNCH.some((a) => launch[a]) || delIds.length > 0;
  const launchHint = (a: LaunchArea): string => {
    if (!counts) return '';
    switch (a) {
      case 'games':
        return t('launch.count.games', { tables: counts.openTables, tournaments: counts.activeTournaments });
      case 'progress':
        return t('launch.count.progress', { hands: counts.hands, results: counts.results, xp: counts.xpEvents });
      case 'history':
        return t('launch.count.history', { n: counts.historyItems });
      case 'chat':
        return t('launch.count.chat', { messages: counts.chatMessages, images: counts.chatImages });
      case 'notifications':
        return t('launch.count.notifications', { n: counts.notifications });
      case 'wallets':
        return t('launch.count.wallets', { players: counts.walletsNonZero, total: counts.walletsTotal });
    }
  };
  const runLaunch = async () => {
    if (!confirm(t('launch.confirm'))) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<{ done: Record<string, number> }>('/api/admin/maintenance/launch', { ...launch, userIds: delIds });
      setDelIds([]);
      get<UserRow[]>('/api/admin/users').then(setUsers).catch(() => undefined);
      setMsg({ kind: 'success', text: t('launch.done', { detail: Object.entries(r.done).map(([k, v]) => `${t(`launch.done.${k}`)}: ${v}`).join(', ') }) });
      setLaunchWord('');
      reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const runFactoryReset = async () => {
    if (!confirm(t('factory.confirm'))) return;
    setBusy(true);
    setMsg(null);
    try {
      await post('/api/admin/maintenance/factory-reset', { confirm: resetWord.trim() });
      setMsg({ kind: 'success', text: t('factory.done') });
      setResetWord('');
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const any = AREAS.some((a) => areas[a]);
  const [ledgerWord, setLedgerWord] = useState('');
  const resetLedger = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<{ transactionsDeleted: number; users: number }>('/api/admin/maintenance/reset-ledger');
      setMsg({ kind: 'success', text: t('maintenance.ledgerDone', { n: r.transactionsDeleted, users: r.users }) });
      setLedgerWord('');
      reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Notice kind="error">{t('maintenance.warning')}</Notice>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <Card title={t('launch.title')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm">{t('launch.help')}</p>
          <p className="rounded-md border border-success px-2 py-1 text-sm">{t('launch.keeps')}</p>
          <div className="flex gap-2">
            <Button onClick={() => setLaunch(Object.fromEntries(LAUNCH.map((a) => [a, true])) as Record<LaunchArea, boolean>)}>{t('launch.selectAll')}</Button>
            <Button onClick={() => setLaunch(Object.fromEntries(LAUNCH.map((a) => [a, false])) as Record<LaunchArea, boolean>)}>{t('launch.selectNone')}</Button>
          </div>
          {LAUNCH.map((a) => (
            <label key={a} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2 font-medium">
                <input type="checkbox" checked={launch[a]} onChange={(e) => setLaunch({ ...launch, [a]: e.target.checked })} />
                {t(`launch.area.${a}`)}
              </span>
              <span className="pl-6 text-sm text-muted">
                {t(`launch.help.${a}`)} <strong>{launchHint(a)}</strong>
              </span>
            </label>
          ))}
          <div className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2 font-medium">
              {t('launch.area.users')}
              <Button onClick={() => setDelIds(deletable.map((u) => u.id))}>{t('launch.users.all')}</Button>
              <Button onClick={() => setDelIds([])}>{t('launch.users.none')}</Button>
            </span>
            <span className="text-sm text-muted">{t('launch.help.users', { n: delIds.length })}</span>
            <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-md border border-line p-2">
              {deletable.map((u) => (
                <li key={u.id}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={delIds.includes(u.id)} onChange={(e) => setDelIds(e.target.checked ? [...delIds, u.id] : delIds.filter((x) => x !== u.id))} />
                    {u.nickname}
                    {u.status === 'blocked' && <span className="text-xs text-muted">({t('admin.blocked')})</span>}
                  </label>
                </li>
              ))}
              {deletable.length === 0 && <li className="text-sm text-muted">{t('launch.users.empty')}</li>}
            </ul>
          </div>
          <TextInput label={t('maintenance.confirmLabel', { word: CONFIRM_WORD })} value={launchWord} onChange={(e) => setLaunchWord(e.target.value)} />
          <div>
            <Button variant="danger" disabled={busy || !anyLaunch || launchWord.trim() !== CONFIRM_WORD} onClick={() => void runLaunch()}>
              {t('launch.run')}
            </Button>
          </div>
        </div>
      </Card>
      <Card title={t('since.title')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm">{t('since.help')}</p>
          <TextInput type="datetime-local" label={t('since.from')} value={sinceText} onChange={(e) => setSinceText(e.target.value)} />
          {SINCE.map((a) => (
            <label key={a} className="flex items-center gap-2 font-medium">
              <input type="checkbox" checked={since[a]} onChange={(e) => setSince({ ...since, [a]: e.target.checked })} />
              {t(`since.area.${a}`)}
            </label>
          ))}
          {sinceCounts && <p className="text-sm font-medium">{t('since.count', { ...sinceCounts })}</p>}
          <TextInput label={t('maintenance.confirmLabel', { word: CONFIRM_WORD })} value={sinceWord} onChange={(e) => setSinceWord(e.target.value)} />
          <div>
            <Button variant="danger" disabled={busy || !sinceValid || !SINCE.some((a) => since[a]) || sinceWord.trim() !== CONFIRM_WORD} onClick={() => void runSince()}>
              {t('since.run')}
            </Button>
          </div>
        </div>
      </Card>
      <Card title={t('maintenance.title')}>
        <div className="flex flex-col gap-3">
          {AREAS.map((a) => (
            <label key={a} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2 font-medium">
                <input type="checkbox" checked={areas[a]} onChange={(e) => setAreas({ ...areas, [a]: e.target.checked })} />
                {t(`maintenance.area.${a}`)}
              </span>
              <span className="pl-6 text-sm text-muted">
                {t(`maintenance.help.${a}`)} {hint(a)}
              </span>
            </label>
          ))}
          <TextInput label={t('maintenance.confirmLabel', { word: CONFIRM_WORD })} value={word} onChange={(e) => setWord(e.target.value)} />
          <div>
            <Button variant="danger" disabled={busy || !any || word.trim() !== CONFIRM_WORD} onClick={() => void run()}>
              {t('maintenance.run')}
            </Button>
          </div>
        </div>
      </Card>
      <Card title={t('factory.title')}>
        <div className="flex flex-col gap-3">
          <Notice kind="error">{t('factory.warning')}</Notice>
          <p className="text-sm text-muted">{t('factory.help')}</p>
          <TextInput label={t('maintenance.confirmLabel', { word: RESET_WORD })} value={resetWord} onChange={(e) => setResetWord(e.target.value)} />
          <div>
            <Button variant="danger" disabled={busy || resetWord.trim() !== RESET_WORD} onClick={() => void runFactoryReset()}>
              {t('factory.run')}
            </Button>
          </div>
        </div>
      </Card>
      <Card title={t('maintenance.ledgerTitle')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t('maintenance.ledgerHelp')}</p>
          <TextInput label={t('maintenance.confirmLabel', { word: CONFIRM_WORD })} value={ledgerWord} onChange={(e) => setLedgerWord(e.target.value)} />
          <div>
            <Button variant="danger" disabled={busy || ledgerWord.trim() !== CONFIRM_WORD} onClick={() => void resetLedger()}>
              {t('maintenance.ledgerRun')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
