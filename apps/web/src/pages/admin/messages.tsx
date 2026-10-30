import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../../api';
import { useSession } from '../../session';
import { Badge, Button, Card, Notice, Select, TextArea, TextInput } from '../../ui';

type Channel = 'app' | 'push' | 'email';

interface Role {
  key: string;
  name: string;
}
interface Tour {
  id: string;
  name: string;
  status: string;
  players: number;
}
interface UserRow {
  id: string;
  nickname: string;
  status: string;
}
interface Audience {
  everyone: boolean;
  roleKeys: string[];
  tournamentId: string;
  userIds: string[];
  excludeRoleKeys: string[];
  excludeSelf: boolean;
}
interface Preview {
  count: number;
  emailable: number;
  noEmail: number;
  tooMany: boolean;
  names: string[];
  sample: { title: string; body: string } | null;
}
interface HistoryItem {
  id: string;
  title: string;
  body: string;
  channels: Channel[];
  recipients: number;
  result: Record<string, number>;
  sender: string;
  createdAt: number;
}

const EMPTY_AUDIENCE: Audience = { everyone: false, roleKeys: [], tournamentId: '', userIds: [], excludeRoleKeys: [], excludeSelf: false };
const TEMPLATES = ['invite', 'debug', 'reminder', 'general'] as const;
type TemplateId = (typeof TEMPLATES)[number];

const toggle = (list: string[], key: string, on: boolean) => (on ? [...new Set([...list, key])] : list.filter((x) => x !== key));
const errorOf = (e: unknown) => errorText(e);

/** Správa → Zprávy členům: vybereš příjemce (všichni, role, turnaj, jmenovitě), kanály a text; před odesláním vidíš, kdo zprávu dostane. */
export function MessagesPage() {
  const { me } = useSession();
  const [roles, setRoles] = useState<Role[]>([]);
  const [tours, setTours] = useState<Tour[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [channels, setChannels] = useState<Channel[]>(['app', 'push', 'email']);
  const [audience, setAudience] = useState<Audience>(EMPTY_AUDIENCE);
  const [userQuery, setUserQuery] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadHistory = useCallback(() => {
    get<{ items: HistoryItem[] }>('/api/admin/messages')
      .then((r) => setHistory(r.items))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    get<Role[]>('/api/admin/roles').then(setRoles).catch(() => undefined);
    get<{ tournaments: Tour[] }>('/api/tournaments').then((r) => setTours(r.tournaments.filter((x) => x.status === 'registering' || x.status === 'running'))).catch(() => undefined);
    get<UserRow[]>('/api/admin/users').then(setUsers).catch(() => undefined);
    reloadHistory();
  }, [reloadHistory]);

  const payload = useMemo(
    () => ({
      title,
      body,
      link: link.trim() || null,
      channels,
      audience: {
        everyone: audience.everyone || undefined,
        roleKeys: audience.roleKeys,
        tournamentId: audience.tournamentId || undefined,
        userIds: audience.userIds,
        excludeRoleKeys: audience.excludeRoleKeys,
        excludeSelf: audience.excludeSelf || undefined,
      },
    }),
    [title, body, link, channels, audience],
  );
  const ready = title.trim().length > 0 && body.trim().length > 0 && channels.length > 0;

  // Náhled příjemců se po úpravě formuláře sám přepočítá (s krátkou prodlevou).
  useEffect(() => {
    if (!ready) {
      setPreview(null);
      setPreviewError('');
      return;
    }
    const id = window.setTimeout(() => {
      post<Preview>('/api/admin/messages/preview', payload)
        .then((p) => {
          setPreview(p);
          setPreviewError('');
        })
        .catch((e) => {
          setPreview(null);
          setPreviewError(errorOf(e));
        });
    }, 400);
    return () => window.clearTimeout(id);
  }, [payload, ready]);

  const applyTemplate = (id: TemplateId, tournamentId = audience.tournamentId) => {
    const tour = tours.find((x) => x.id === tournamentId);
    const name = tour?.name ?? '';
    if (id === 'invite' || id === 'debug') {
      setTitle(t(`messages.tpl.${id}.title`, { name: name || t('messages.tpl.tournamentFallback') }));
      setBody(t(`messages.tpl.${id}.body`, { name: name || t('messages.tpl.tournamentFallback') }));
      setLink(tournamentId ? `/turnaj/${tournamentId}` : '');
      setChannels(['app', 'push', 'email']);
      setAudience({ ...EMPTY_AUDIENCE, tournamentId });
    } else if (id === 'reminder') {
      setTitle(t('messages.tpl.reminder.title', { name: name || t('messages.tpl.tournamentFallback') }));
      setBody(t('messages.tpl.reminder.body', { name: name || t('messages.tpl.tournamentFallback') }));
      setLink(tournamentId ? `/turnaj/${tournamentId}` : '');
      setChannels(['app', 'push']);
      setAudience({ ...EMPTY_AUDIENCE, tournamentId });
    } else {
      setTitle('');
      setBody('');
      setLink('');
      setChannels(['app']);
      setAudience({ ...EMPTY_AUDIENCE, everyone: true });
    }
  };

  const send = async (onlyMe: boolean) => {
    const text = onlyMe ? t('messages.confirmTest') : t('messages.confirm', { n: preview?.count ?? 0 });
    if (!confirm(text)) return;
    setBusy(true);
    setMsg(null);
    try {
      const body = onlyMe ? { ...payload, audience: { userIds: me ? [me.user.id] : [] } } : payload;
      const r = await post<{ recipients: number; result: Record<string, number> }>('/api/admin/messages/send', body);
      const detail = Object.entries(r.result)
        .map(([k, v]) => `${t(`messages.result.${k}`)}: ${v}`)
        .join(', ');
      setMsg({ kind: 'success', text: t('messages.sent', { n: r.recipients, detail }) });
      reloadHistory();
    } catch (e) {
      setMsg({ kind: 'error', text: errorOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const visibleUsers = users.filter((u) => u.status !== 'blocked' && u.nickname.toLowerCase().includes(userQuery.toLowerCase())).slice(0, 80);
  const channelLabel = (c: Channel) => t(`messages.channel.${c}`);

  return (
    <div className="flex flex-col gap-3">
      <Notice>{t('messages.help')}</Notice>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <Card title={t('messages.templates')}>
        <div className="flex flex-wrap items-end gap-2">
          <Select label={t('messages.tpl.tournament')} value={audience.tournamentId} onChange={(e) => setAudience({ ...audience, tournamentId: e.target.value })}>
            <option value="">{t('messages.tpl.noTournament')}</option>
            {tours.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.players})
              </option>
            ))}
          </Select>
          {TEMPLATES.map((id) => (
            <Button key={id} onClick={() => applyTemplate(id)}>
              {t(`messages.tpl.${id}`)}
            </Button>
          ))}
        </div>
      </Card>

      <Card title={t('messages.audience')}>
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={audience.everyone} onChange={(e) => setAudience({ ...audience, everyone: e.target.checked })} />
            {t('messages.everyone')}
          </label>
          <div className="flex flex-col gap-1">
            <span className="font-medium">{t('messages.roles')}</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {roles.map((r) => (
                <label key={r.key} className="flex items-center gap-1">
                  <input type="checkbox" checked={audience.roleKeys.includes(r.key)} onChange={(e) => setAudience({ ...audience, roleKeys: toggle(audience.roleKeys, r.key, e.target.checked) })} />
                  {r.name}
                </label>
              ))}
            </div>
          </div>
          <Select label={t('messages.registered')} value={audience.tournamentId} onChange={(e) => setAudience({ ...audience, tournamentId: e.target.value })}>
            <option value="">{t('messages.registeredNone')}</option>
            {tours.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.players})
              </option>
            ))}
          </Select>
          <div className="flex flex-col gap-1">
            <TextInput label={t('messages.people')} value={userQuery} onChange={(e) => setUserQuery(e.target.value)} />
            <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-md border border-line p-2">
              {visibleUsers.map((u) => (
                <li key={u.id}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={audience.userIds.includes(u.id)} onChange={(e) => setAudience({ ...audience, userIds: toggle(audience.userIds, u.id, e.target.checked) })} />
                    {u.nickname}
                  </label>
                </li>
              ))}
              {visibleUsers.length === 0 && <li className="text-sm text-muted">{t('messages.peopleNone')}</li>}
            </ul>
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-medium">{t('messages.exclude')}</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {roles.map((r) => (
                <label key={r.key} className="flex items-center gap-1">
                  <input type="checkbox" checked={audience.excludeRoleKeys.includes(r.key)} onChange={(e) => setAudience({ ...audience, excludeRoleKeys: toggle(audience.excludeRoleKeys, r.key, e.target.checked) })} />
                  {r.name}
                </label>
              ))}
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={audience.excludeSelf} onChange={(e) => setAudience({ ...audience, excludeSelf: e.target.checked })} />
                {t('messages.excludeSelf')}
              </label>
            </div>
          </div>
        </div>
      </Card>

      <Card title={t('messages.compose')}>
        <div className="flex flex-col gap-3">
          <TextInput label={t('messages.subject')} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} hint={t('messages.variables')} />
          <TextArea label={t('messages.text')} value={body} rows={8} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
          <TextInput label={t('messages.link')} value={link} onChange={(e) => setLink(e.target.value)} hint={t('messages.linkHint')} />
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span className="font-medium">{t('messages.channels')}</span>
            {(['app', 'push', 'email'] as const).map((c) => (
              <label key={c} className="flex items-center gap-1">
                <input type="checkbox" checked={channels.includes(c)} onChange={(e) => setChannels(toggle(channels, c, e.target.checked) as Channel[])} />
                {channelLabel(c)}
              </label>
            ))}
          </div>
        </div>
      </Card>

      <Card title={t('messages.preview')}>
        <div className="flex flex-col gap-2">
          {previewError && <Notice kind="error">{previewError}</Notice>}
          {!ready && <p className="text-sm text-muted">{t('messages.previewWait')}</p>}
          {preview && (
            <>
              <p className="font-medium">
                {t('messages.previewCount', { n: preview.count })}
                {channels.includes('email') && <span className="text-sm font-normal text-muted"> · {t('messages.previewEmail', { n: preview.emailable, none: preview.noEmail })}</span>}
              </p>
              {preview.tooMany && <Notice kind="error">{t('messages.tooMany')}</Notice>}
              <div className="flex flex-wrap gap-1">
                {preview.names.map((n) => (
                  <Badge key={n}>{n}</Badge>
                ))}
                {preview.count > preview.names.length && <Badge>+{preview.count - preview.names.length}</Badge>}
              </div>
              {preview.sample && (
                <div className="rounded-md border border-line bg-raised p-3 text-sm">
                  <strong>{preview.sample.title}</strong>
                  <div className="whitespace-pre-wrap">{preview.sample.body}</div>
                </div>
              )}
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !ready} onClick={() => void send(true)}>
              {t('messages.sendTest')}
            </Button>
            <Button variant="primary" disabled={busy || !ready || !preview || preview.count === 0 || preview.tooMany} onClick={() => void send(false)}>
              {t('messages.send')}
            </Button>
          </div>
        </div>
      </Card>

      <Card title={t('messages.history')}>
        {history.length === 0 && <p className="text-sm text-muted">{t('messages.historyEmpty')}</p>}
        <ul className="flex flex-col gap-2">
          {history.map((h) => (
            <li key={h.id} className="rounded-md border border-line p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{h.title}</strong>
                <span className="text-muted">
                  {new Date(h.createdAt).toLocaleString('cs-CZ')} · {h.sender} · {t('messages.historyRecipients', { n: h.recipients })}
                </span>
                {h.channels.map((c) => (
                  <Badge key={c}>{channelLabel(c)}</Badge>
                ))}
              </div>
              <div className="whitespace-pre-wrap text-muted">{h.body}</div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
