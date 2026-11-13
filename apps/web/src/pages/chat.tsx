import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
import { useFold } from '../fold-state';
import { useNetSelector } from '../net';
import { can, useSession } from '../session';
import { saveUserSetting, useSettings } from '../settings';
import { previewSound, useSoundState } from '../sound-client';
import { SoundPalette } from './sounds';
import { RankBadge } from '../progress-client';
import { LookName, LookTitle } from '../cosmetics-client';
import { chatImageUrl, RichBody, uploadChatImage } from './chat-extras';
import { Badge, Button, Card, Field, Modal, Notice, NumInput, TextInput } from '../ui';

/** Prázdný seznam zpráv se stálou identitou (nový `[]` při každém vykreslení by rušil memoizaci). */
const NO_MESSAGES: Message[] = [];
/** Seznam se považuje za „dole“, když od konce chybí nejvýš tolik bodů. */
const STICK_SLACK = 24;

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
  const presence = useNetSelector((n) => n.presence);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'dm' | 'group' | 'channel' | 'search'>(null);

  useEffect(() => {
    void loadChannels().catch(() => undefined);
    return () => setActive(null);
  }, []);
  // Nevybraná nebo zmizelá místnost (např. po vypnutí skupin) se nahradí hlavním kanálem.
  useEffect(() => {
    if ((!activeId || !store.channels.some((c) => c.id === activeId)) && store.channels[0]) setActiveId(store.channels.find((c) => c.kind === 'public')?.id ?? store.channels[0].id);
  }, [store.channels, activeId]);
  const channel = store.channels.find((c) => c.id === activeId) ?? null;

  // Vzhled seznamu místností je osobní nastavení (kompaktní seznam nebo karty, stoly mezi kanály, skrytí prázdných oddílů); skupiny může vypnout správce.
  const values = useSettings().values;
  const cards = values['ui.chatList'] === 'cards';
  const tablesWithChannels = values['ui.chatTablesWithChannels'] !== false;
  const hideEmpty = values['ui.chatHideEmpty'] !== false;
  const groupsOn = values['chat.groupsEnabled'] !== false;
  const [onlineOpen, setOnlineOpen] = useFold('chat|online', false);
  const of = (...kinds: Channel['kind'][]) => store.channels.filter((c) => kinds.includes(c.kind));
  const groups: { key: string; title: string; list: Channel[] }[] = [
    { key: 'public', title: t('chat.group.public'), list: of('public', ...(tablesWithChannels ? (['table'] as const) : [])) },
    ...(tablesWithChannels ? [] : [{ key: 'tables', title: t('chat.group.tables'), list: of('table') }]),
    ...(groupsOn ? [{ key: 'groups', title: t('chat.group.groups'), list: of('group') }] : []),
    { key: 'dm', title: t('chat.group.dm'), list: of('dm') },
  ].filter((g) => !hideEmpty || g.list.length > 0);
  const canCreateChannel = can(me, 'chat.spravovat_kanaly') || can(me, 'chat.vytvorit_kanal');
  const actions: { id: 'dm' | 'group' | 'channel' | 'search'; icon: string; label: string }[] = [
    { id: 'dm', icon: '✉️', label: t('chat.newDm') },
    ...(groupsOn ? [{ id: 'group' as const, icon: '👥', label: t('chat.newGroup') }] : []),
    ...(canCreateChannel ? [{ id: 'channel' as const, icon: '＃', label: t('chat.newChannel') }] : []),
    { id: 'search', icon: '🔍', label: t('chat.search') },
  ];
  const onlineList = (
    <ul className="flex flex-col gap-1 text-sm">
      {presence.map((p) => (
        <li key={p.userId} className="flex items-center justify-between">
          <button className="underline" onClick={() => p.userId !== me?.user.id && void startDm(p.userId).then(setActiveId)}>
            {p.nickname}
          </button>
          {p.status === 'table' && <Badge tone="success">{t('chat.atTable')}</Badge>}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-[16rem_minmax(0,1fr)]">
      {cards ? (
        <aside className="flex flex-col gap-3">
          {groups.map((g) => (
            <Card key={g.key} title={g.title}>
              <ul className="flex flex-col gap-1">
                {g.list.map((c) => (
                  <li key={c.id}>
                    <button className={`flex w-full items-center justify-between rounded-sm px-2 py-1 text-left ${c.id === activeId ? 'bg-primary text-on-primary' : 'bg-surface'}`} onClick={() => setActiveId(c.id)}>
                      <span className="truncate">{c.kind === 'table' && tablesWithChannels ? '🪑 ' : ''}{c.name}</span>
                      {c.unread > 0 && <Badge tone="danger">{c.unread}</Badge>}
                    </button>
                  </li>
                ))}
                {g.list.length === 0 && <li className="text-sm text-muted">{t('chat.none')}</li>}
              </ul>
            </Card>
          ))}
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <Button key={a.id} onClick={() => setDialog(a.id)}>
                {a.label}
              </Button>
            ))}
          </div>
          <Card title={t('chat.online', { n: presence.length })} foldId="chat|online-karta">{onlineList}</Card>
        </aside>
      ) : (
        <aside className="flex min-w-0 flex-col gap-2">
          {/* Jeden úsporný seznam; na telefonu jeden řádek s posouváním do stran, aby zprávy nebyly až pod ním. */}
          <nav aria-label={t('chat.channels')} className="flex items-center gap-1 overflow-x-auto md:flex-col md:items-stretch md:overflow-visible">
            {groups.map((g, i) => (
              <Fragment key={g.key}>
                {i > 0 && <span aria-hidden="true" className="mx-1 self-stretch border-l border-line md:hidden" />}
                <span className="hidden px-2 pt-1 text-xs uppercase text-muted md:block">{g.title}</span>
                {g.list.map((c) => (
                  <button key={c.id} className={`flex shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-md px-2 py-1 text-left md:w-full md:whitespace-normal ${c.id === activeId ? 'bg-primary text-on-primary' : 'bg-surface'}`} onClick={() => setActiveId(c.id)}>
                    <span className="truncate">{c.kind === 'table' && tablesWithChannels ? '🪑 ' : ''}{c.name}</span>
                    {c.unread > 0 && <Badge tone="danger">{c.unread}</Badge>}
                  </button>
                ))}
                {g.list.length === 0 && <span className="hidden px-2 text-sm text-muted md:block">{t('chat.none')}</span>}
              </Fragment>
            ))}
          </nav>
          <div className="flex flex-wrap items-center gap-1">
            {actions.map((a) => (
              <button key={a.id} type="button" title={a.label} aria-label={a.label} className="rounded-md border border-line bg-surface px-2 py-1" onClick={() => setDialog(a.id)}>
                {a.icon}
              </button>
            ))}
            <button type="button" aria-expanded={onlineOpen} onClick={() => setOnlineOpen(!onlineOpen)} className="ml-auto text-sm text-muted">
              {onlineOpen ? '▾' : '▸'} {t('chat.online', { n: presence.length })}
            </button>
          </div>
          {onlineOpen && onlineList}
        </aside>
      )}
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
  const messages = store.messages[channel.id] ?? NO_MESSAGES;
  const typing = (store.typing[channel.id] ?? []).filter((x) => Date.now() - x.at < 4000);
  const emojis = String(settings.values['chat.emojiList']).split(',').map((e) => e.trim()).filter(Boolean);
  const nick = useMemo(() => new Map(messages.map((m) => [m.id, m.nickname ?? ''])), [messages]);

  useEffect(() => {
    void openChannel(channel.id).catch((e) => setError(errMsg(e)));
    return () => setActive(null);
  }, [channel.id]);
  // Seznam drží dole (nejnovější), jen dokud hráč nevyjel výš: načtení starších zpráv ani nová zpráva ho pak neshodí zpátky.
  const stick = useRef(true);
  useEffect(() => {
    stick.current = true;
  }, [channel.id]);
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [messages.length, channel.id]);
  const [mute, setMute] = useState<Message | null>(null);

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
      <div ref={listRef} className={`flex flex-col overflow-y-auto rounded-md border border-line bg-surface ${fill ? 'min-h-0 flex-1 gap-0 p-1 leading-tight' : compact ? `min-h-16 gap-0 p-1 leading-tight ${listHeight ? '' : 'h-32 resize-y'}` : 'h-96 gap-2 p-2'}`} aria-live="polite" aria-label={t('chat.messages')} style={!fill && compact && listHeight ? { height: listHeight } : undefined} onScroll={() => { const el = listRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK; }}>
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
                          onClick={() => setMute(m)}
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
      {mute && (
        <MuteDialog
          message={mute}
          onClose={() => setMute(null)}
          onOk={(hours, reason) => {
            setMute(null);
            void muteUser(mute.userId!, hours, reason, channel.id).catch((e) => setError(errMsg(e)));
          }}
        />
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

/** Ztlumení hráče: délka v hodinách a důvod (místo nativního prompt(), který nejde přeložit a na telefonu je nepraktický). */
function MuteDialog({ message, onClose, onOk }: { message: Message; onClose: () => void; onOk: (hours: number, reason: string) => void }) {
  const [hours, setHours] = useState(1);
  const [reason, setReason] = useState('');
  const ok = hours > 0 && reason.trim() !== '';
  return (
    <Modal title={t('chat.muteTitle', { nick: message.nickname ?? '' })} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label={t('chat.muteHours')}>{(id, d) => <NumInput id={id} aria-describedby={d} min={1} value={hours} onChange={setHours} />}</Field>
        <TextInput label={t('chat.muteReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="flex gap-2">
          <Button variant="primary" disabled={!ok} onClick={() => onOk(hours, reason.trim())}>
            {t('chat.mute')}
          </Button>
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
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
