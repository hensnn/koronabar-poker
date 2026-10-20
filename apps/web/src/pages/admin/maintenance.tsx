import { useCallback, useEffect, useState } from 'react';
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
const LAUNCH = ['games', 'progress', 'history', 'chat', 'notifications', 'wallets'] as const;
type LaunchArea = (typeof LAUNCH)[number];

/** Správa → Údržba: vynulování po testování (XP, úspěchy, rating, statistiky, peněženky, otevřené hry). */
export function MaintenancePage() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [areas, setAreas] = useState<Record<Area, boolean>>({ games: false, xp: true, achievements: true, rating: true, stats: true, wallets: false });
  const [word, setWord] = useState('');
  const [launch, setLaunch] = useState<Record<LaunchArea, boolean>>({ games: true, progress: true, history: true, chat: true, notifications: true, wallets: true });
  const [launchWord, setLaunchWord] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => {
    get<Counts>('/api/admin/maintenance')
      .then(setCounts)
      .catch((e) => setMsg({ kind: 'error', text: errorText(e) }));
  }, []);
  useEffect(reload, [reload]);
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
  const anyLaunch = LAUNCH.some((a) => launch[a]);
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
      const r = await post<{ done: Record<string, number> }>('/api/admin/maintenance/launch', launch);
      setMsg({ kind: 'success', text: t('launch.done', { detail: Object.entries(r.done).map(([k, v]) => `${t(`launch.done.${k}`)}: ${v}`).join(', ') }) });
      setLaunchWord('');
      reload();
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
          <TextInput label={t('maintenance.confirmLabel', { word: CONFIRM_WORD })} value={launchWord} onChange={(e) => setLaunchWord(e.target.value)} />
          <div>
            <Button variant="danger" disabled={busy || !anyLaunch || launchWord.trim() !== CONFIRM_WORD} onClick={() => void runLaunch()}>
              {t('launch.run')}
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
