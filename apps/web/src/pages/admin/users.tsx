import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get, post } from '../../api';
import { can, useSession } from '../../session';
import { Badge, Button, Card, DataTable, Modal, Notice, Select, Td, TextInput } from '../../ui';

interface UserRow {
  id: string;
  nickname: string;
  email: string | null;
  emailVerified: boolean;
  status: string;
  blockedReason: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  roles: { id: string; roleId: string; role?: string; scopeType: string; scopeId: string; validTo: string | null }[];
}
interface RoleRow {
  id: string;
  key: string;
  name: string;
  power: number;
  isLocked: boolean;
}

export function UsersPage() {
  const { me } = useSession();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [rolesFor, setRolesFor] = useState<UserRow | null>(null);
  const [blockFor, setBlockFor] = useState<UserRow | null>(null);
  const reload = useCallback(() => {
    get<UserRow[]>('/api/admin/users').then(setUsers).catch((e) => setError(errorText(e)));
    if (can(me, 'role.zobrazit')) get<RoleRow[]>('/api/admin/roles').then(setRoles).catch(() => undefined);
  }, [me]);
  useEffect(reload, [reload]);
  const act = (url: string, body?: unknown) => post(url, body).then(reload).catch((e) => setError(errorText(e)));

  return (
    <div className="flex flex-col gap-3">
      <TextInput label={t('lobby.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      {error && <Notice kind="error">{error}</Notice>}
      <DataTable head={[t('auth.nickname'), t('auth.email'), t('admin.status'), t('admin.rolesCol'), t('admin.lastSeen'), '']}>
        {users
          .filter((u) => u.nickname.toLowerCase().includes(query.toLowerCase()) || (u.email ?? '').toLowerCase().includes(query.toLowerCase()))
          .map((u) => (
            <tr key={u.id}>
              <Td>{u.nickname}</Td>
              <Td>
                {u.email} {!u.emailVerified && <Badge tone="warning">{t('admin.unverified')}</Badge>}
              </Td>
              <Td>{u.status === 'blocked' ? <Badge tone="danger">{t('admin.blocked')}</Badge> : <Badge tone="success">{t('admin.active')}</Badge>}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {u.roles.map((r) => (
                    <Badge key={r.id} tone="primary">
                      {r.role}
                      {r.scopeType !== 'global' ? ` (${r.scopeType}:${r.scopeId})` : ''}
                      {r.validTo ? ` → ${new Date(r.validTo).toLocaleDateString('cs-CZ')}` : ''}
                    </Badge>
                  ))}
                </div>
              </Td>
              <Td className="text-sm">{u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleString('cs-CZ') : '–'}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {can(me, 'role.prirazovat') && <Button onClick={() => setRolesFor(u)}>{t('admin.roles')}</Button>}
                  {can(me, 'uzivatel.blokovat') && (u.status === 'blocked' ? <Button onClick={() => void act(`/api/admin/users/${u.id}/unblock`)}>{t('admin.unblock')}</Button> : <Button onClick={() => setBlockFor(u)}>{t('admin.block')}</Button>)}
                  {can(me, 'uzivatel.overit_email') && !u.emailVerified && <Button onClick={() => void act(`/api/admin/users/${u.id}/verify-email`)}>{t('admin.verifyEmail')}</Button>}
                  {can(me, 'uzivatel.vynutit_zmenu_hesla') && (
                    <Button
                      onClick={() => {
                        if (confirm(t('admin.forcePasswordConfirm', { nick: u.nickname }))) void act(`/api/admin/users/${u.id}/force-password`);
                      }}
                    >
                      {t('admin.forcePassword')}
                    </Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
      </DataTable>
      {rolesFor && <AssignDialog user={rolesFor} roles={roles} onClose={() => { setRolesFor(null); reload(); }} />}
      {blockFor && <BlockDialog user={blockFor} onClose={() => { setBlockFor(null); reload(); }} />}
    </div>
  );
}

function BlockDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [error, setError] = useState('');
  return (
    <Modal title={t('admin.blockTitle', { nick: user.nickname })} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await post(`/api/admin/users/${user.id}/block`, { reason, until: until ? new Date(until).toISOString() : null });
            onClose();
          } catch (er) {
            setError(errorText(er));
          }
        }}
      >
        <TextInput label={t('admin.blockReason')} value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus />
        <TextInput label={t('admin.blockUntil')} hint={t('admin.blockUntilHint')} type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button variant="danger" type="submit">
            {t('admin.block')}
          </Button>
          <Button type="button" onClick={onClose}>
            {t('table.cancel')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AssignDialog({ user, roles, onClose }: { user: UserRow; roles: RoleRow[]; onClose: () => void }) {
  const [list, setList] = useState(user.roles);
  const [form, setForm] = useState({ roleId: '', scopeType: 'global', scopeId: '', validTo: '', reason: '' });
  const [error, setError] = useState('');
  const refresh = async () => {
    const users = await get<UserRow[]>('/api/admin/users');
    setList(users.find((u) => u.id === user.id)?.roles ?? []);
  };
  return (
    <Modal title={t('admin.rolesOf', { nick: user.nickname })} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1">
          {list.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <span>
                {r.role} {r.scopeType !== 'global' && `(${r.scopeType}:${r.scopeId})`} {r.validTo && `→ ${new Date(r.validTo).toLocaleDateString('cs-CZ')}`}
              </span>
              <Button onClick={() => void del(`/api/admin/assignments/${r.id}`).then(refresh).catch((e) => setError(errorText(e)))}>{t('admin.revoke')}</Button>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post('/api/admin/assignments', { userId: user.id, roleId: form.roleId, scopeType: form.scopeType, scopeId: form.scopeId || undefined, validTo: form.validTo ? new Date(form.validTo).toISOString() : null, reason: form.reason || undefined });
              setError('');
              await refresh();
            } catch (er) {
              setError(errorText(er));
            }
          }}
        >
          <Select label={t('admin.role')} value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })} required>
            <option value="">{t('cashier.pick')}</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.power})
              </option>
            ))}
          </Select>
          <Select label={t('admin.scope')} value={form.scopeType} onChange={(e) => setForm({ ...form, scopeType: e.target.value })}>
            {['global', 'table', 'channel', 'tournament', 'series'].map((s) => (
              <option key={s} value={s}>
                {t(`scope.${s}`)}
              </option>
            ))}
          </Select>
          {form.scopeType !== 'global' && <TextInput label={t('admin.scopeId')} value={form.scopeId} onChange={(e) => setForm({ ...form, scopeId: e.target.value })} required />}
          <TextInput label={t('admin.validTo')} type="datetime-local" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
          <TextInput label={t('admin.reason')} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex gap-2">
            <Button variant="primary" type="submit">
              {t('admin.assign')}
            </Button>
            <Button type="button" onClick={onClose}>
              {t('table.close')}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

interface InviteRow {
  code: string;
  maxUses: number;
  uses: number;
  email: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  note: string | null;
}

export function InvitesPage() {
  const { me } = useSession();
  const [rows, setRows] = useState<InviteRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [form, setForm] = useState({ maxUses: '1', hours: '', email: '', roleId: '', note: '' });
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const reload = useCallback(() => {
    get<InviteRow[]>('/api/admin/invites').then((r) => setRows([...r].reverse())).catch((e) => setMsg({ kind: 'error', text: errorText(e) }));
  }, []);
  useEffect(() => {
    reload();
    if (can(me, 'role.zobrazit')) void get<RoleRow[]>('/api/admin/roles').then(setRoles).catch(() => undefined);
  }, [reload, me]);
  const link = (code: string) => `${window.location.origin}/registrace?kod=${code}`;
  return (
    <div className="flex flex-col gap-3">
      <Card title={t('admin.invite.new')}>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await post<{ code: string }>('/api/admin/invites', {
                maxUses: Number(form.maxUses) || 1,
                hours: form.hours ? Number(form.hours) : undefined,
                email: form.email || undefined,
                roleId: form.roleId || undefined,
                note: form.note || undefined,
              });
              setMsg({ kind: 'success', text: t('admin.invite.created', { code: r.code }) });
              reload();
            } catch (er) {
              setMsg({ kind: 'error', text: errorText(er) });
            }
          }}
        >
          <TextInput label={t('admin.invite.uses')} type="number" min={1} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />
          <TextInput label={t('admin.invite.hours')} type="number" min={1} value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} />
          <TextInput label={t('admin.invite.email')} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} hint={t('admin.invite.emailHint')} />
          {roles.length > 0 && (
            <Select label={t('admin.role')} value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
              <option value="">{t('admin.invite.defaultRole')}</option>
              {roles.filter((r) => !r.isLocked && r.power < (me?.power ?? 0)).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          )}
          <Button variant="primary" type="submit">
            {t('admin.invite.create')}
          </Button>
        </form>
        {msg && <div className="mt-3"><Notice kind={msg.kind}>{msg.text}</Notice></div>}
      </Card>
      <DataTable head={[t('auth.inviteCode'), t('admin.invite.usage'), t('admin.invite.expires'), t('admin.status'), '']}>
        {rows.map((r) => {
          const expired = r.expiresAt && new Date(r.expiresAt) < new Date();
          const dead = !!r.revokedAt || r.uses >= r.maxUses || !!expired;
          return (
            <tr key={r.code}>
              <Td className="font-mono">{r.code}</Td>
              <Td>
                {r.uses}/{r.maxUses}
              </Td>
              <Td>{r.expiresAt ? new Date(r.expiresAt).toLocaleString('cs-CZ') : '–'}</Td>
              <Td>{dead ? <Badge tone="muted">{t('admin.invite.inactive')}</Badge> : <Badge tone="success">{t('admin.invite.active')}</Badge>}</Td>
              <Td>
                <div className="flex gap-1">
                  {!dead && <Button onClick={() => void navigator.clipboard?.writeText(link(r.code))}>{t('lobby.copyLink')}</Button>}
                  {!dead && <Button onClick={() => void del(`/api/admin/invites/${r.code}`).then(reload)}>{t('admin.revoke')}</Button>}
                </div>
              </Td>
            </tr>
          );
        })}
      </DataTable>
    </div>
  );
}
