import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get } from '../api';
import {
  createChannel,
  deleteMessage,
  editMessage,
  loadChannels,
  muteUser,
  notifyTyping,
  openChannel,
  pinMessage,
  reactTo,
  searchMessages,
  sendMessage,
  setNotifyMuted,
  setActive,
  setIgnore,
  startDm,
  startGroup,
  useChatStore,
  type Channel,
  type Message,
} from '../chat-store';
import { useNet } from '../net';
import { can, useSession } from '../session';
import { saveUserSetting, useSettings } from '../settings';
import { previewSound, useSoundState } from '../sound-client';
import { SoundPalette } from './sounds';
import { RankBadge } from '../progress-client';
import { LookName, LookTitle } from '../cosmetics-client';
import { chatImageUrl, RichBody, uploadChatImage } from './chat-extras';
import { Badge, Button, Card, Modal, Notice, TextInput } from '../ui';

/** Text chyby z chatu (kód z brány, např. CHAT_MUTED). */
const errMsg = (e: unknown): string => {
  const { code, params } = e as { code?: string; params?: Record<string, unknown> };
  const key = `error.${code ?? 'UNKNOWN'}`;
  const msg = t(key, params);
  return msg === key ? t('error.UNKNOWN') : msg;
};

export function ChatPage() {
  const store = useChatStore();
  const { me } = useSession();
  const net = useNet();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'dm' | 'group' | 'channel' | 'search'>(null);

  useEffect(() => {
    void loadChannels().catch(() => undefined);
    return () => setActive(null);
  }, []);
  useEffect(() => {
    if (!activeId && store.channels[0]) setActiveId(store.channels.find((c) => c.kind === 'public')?.id ?? store.channels[0].id);
  }, [store.channels, activeId]);
  const channel = store.channels.find((c) => c.id === activeId) ?? null;

  const groups: { title: string; list: Channel[] }[] = [
    { title: t('chat.group.public'), list: store.channels.filter((c) => c.kind === 'public') },
    { title: t('chat.group.tables'), list: store.channels.filter((c) => c.kind === 'table') },
    { title: t('chat.group.groups'), list: store.channels.filter((c) => c.kind === 'group') },
    { title: t('chat.group.dm'), list: store.channels.filter((c) => c.kind === 'dm') },
  ];

  return (
    <div className="grid gap-3 md:grid-cols-[16rem_1fr]">
      <aside className="flex flex-col gap-3">
        {groups.map((g) => (
          <Card key={g.title} title={g.title}>
            <ul className="flex flex-col gap-1">
              {g.list.map((c) => (
                <li key={c.id}>
                  <button className={`flex w-full items-center justify-between rounded-sm px-2 py-1 text-left ${c.id === activeId ? 'bg-primary text-on-primary' : 'bg-surface'}`} onClick={() => setActiveId(c.id)}>
                    <span className="truncate">{c.name}</span>
                    {c.unread > 0 && <Badge tone="danger">{c.unread}</Badge>}
                  </button>
                </li>
              ))}
              {g.list.length === 0 && <li className="text-sm text-muted">{t('chat.none')}</li>}
            </ul>
          </Card>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDialog('dm')}>{t('chat.newDm')}</Button>
          <Button onClick={() => setDialog('group')}>{t('chat.newGroup')}</Button>
          {(can(me, 'chat.spravovat_kanaly') || can(me, 'chat.vytvorit_kanal')) && <Button onClick={() => setDialog('channel')}>{t('chat.newChannel')}</Button>}
          <Button onClick={() => setDialog('search')}>{t('chat.search')}</Button>
        </div>
        <Card title={t('chat.online', { n: net.presence.length })}>
          <ul className="flex flex-col gap-1 text-sm">
            {net.presence.map((p) => (
              <li key={p.userId} className="flex items-center justify-between">
                <button className="underline" onClick={() => p.userId !== me?.user.id && void startDm(p.userId).then(setActiveId)}>
                  {p.nickname}
                </button>
                {p.status === 'table' && <Badge tone="success">{t('chat.atTable')}</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      </aside>
      <section>{channel ? <ChatPanel key={channel.id} channel={channel} /> : <Notice>{t('chat.select')}</Notice>}</section>
      {dialog === 'dm' && <PickUserDialog title={t('chat.newDm')} multiple={false} onClose={() => setDialog(null)} onPick={async (ids) => { const id = await startDm(ids[0]!); setActiveId(id); setDialog(null); }} />}
      {dialog === 'group' && <PickUserDialog title={t('chat.newGroup')} multiple named onClose={() => setDialog(null)} onPick={async (ids, name) => { const id = await startGroup(name ?? '', ids); setActiveId(id); setDialog(null); }} />}
      {dialog === 'channel' && <NewChannelDialog onClose={() => setDialog(null)} onCreated={(id) => { setActiveId(id); setDialog(null); }} />}
      {dialog === 'search' && <SearchDialog onClose={() => setDialog(null)} onOpen={(id) => { setActiveId(id); setDialog(null); }} />}
    </div>
  );
}

/** Panel jednoho kanálu: zprávy a pole pro psaní. Používá ho stránka chatu i okno u stolu. */
export function ChatPanel({ channel, compact, fill, listHeight }: { channel: Channel; compact?: boolean; /** Vyplní výšku rodiče (celoobrazovkový chat u stolu). */ fill?: boolean; /** Pevná výška seznamu zpráv v okně u stolu. */ listHeight?: number }) {
  const store = useChatStore();
  const { me } = useSession();
  const settings = useSettings();
  const [error, setError] = useState('');
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [body, setBody] = useState('');
  const [image, setImage] = useState<{ id: string; name: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  const messages = store.messages[channel.id] ?? [];
  const typing = (store.typing[channel.id] ?? []).filter((x) => Date.now() - x.at < 4000);
  const emojis = String(settings.values['chat.emojiList']).split(',').map((e) => e.trim()).filter(Boolean);
  const nick = useMemo(() => new Map(messages.map((m) => [m.id, m.nickname ?? ''])), [messages]);

  useEffect(() => {
    void openChannel(channel.id).catch((e) => setError(errMsg(e)));
    return () => setActive(null);
  }, [channel.id]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, channel.id]);

  const submit = async () => {
    const text = body.trim();
    if (!text && !(image && !editing)) return;
    try {
      if (editing) await editMessage(editing.id, text);
      else await sendMessage(channel.id, text, reply?.id, image?.id);
      setImage(null);
      setBody('');
      setReply(null);
      setEditing(null);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const canMod = can(me, 'chat.mazat_zpravy');
  // U stolu jde skrýt zprávy o hře (systémové) a zprávy hráčů; volba je osobní a synchronizuje se.
  const showSystem = settings.values['chat.showSystemAtTable'] !== false;
  const showPlayers = settings.values['chat.showPlayersAtTable'] !== false;
  const shown = compact ? messages.filter((m) => (m.system ? showSystem : showPlayers)) : messages;
  const toggle = (key: string, value: boolean) => void saveUserSetting(key, value).catch((e: unknown) => setError(errMsg(e)));
  return (
    <div className={`flex flex-col ${compact ? 'gap-1 text-sm' : 'gap-2'} ${fill ? 'h-full min-h-0' : ''}`}>
      {compact && (
        <div className="flex items-center gap-1 text-xs">
          <button className={`rounded-sm border px-2 ${showSystem ? 'border-primary bg-primary text-on-primary' : 'border-line bg-surface text-muted'}`} aria-pressed={showSystem} onClick={() => toggle('chat.showSystemAtTable', !showSystem)}>
            {t('chat.filterGame')}
          </button>
          <button className={`rounded-sm border px-2 ${showPlayers ? 'border-primary bg-primary text-on-primary' : 'border-line bg-surface text-muted'}`} aria-pressed={showPlayers} onClick={() => toggle('chat.showPlayersAtTable', !showPlayers)}>
            {t('chat.filterPlayers')}
          </button>
        </div>
      )}
      {!compact && (
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-heading text-xl font-bold">{channel.name}</h2>
          {channel.kind !== 'table' && (
            <Button aria-pressed={channel.notifyMuted} title={channel.notifyMuted ? t('chat.notifyUnmute') : t('chat.notifyMute')} onClick={() => void setNotifyMuted(channel.id, !channel.notifyMuted).catch((e) => setError(errMsg(e)))}>
              {channel.notifyMuted ? '🔕' : '🔔'}
            </Button>
          )}
        </div>
      )}
      <div ref={listRef} className={`flex flex-col overflow-y-auto rounded-md border border-line bg-surface ${fill ? 'min-h-0 flex-1 gap-0 p-1 leading-tight' : compact ? `min-h-16 gap-0 p-1 leading-tight ${listHeight ? '' : 'h-32 resize-y'}` : 'h-96 gap-2 p-2'}`} aria-live="polite" aria-label={t('chat.messages')} style={!fill && compact && listHeight ? { height: listHeight } : undefined}>
        {messages.length >= 50 && (
          <Button onClick={() => void openChannel(channel.id, messages[0]!.id)}>{t('chat.older')}</Button>
        )}
        {shown.map((m) => (
          <div key={m.id} className={`rounded-sm px-2 ${compact ? 'py-0' : 'py-1'} ${m.system ? 'text-muted' : ''} ${m.mentions.includes(me?.user.id ?? '') ? 'bg-raised' : ''}`}>
            {m.system ? (
              <em className="not-italic">
                <RichBody body={m.body} />
              </em>
            ) : m.deleted ? (
              <em className="text-muted">{t('chat.deleted')}</em>
            ) : (
              <>
                <div className="flex flex-wrap items-baseline gap-2">
                  <strong>
                    {settings.values['xp.showInChat'] !== false && <RankBadge userId={m.userId} />} <LookName userId={m.userId}>{m.nickname}</LookName>
                  </strong>
                  <LookTitle userId={m.userId} />
                  <time className="text-xs text-muted" dateTime={m.createdAt}>
                    {new Date(m.createdAt).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}
                  </time>
                  {m.editedAt && <span className="text-xs text-muted">({t('chat.edited')})</span>}
                  {m.pinned && <Badge tone="warning">{t('chat.pinned')}</Badge>}
                </div>
                {m.replyTo && <p className="border-l-2 border-line pl-2 text-sm text-muted">{t('chat.replyTo', { nick: nick.get(m.replyTo) ?? '…' })}</p>}
                {m.body && <MessageBody body={m.body} />}
                {m.image && <img src={chatImageUrl(m.image)} alt={t('chat.image')} loading="lazy" className="mt-1 max-h-64 max-w-full rounded-sm border border-line" />}
                <div className={`flex flex-wrap items-center gap-1 text-sm ${compact ? 'hidden' : 'mt-1'}`}>
                  {Object.entries(m.reactions).map(([emoji, users]) => (
                    <button key={emoji} className={`rounded-sm border px-1 ${users.includes(me?.user.id ?? '') ? 'border-primary' : 'border-line'}`} onClick={() => void reactTo(m.id, emoji).catch((e) => setError(errMsg(e)))} aria-label={`${emoji} ${users.length}`}>
                      {emoji} {users.length}
                    </button>
                  ))}
                  <details className="inline">
                    <summary className="cursor-pointer text-muted">{t('chat.react')}</summary>
                    <span className="flex flex-wrap gap-1">
                      {emojis.map((e) => (
                        <button key={e} onClick={() => void reactTo(m.id, e).catch((er) => setError(errMsg(er)))}>
                          {e}
                        </button>
                      ))}
                    </span>
                  </details>
                  <button className="text-muted underline" onClick={() => setReply(m)}>
                    {t('chat.reply')}
                  </button>
                  {m.userId === me?.user.id && (
                    <button className="text-muted underline" onClick={() => { setEditing(m); setBody(m.body); }}>
                      {t('chat.edit')}
                    </button>
                  )}
                  {(m.userId === me?.user.id || canMod) && (
                    <button className="text-muted underline" onClick={() => void deleteMessage(m.id).catch((e) => setError(errMsg(e)))}>
                      {t('chat.delete')}
                    </button>
                  )}
                  {can(me, 'chat.pripinat') && (
                    <button className="text-muted underline" onClick={() => void pinMessage(m.id, !m.pinned).catch((e) => setError(errMsg(e)))}>
                      {m.pinned ? t('chat.unpin') : t('chat.pin')}
                    </button>
                  )}
                  {m.userId && m.userId !== me?.user.id && (
                    <>
                      <button className="text-muted underline" onClick={() => void setIgnore(m.userId!, true).then(() => openChannel(channel.id))}>
                        {t('chat.ignore')}
                      </button>
                      {can(me, 'chat.ztlumit') && (
                        <button
                          className="text-muted underline"
                          onClick={() => {
                            const hours = Number(prompt(t('chat.muteHours'), '1'));
                            const reason = prompt(t('chat.muteReason'), '');
                            if (hours > 0 && reason) void muteUser(m.userId!, hours, reason, channel.id).catch((e) => setError(errMsg(e)));
                          }}
                        >
                          {t('chat.mute')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <p className="h-5 text-sm text-muted" aria-live="polite">
        {typing.length > 0 && t('chat.typing', { names: typing.map((x) => x.nickname).join(', ') })}
      </p>
      {(reply || editing) && (
        <div className="flex items-center justify-between rounded-sm bg-raised px-2 py-1 text-sm">
          <span>{editing ? t('chat.editing') : t('chat.replyTo', { nick: reply?.nickname ?? '' })}</span>
          <button className="underline" onClick={() => { setReply(null); setEditing(null); setBody(''); }}>
            {t('table.cancel')}
          </button>
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {image && (
        <div className="flex items-center gap-2 text-sm">
          <img src={chatImageUrl(image.id)} alt="" className="h-12 rounded-sm border border-line" />
          <span className="truncate">{image.name}</span>
          <button className="underline" onClick={() => setImage(null)}>
            {t('chat.removeImage')}
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <textarea
          aria-label={t('chat.compose')}
          className="min-h-12 flex-1 rounded-sm border border-line bg-surface px-2 py-1"
          value={body}
          maxLength={Number(settings.values['chat.maxLength'])}
          onChange={(e) => {
            setBody(e.target.value);
            if (Date.now() - lastTyping.current > 2500) {
              lastTyping.current = Date.now();
              notifyTyping(channel.id);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <label className="cursor-pointer rounded-md border border-line bg-surface px-3 py-1" title={t('chat.attachImage')}>
          <span aria-hidden>🖼</span>
          <span className="sr-only">{t('chat.attachImage')}</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                setImage({ id: await uploadChatImage(f), name: f.name });
                setError('');
              } catch (err) {
                setError(errorText(err));
              }
            }}
          />
        </label>
        <SoundPalette target={{ kind: 'channel', id: channel.id }} />
        <Button variant="primary" onClick={() => void submit()}>
          {t('chat.send')}
        </Button>
      </div>
    </div>
  );
}

interface DirUser {
  id: string;
  nickname: string;
}

function PickUserDialog({ title, multiple, named, onClose, onPick }: { title: string; multiple: boolean; named?: boolean; onClose: () => void; onPick: (ids: string[], name?: string) => Promise<void> }) {
  const { me } = useSession();
  const [users, setUsers] = useState<DirUser[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    void get<DirUser[]>('/api/directory').then((u) => setUsers(u.filter((x) => x.id !== me?.user.id)));
  }, [me?.user.id]);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {named && <TextInput label={t('chat.groupName')} value={name} onChange={(e) => setName(e.target.value)} />}
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {users.map((u) => (
            <li key={u.id}>
              <label className="flex items-center gap-2">
                <input type={multiple ? 'checkbox' : 'radio'} name="pick" checked={sel.includes(u.id)} onChange={(e) => setSel(multiple ? (e.target.checked ? [...sel, u.id] : sel.filter((x) => x !== u.id)) : [u.id])} />
                {u.nickname}
              </label>
            </li>
          ))}
        </ul>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button variant="primary" disabled={sel.length === 0 || (!!named && !name.trim())} onClick={() => void onPick(sel, name).catch((e) => setError(errMsg(e)))}>
            {t('table.confirm')}
          </Button>
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}

function NewChannelDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  return (
    <Modal title={t('chat.newChannel')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <TextInput label={t('chat.channelName')} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void createChannel(name).then(onCreated).catch((e) => setError(errMsg(e)))}>
            {t('table.confirm')}
          </Button>
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}

function SearchDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (channelId: string) => void }) {
  const store = useChatStore();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Message[] | null>(null);
  const [error, setError] = useState('');
  return (
    <Modal title={t('chat.search')} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          searchMessages(q).then(setRows).catch((er) => setError(errMsg(er)));
        }}
      >
        <TextInput label={t('chat.searchText')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <Button variant="primary" type="submit">
          {t('chat.search')}
        </Button>
        {error && <Notice kind="error">{error}</Notice>}
        {rows && rows.length === 0 && <Notice>{t('chat.noResults')}</Notice>}
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {(rows ?? []).map((m) => (
            <li key={m.id}>
              <button type="button" className="w-full rounded-sm border border-line p-2 text-left" onClick={() => onOpen(m.channelId)}>
                <span className="text-xs text-muted">{store.channels.find((c) => c.id === m.channelId)?.name} · {m.nickname}</span>
                <br />
                {m.body}
              </button>
            </li>
          ))}
        </ul>
      </form>
    </Modal>
  );
}

const SOUND_ONLY = /^:([a-z0-9_]{2,20}):$/;

/** Text zprávy; zpráva jen se zkratkou zvukového emotikonu se zobrazí jako tlačítko pro přehrání. */
function MessageBody({ body }: { body: string }) {
  const st = useSoundState();
  const m = SOUND_ONLY.exec(body);
  const sound = m ? st.sounds.find((s) => s.shortcut === m[1]) : undefined;
  if (sound) {
    return (
      <button className="rounded-sm border border-line bg-surface px-2 py-1" onClick={() => previewSound(sound.id)} aria-label={t('sounds.replay', { name: sound.name })}>
        {sound.emoji} {sound.name} ▶
      </button>
    );
  }
  return <RichBody body={body} />;
}
