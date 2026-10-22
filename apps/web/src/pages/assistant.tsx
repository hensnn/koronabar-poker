import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get, post } from '../api';
import { useLocation, matchPath } from '../router';
import { Badge, Button, Notice } from '../ui';

interface DiffRow {
  key: string;
  label: string;
  before: string;
  after: string;
  timing: 'now' | 'nextHand' | 'denied';
  reason?: string;
}
interface Proposal {
  id: string;
  status: 'pending' | 'applied' | 'rejected' | 'failed' | 'expired';
  summary: string;
  diff: DiffRow[];
  values: Record<string, string | number | boolean>;
}
interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  proposals: Proposal[];
}
interface Status {
  available: boolean;
  used: number;
  max: number;
  warnPercent: number;
  voiceInput: boolean;
  voiceOutput: boolean;
}

type Recognition = { start(): void; stop(): void; lang: string; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null };

/** Kontext asistenta podle stránky, na které uživatel je. */
function contextOf(path: string): { context: string; targetId?: string } {
  const stul = matchPath('/stul/:id', path);
  if (stul) return { context: 'table', targetId: stul.id };
  const turnaj = matchPath('/turnaj/:id', path);
  if (turnaj) return { context: 'planning', targetId: turnaj.id };
  if (path.startsWith('/admin')) return { context: 'admin' };
  if (path === '/vzhled') return { context: 'theme' };
  if (path === '/stoly') return { context: 'planning' };
  if (path === '/nastaveni' || path === '/profil') return { context: 'rules' };
  return { context: 'lobby' };
}

const timingTone = (x: DiffRow['timing']) => (x === 'now' ? 'success' : x === 'nextHand' ? 'warning' : 'danger');

function ProposalCard({ p, onChange }: { p: Proposal; onChange: (p: Proposal) => void }) {
  const [edits, setEdits] = useState<Record<string, string | number | boolean>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = p.status === 'pending';
  const run = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      onChange(await post<Proposal>(`/api/assistant/proposals/${p.id}/${path}`, body));
      setError('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-line bg-raised p-3">
      <div className="flex items-center gap-2">
        <strong>{t('assistant.proposal')}</strong>
        <Badge tone={p.status === 'applied' ? 'success' : p.status === 'pending' ? 'warning' : 'muted'}>{t(`assistant.status.${p.status}`)}</Badge>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted">
            <th />
            <th>{t('assistant.before')}</th>
            <th>{t('assistant.after')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {p.diff.map((r, i) => (
            <tr key={`${r.key}${i}`} className="border-t border-line align-top">
              <td className="pr-2">{r.label}</td>
              <td className="pr-2 text-muted">{r.key ? r.before : ''}</td>
              <td className="pr-2">
                {pending && r.key && r.key in p.values ? (
                  typeof p.values[r.key] === 'boolean' ? (
                    <input type="checkbox" aria-label={r.label} checked={Boolean(edits[r.key] ?? p.values[r.key])} onChange={(e) => setEdits({ ...edits, [r.key]: e.target.checked })} />
                  ) : (
                    <input
                      aria-label={r.label}
                      className="w-24 rounded-sm border border-line bg-surface px-1"
                      type={typeof p.values[r.key] === 'number' ? 'number' : 'text'}
                      value={String(edits[r.key] ?? p.values[r.key])}
                      onChange={(e) => setEdits({ ...edits, [r.key]: typeof p.values[r.key] === 'number' ? Number(e.target.value) : e.target.value })}
                    />
                  )
                ) : (
                  r.key && r.after
                )}
              </td>
              <td>{r.key && <Badge tone={timingTone(r.timing)}>{t(`assistant.diff.timing.${r.timing}`)}</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <Notice kind="error">{error}</Notice>}
      {pending && (
        <div className="flex gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void run('confirm', { edits })}>
            {t('assistant.confirm')}
          </Button>
          <Button disabled={busy} onClick={() => void run('reject')}>
            {t('assistant.reject')}
          </Button>
        </div>
      )}
    </div>
  );
}

const OPEN_EVENT = 'kb:assistant-open';

/** Položka asistenta v hlavní nabídce na telefonu (plovoucí tlačítko tam překáží); otevře okno asistenta. */
export function AssistantMenuItem({ onPick }: { onPick?: () => void }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    get<Status>('/api/assistant/status')
      .then((s) => setAvailable(s.available))
      .catch(() => setAvailable(false));
  }, []);
  if (!available) return null;
  return (
    <button
      className="rounded-md border border-line bg-surface px-3 py-1 md:hidden"
      onClick={() => {
        window.dispatchEvent(new Event(OPEN_EVENT));
        onPick?.();
      }}
    >
      🤖 {t('assistant.title')}
    </button>
  );
}

/** Okno asistenta ve stylu chatu s návrhy změn, které si uživatel potvrdí. */
export function AssistantLauncher() {
  const { path } = useLocation();
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [listening, setListening] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const rec = useRef<Recognition | null>(null);

  const loadStatus = useCallback(() => {
    get<Status>('/api/assistant/status')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useEffect(() => loadStatus(), [loadStatus]);
  useEffect(() => {
    const openIt = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, openIt);
    return () => window.removeEventListener(OPEN_EVENT, openIt);
  }, []);
  useEffect(() => {
    if (!open) return;
    get<{ messages: Msg[] }>('/api/assistant/history')
      .then((d) => setMsgs(d.messages))
      .catch(() => undefined);
  }, [open]);
  useEffect(() => {
    // scrollIntoView může v některých prohlížečích vracet hodnotu; efekt nesmí nic vracet
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [msgs, busy]);

  if (!status?.available) return null;

  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setText('');
    setBusy(true);
    setError('');
    setMsgs((m) => [...m, { id: `tmp-${Date.now()}`, role: 'user', content: q, proposals: [] }]);
    try {
      const r = await post<{ reply: string; proposals: Proposal[] }>('/api/assistant/chat', { text: q, ...contextOf(path) });
      setMsgs((m) => [...m, { id: `a-${Date.now()}`, role: 'assistant', content: r.reply, proposals: r.proposals }]);
      if (status.voiceOutput && r.reply && 'speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(r.reply);
        u.lang = 'cs-CZ';
        window.speechSynthesis.speak(u);
      }
      loadStatus();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const dictate = () => {
    const Ctor = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
    if (!Ctor) return;
    if (listening) {
      rec.current?.stop();
      return;
    }
    const r = new Ctor();
    r.lang = 'cs-CZ';
    r.onresult = (e) => setText((cur) => `${cur} ${e.results[0]?.[0]?.transcript ?? ''}`.trim());
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };

  const update = (p: Proposal) => setMsgs((m) => m.map((x) => ({ ...x, proposals: x.proposals.map((y) => (y.id === p.id ? p : y)) })));

  return (
    <>
      <button
        className="fixed bottom-4 right-4 z-40 hidden rounded-full border border-line bg-primary px-3 py-2 text-on-primary shadow-lg md:block md:px-4"
        aria-label={t('assistant.open')}
        title={t('assistant.open')}
        onClick={() => setOpen((v) => !v)}
      >
        🤖 <span>{t('assistant.title')}</span>
      </button>
      {open && (
        <section role="dialog" aria-label={t('assistant.title')} className="fixed bottom-16 right-4 z-40 flex max-h-[70vh] w-[min(28rem,calc(100vw-2rem))] flex-col rounded-lg border border-line bg-surface shadow-lg">
          <header className="flex items-center gap-2 border-b border-line p-2">
            <strong className="flex-1">{t('assistant.title')}</strong>
            <span className={`text-xs ${status.max > 0 && status.used * 100 >= status.max * status.warnPercent ? 'font-semibold text-warning' : 'text-muted'}`}>{status.max > 0 ? t('assistant.usage', { used: status.used, max: status.max }) : t('assistant.unlimited')}</span>
            <Button
              onClick={() => {
                if (confirm(t('assistant.clear') + '?')) void del('/api/assistant/history').then(() => setMsgs([]));
              }}
            >
              {t('assistant.clear')}
            </Button>
            <Button onClick={() => setOpen(false)} aria-label="×">
              ×
            </Button>
          </header>
          <div className="flex-1 overflow-y-auto p-2" aria-live="polite">
            {msgs.length === 0 && <p className="text-sm text-muted">{t('assistant.intro')}</p>}
            {msgs.map((m) => (
              <div key={m.id} className={`my-2 flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-full whitespace-pre-wrap break-words rounded-md px-3 py-2 ${m.role === 'user' ? 'bg-primary text-on-primary' : 'bg-raised'}`}>{m.content}</div>
                {m.proposals.map((p) => (
                  <ProposalCard key={p.id} p={p} onChange={update} />
                ))}
              </div>
            ))}
            {busy && <p className="text-sm text-muted">{t('assistant.thinking')}</p>}
            {error && <Notice kind="error">{error}</Notice>}
            <div ref={endRef} />
          </div>
          <footer className="flex items-end gap-2 border-t border-line p-2">
            <textarea
              className="min-h-10 flex-1 rounded-sm border border-line bg-surface px-2 py-1 text-text"
              aria-label={t('assistant.placeholder')}
              placeholder={t('assistant.placeholder')}
              value={text}
              rows={2}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {status.voiceInput && <Button onClick={dictate}>{listening ? t('assistant.voiceStop') : t('assistant.voiceStart')}</Button>}
            <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void send()}>
              {t('assistant.send')}
            </Button>
          </footer>
        </section>
      )}
    </>
  );
}
