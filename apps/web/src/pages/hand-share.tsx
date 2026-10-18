import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get, patch, post } from '../api';
import { onSocket } from '../net';
import { useSession } from '../session';
import { sendMessage, useChatStore } from '../chat-store';
import { Link } from '../router';
import { Badge, Button, Modal, Notice, Spinner, TextInput } from '../ui';
import { HandReplayBody, fmtDate, type HandDetail } from './hand-replay';

interface SharedView {
  shared: { id: string; sharedBy: { userId: string; nickname: string } | null; createdAt: number; pollId: string | null; revealed: string[] };
  hand: HandDetail;
  comments: { id: string; userId: string | null; nickname: string; body: string; at: number; mine: boolean }[];
  reactions: { allowed: string[]; counts: Record<string, number>; mine: string[] };
  canReveal: boolean;
  canModerate: boolean;
}

function useShared(id: string) {
  const [v, setV] = useState<SharedView | null | undefined>(undefined);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    get<SharedView>(`/api/shared-hands/${id}`)
      .then((x) => {
        setV(x);
        setError('');
      })
      .catch((e) => {
        setV(null);
        setError(errorText(e));
      });
  }, [id]);
  useEffect(() => {
    load();
    return onSocket<{ id: string }>('hand:changed', (m) => m.id === id && load());
  }, [id, load]);
  return { v, error, load, setError };
}

function HandViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const session = useSession();
  const me = session.me?.user.id ?? '';
  const { v, error, load, setError } = useShared(id);
  const [text, setText] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError('');
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const iRevealed = !!v && v.shared.revealed.includes(me);
  return (
    <Modal title={v ? t('stats.handTitle', { n: v.hand.handNumber, date: fmtDate(v.hand.playedAt) }) : t('hand.card')} onClose={onClose}>
      {error && <Notice kind="error">{error}</Notice>}
      {v === undefined && <Spinner label={t('app.loading')} />}
      {v && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{v.shared.sharedBy ? t('hand.sharedBy', { nick: v.shared.sharedBy.nickname }) : t('hand.sharedBySystem')}</p>
          <HandReplayBody d={v.hand} me={me} />
          <div className="flex flex-wrap items-center gap-2">
            {v.canReveal && v.hand.players.some((p) => p.userId === me) && (
              <Button onClick={() => void run(() => patch(`/api/shared-hands/${id}`, { reveal: !iRevealed }))}>{iRevealed ? t('hand.revealOn') : t('hand.revealOff')}</Button>
            )}
            {v.shared.pollId && (
              <Link to={`/ankety/${v.shared.pollId}`} className="rounded-md border border-line bg-surface px-3 py-1">
                {t('hand.poll')}
              </Link>
            )}
          </div>
          <div className="flex flex-wrap gap-1" aria-label={t('hand.reactions')}>
            {v.reactions.allowed.map((e) => (
              <button
                key={e}
                className={`rounded-md border px-2 py-1 ${v.reactions.mine.includes(e) ? 'border-primary bg-raised' : 'border-line bg-surface'}`}
                onClick={() => void run(() => post(`/api/shared-hands/${id}/reactions`, { emoji: e }))}
              >
                {e} {v.reactions.counts[e] ?? ''}
              </button>
            ))}
          </div>
          <section className="flex flex-col gap-2">
            <h3 className="font-bold">{t('hand.comments')}</h3>
            {v.comments.length === 0 && <p className="text-sm text-muted">{t('hand.noComments')}</p>}
            {v.comments.map((c) => (
              <div key={c.id} className="flex items-start gap-2 text-sm">
                <strong>{c.nickname}</strong>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{c.body}</span>
                {(c.mine || v.canModerate) && (
                  <Button onClick={() => void run(() => del(`/api/shared-hands/comments/${c.id}`))}>{t('hand.commentDelete')}</Button>
                )}
              </div>
            ))}
            <div className="flex items-end gap-2">
              <TextInput label={t('hand.commentPlaceholder')} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
              <Button
                variant="primary"
                disabled={text.trim().length === 0}
                onClick={() =>
                  void run(async () => {
                    await post(`/api/shared-hands/${id}/comments`, { body: text });
                    setText('');
                  })
                }
              >
                {t('hand.commentSend')}
              </Button>
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}

/** Karta sdílené handy v chatu. */
export function HandCard({ id }: { id: string }) {
  const { v } = useShared(id);
  const [open, setOpen] = useState(false);
  if (v === undefined) return null;
  if (v === null) return <span className="text-sm text-muted">{t('hand.cardGone')}</span>;
  const total = Object.values(v.reactions.counts).reduce((a, b) => a + b, 0);
  return (
    <div className="my-1 flex flex-wrap items-center gap-2 rounded-md border border-line bg-raised px-3 py-2">
      <div className="flex flex-col">
        <span className="text-xs text-muted">{v.shared.sharedBy ? t('hand.sharedBy', { nick: v.shared.sharedBy.nickname }) : t('hand.sharedBySystem')}</span>
        <strong>{t('stats.handTitle', { n: v.hand.handNumber, date: fmtDate(v.hand.playedAt) })}</strong>
      </div>
      {v.comments.length > 0 && <Badge tone="muted">{v.comments.length} 💬</Badge>}
      {total > 0 && <Badge tone="muted">{total} 👍</Badge>}
      <Button onClick={() => setOpen(true)}>{t('hand.open')}</Button>
      {open && <HandViewer id={id} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Tlačítko „Sdílet v chatu“ u přehrané handy: volitelně odkryje vlastní karty a založí anketu. */
import { useFeatures } from '../features';

export function ShareHandButton({ handId }: { handId: string }) {
  const [open, setOpen] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [poll, setPoll] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const { channels } = useChatStore();
  void channels;
  void sendMessage;
  const features = useFeatures();
  // Sdílení handy jde do chatu: bez zapnutého sdílení nebo chatu se tlačítko neukazuje.
  if (!features.shareHands || !features.chat) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('hand.share')}</Button>
      {msg && (
        <span role="status" className="ml-2 text-sm text-muted">
          {msg}
        </span>
      )}
      {open && (
        <Modal title={t('hand.shareTitle')} onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">{t('hand.shareHelp')}</p>
            {error && <Notice kind="error">{error}</Notice>}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> {t('hand.shareReveal')}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={poll} onChange={(e) => setPoll(e.target.checked)} /> {t('hand.sharePoll')}
            </label>
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await post(`/api/stats/hands/${handId}/share`, { reveal, poll });
                    setMsg(t('hand.shared'));
                    setOpen(false);
                  } catch (e) {
                    setError(errorText(e));
                  }
                }}
              >
                {t('hand.shareGo')}
              </Button>
              <Button onClick={() => setOpen(false)}>{t('table.cancel')}</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
