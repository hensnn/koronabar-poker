import { useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../api';
import { sendMessage, useChatStore } from '../chat-store';
import { Link } from '../router';
import { Badge, Button } from '../ui';
import { HandCard } from './hand-share';

const TOKEN = /\{\{(turnaj|stul|anketa|ruka):([\w-]{1,80})\}\}/g;

interface TournamentBrief {
  name: string;
  status: string;
  players: number;
  seats: number;
  buyIn: number;
  fee: number;
  schedule: { startAt: number } | null;
}
interface TableBrief {
  id: string;
  name: string;
  seats: number;
  seated: number;
  smallBlind: number;
  bigBlind: number;
}

function TournamentCard({ id }: { id: string }) {
  const [v, setV] = useState<TournamentBrief | null | undefined>(undefined);
  useEffect(() => {
    get<TournamentBrief>(`/api/tournaments/${id}`)
      .then(setV)
      .catch(() => setV(null));
  }, [id]);
  if (v === undefined) return null;
  if (v === null) return <span className="text-sm text-muted">{t('chat.card.gone')}</span>;
  const open = v.status === 'registering';
  return (
    <div className="my-1 flex flex-wrap items-center gap-2 rounded-md border border-line bg-raised px-3 py-2">
      <div className="flex flex-col">
        <span className="text-xs text-muted">{t('chat.card.tournament')}</span>
        <strong>{v.name}</strong>
        <span className="text-sm text-muted">
          {t('chat.card.players', { n: v.players })} · {v.buyIn + v.fee}
          {v.schedule && v.status === 'registering' ? ` · ${new Date(v.schedule.startAt).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' })}` : ''}
        </span>
      </div>
      <Badge tone={open ? 'success' : 'muted'}>{t(`tournament.status.${v.status}`)}</Badge>
      <Link to={`/turnaj/${id}`} className="rounded-md border border-line bg-surface px-3 py-1">
        {open ? t('chat.card.register') : t('chat.card.open')}
      </Link>
    </div>
  );
}

function PollCard({ id }: { id: string }) {
  const [v, setV] = useState<{ title: string; status: string; canVote: boolean; voted: boolean } | null | undefined>(undefined);
  useEffect(() => {
    get<{ title: string; status: string; canVote: boolean; voted: boolean }>(`/api/polls/${id}`)
      .then(setV)
      .catch(() => setV(null));
  }, [id]);
  if (v === undefined) return null;
  if (v === null) return <span className="text-sm text-muted">{t('polls.card.gone')}</span>;
  return (
    <div className="my-1 flex flex-wrap items-center gap-2 rounded-md border border-line bg-raised px-3 py-2">
      <div className="flex flex-col">
        <span className="text-xs text-muted">{t('polls.title.page')}</span>
        <strong>{v.title}</strong>
      </div>
      <Badge tone={v.status === 'open' ? 'success' : 'muted'}>{t(`polls.status.${v.status}`)}</Badge>
      <Link to={`/ankety/${id}`} className="rounded-md border border-line bg-surface px-3 py-1">
        {v.canVote ? t('polls.card.vote') : t('polls.card.open')}
      </Link>
    </div>
  );
}

function TableCard({ id }: { id: string }) {
  const [v, setV] = useState<TableBrief | null | undefined>(undefined);
  useEffect(() => {
    get<{ tables: TableBrief[] }>('/api/lobby')
      .then((d) => setV(d.tables.find((x) => x.id === id) ?? null))
      .catch(() => setV(null));
  }, [id]);
  if (v === undefined) return null;
  if (v === null) return <span className="text-sm text-muted">{t('chat.card.gone')}</span>;
  return (
    <div className="my-1 flex flex-wrap items-center gap-2 rounded-md border border-line bg-raised px-3 py-2">
      <div className="flex flex-col">
        <span className="text-xs text-muted">{t('chat.card.table')}</span>
        <strong>{v.name}</strong>
        <span className="text-sm text-muted">
          {v.seated}/{v.seats} · {v.smallBlind}/{v.bigBlind}
        </span>
      </div>
      <Link to={`/stul/${id}`} className="rounded-md border border-line bg-surface px-3 py-1">
        {t('chat.card.join')}
      </Link>
    </div>
  );
}

/** Text zprávy s odkazy na turnaje a stoly zobrazenými jako karty s tlačítkem. */
export function RichBody({ body }: { body: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(body.slice(last, at));
    parts.push(m[1] === 'ruka' ? <HandCard key={at} id={m[2]!} /> : m[1] === 'turnaj' ? <TournamentCard key={at} id={m[2]!} /> : m[1] === 'anketa' ? <PollCard key={at} id={m[2]!} /> : <TableCard key={at} id={m[2]!} />);
    last = at + m[0].length;
  }
  if (parts.length === 0) return <p className="whitespace-pre-wrap break-words">{body}</p>;
  if (last < body.length) parts.push(body.slice(last));
  return <div className="whitespace-pre-wrap break-words">{parts}</div>;
}

/** Tlačítko „Sdílet v chatu“: pošle do hlavního kanálu kartu turnaje nebo stolu. */
export function ShareToChat({ kind, id }: { kind: 'turnaj' | 'stul'; id: string }) {
  const { channels } = useChatStore();
  const [msg, setMsg] = useState('');
  const main = channels.find((c) => c.key === 'hospoda') ?? channels.find((c) => c.kind === 'public');
  if (!main) return null;
  return (
    <>
      <Button
        onClick={async () => {
          try {
            await sendMessage(main.id, `{{${kind}:${id}}}`);
            setMsg(t('chat.shared'));
          } catch (e) {
            setMsg(errorText(e));
          }
        }}
      >
        {t('chat.share')}
      </Button>
      {msg && (
        <span role="status" className="text-sm text-muted">
          {msg}
        </span>
      )}
    </>
  );
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Nahraje obrázek na server a vrátí jeho id (obrázek se ke zprávě připojí při odeslání). */
export async function uploadChatImage(file: File): Promise<string> {
  const r = await post<{ id: string }>('/api/chat/images', { data: toBase64(await file.arrayBuffer()) });
  return r.id;
}

export const chatImageUrl = (id: string) => `/api/chat/images/${id}`;
