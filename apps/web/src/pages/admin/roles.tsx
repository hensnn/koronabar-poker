import { useCallback, useEffect, useMemo, useState } from 'react';
import { PERMISSIONS, permissionCategories, t, type LimitKey } from '@kb/shared';
import { del, errorText, get, patch, post } from '../../api';
import { can, useSession } from '../../session';
import { Badge, Button, Card, DataTable, Modal, Notice, Tabs, Td, TextArea, TextInput } from '../../ui';

interface Perm {
  permission: string;
  effect: 'allow' | 'deny';
  limits: Partial<Record<LimitKey, number>> | null;
  needsApproval: boolean;
}
interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  power: number;
  color: string | null;
  icon: string | null;
  isSystem: boolean;
  isLocked: boolean;
  permissions: Perm[];
}

type EditState = { id: string | null; key: string; name: string; description: string; power: number; perms: Record<string, { effect: 'allow' | 'deny'; limits: Partial<Record<LimitKey, number>>; needsApproval: boolean }> };

const toEdit = (r?: Role, duplicate = false): EditState => ({
  id: duplicate ? null : (r?.id ?? null),
  key: r ? (duplicate ? `${r.key}_kopie` : r.key) : '',
  name: r ? (duplicate ? `${r.name} (kopie)` : r.name) : '',
  description: r?.description ?? '',
  power: r ? Math.max(0, r.power - (duplicate ? 1 : 0)) : 10,
  perms: Object.fromEntries((r?.permissions ?? []).map((p) => [p.permission, { effect: p.effect, limits: p.limits ?? {}, needsApproval: p.needsApproval }])),
});

export function RolesPage() {
  const { me } = useSession();
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState<EditState | null>(null);
  const [view, setView] = useState<'list' | 'matrix'>('list');
  const [json, setJson] = useState('');
  const reload = useCallback(() => {
    get<Role[]>('/api/admin/roles').then(setRoles).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(reload, [reload]);

  const exportRoles = () => setJson(JSON.stringify(roles.filter((r) => !r.isLocked).map((r) => ({ key: r.key, name: r.name, description: r.description, power: r.power, color: r.color, icon: r.icon, permissions: r.permissions.map((p) => ({ key: p.permission, effect: p.effect, limits: p.limits ?? undefined, needsApproval: p.needsApproval })) })), null, 2));
  const importRoles = async () => {
    try {
      const list = JSON.parse(json) as unknown[];
      for (const r of list) await post('/api/admin/roles', r);
      setError('');
      reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs tabs={[{ id: 'list', label: t('roles.list') }, { id: 'matrix', label: t('roles.matrix') }]} value={view} onChange={setView} />
        {can(me, 'role.vytvorit') && <Button variant="primary" onClick={() => setEdit(toEdit())}>{t('roles.new')}</Button>}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {view === 'list' ? (
        <DataTable head={[t('admin.role'), t('roles.power'), t('roles.permCount'), '']}>
          {roles.map((r) => (
            <tr key={r.id}>
              <Td>
                <strong>{r.name}</strong> {r.isLocked && <Badge tone="danger">{t('roles.locked')}</Badge>} {r.isSystem && !r.isLocked && <Badge>{t('roles.preset')}</Badge>}
                <br />
                <span className="text-sm text-muted">{r.description}</span>
              </Td>
              <Td className="font-mono">{r.power}</Td>
              <Td>{r.isLocked ? t('roles.all') : r.permissions.filter((p) => p.effect === 'allow').length}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {!r.isLocked && can(me, 'role.upravit') && r.power < (me?.power ?? 0) && <Button onClick={() => setEdit(toEdit(r))}>{t('roles.edit')}</Button>}
                  {!r.isLocked && can(me, 'role.vytvorit') && <Button onClick={() => setEdit(toEdit(r, true))}>{t('roles.duplicate')}</Button>}
                  {!r.isLocked && can(me, 'role.smazat') && r.power < (me?.power ?? 0) && (
                    <Button
                      onClick={async () => {
                        if (!confirm(t('roles.deleteConfirm', { name: r.name }))) return;
                        await del(`/api/admin/roles/${r.id}`).then(reload).catch((e) => setError(errorText(e)));
                      }}
                    >
                      {t('roles.delete')}
                    </Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <Matrix roles={roles} />
      )}
      {can(me, 'role.exportovat') && (
        <Card title={t('roles.exportImport')}>
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Button onClick={exportRoles}>{t('settings.personal.export')}</Button>
              {can(me, 'role.vytvorit') && <Button onClick={() => void importRoles()}>{t('settings.personal.import')}</Button>}
            </div>
            <TextArea label={t('settings.personal.json')} value={json} onChange={(e) => setJson(e.target.value)} />
          </div>
        </Card>
      )}
      {edit && <RoleEditor state={edit} onClose={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

/** Matice oprávnění: role × oprávnění pro rychlé porovnání. */
function Matrix({ roles }: { roles: Role[] }) {
  const cats = permissionCategories();
  return (
    <div className="overflow-auto">
      <table className="border-collapse text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 bg-surface px-2 py-1 text-left">{t('roles.permission')}</th>
            {roles.map((r) => (
              <th key={r.id} className="px-2 py-1 font-medium">
                {r.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cats.map((c) => (
            <>
              <tr key={c}>
                <th colSpan={roles.length + 1} className="bg-raised px-2 py-1 text-left">
                  {t(`permcat.${c}`)}
                </th>
              </tr>
              {PERMISSIONS.filter((p) => p.category === c).map((p) => (
                <tr key={p.key}>
                  <td className="sticky left-0 bg-surface px-2 py-1">{t(`perm.${p.key}.name`)}</td>
                  {roles.map((r) => {
                    const entry = r.permissions.find((x) => x.permission === p.key);
                    const mark = r.isLocked ? '●' : entry?.effect === 'deny' ? '✕' : entry ? (entry.needsApproval ? '◐' : '●') : '';
                    return (
                      <td key={r.id} className="border border-line px-2 py-1 text-center" title={entry?.limits ? JSON.stringify(entry.limits) : undefined}>
                        {mark}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-sm text-muted">{t('roles.matrixLegend')}</p>
    </div>
  );
}

function RoleEditor({ state, onClose }: { state: EditState; onClose: () => void }) {
  const { me } = useSession();
  const [s, setS] = useState(state);
  const [error, setError] = useState('');
  const mine = useMemo(() => new Set(me?.permissions ?? []), [me]);
  const setPerm = (key: string, patchEntry: Partial<EditState['perms'][string]> | null) => {
    const perms = { ...s.perms };
    if (patchEntry === null) delete perms[key];
    else perms[key] = { effect: 'allow', limits: {}, needsApproval: false, ...perms[key], ...patchEntry };
    setS({ ...s, perms });
  };
  const body = () => ({
    name: s.name,
    description: s.description || null,
    power: s.power,
    permissions: Object.entries(s.perms).map(([key, p]) => ({ key, effect: p.effect, limits: Object.keys(p.limits).length ? p.limits : undefined, needsApproval: p.needsApproval || undefined })),
  });
  return (
    <Modal title={s.id ? t('roles.edit') : t('roles.new')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {!s.id && <TextInput label={t('roles.key')} hint={t('roles.keyHint')} value={s.key} onChange={(e) => setS({ ...s, key: e.target.value })} />}
        <TextInput label={t('roles.name')} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
        <TextInput label={t('roles.description')} value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} />
        <TextInput label={t('roles.power')} hint={t('roles.powerHint', { max: (me?.power ?? 1) - 1 })} type="number" min={0} max={Math.max(0, (me?.power ?? 1) - 1)} value={s.power} onChange={(e) => setS({ ...s, power: Number(e.target.value) })} />
        {permissionCategories().map((c) => (
          <fieldset key={c} className="rounded-md border border-line p-2">
            <legend className="px-1 font-medium">{t(`permcat.${c}`)}</legend>
            <ul className="flex flex-col gap-2">
              {PERMISSIONS.filter((p) => p.category === c).map((p) => {
                const entry = s.perms[p.key];
                const allowedToGive = mine.has(p.key) || me?.mainAdmin;
                return (
                  <li key={p.key} className="flex flex-col gap-1">
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={entry?.effect === 'allow'} disabled={!allowedToGive} onChange={(e) => setPerm(p.key, e.target.checked ? { effect: 'allow' } : null)} />
                      <span>
                        <strong>{t(`perm.${p.key}.name`)}</strong>
                        <br />
                        <span className="text-sm text-muted">{t(`perm.${p.key}.desc`)}</span>
                      </span>
                    </label>
                    {entry?.effect === 'allow' && (p.limits || p.approvalCapable) && (
                      <div className="ml-6 flex flex-wrap items-end gap-3">
                        {(p.limits ?? []).map((l) => (
                          <label key={l} className="flex flex-col text-sm">
                            {t(`limit.${l}`)}
                            <input type="number" min={0} className="w-28 rounded-sm border border-line bg-surface px-2 py-1" value={entry.limits[l] ?? ''} placeholder="∞" onChange={(e) => { const limits = { ...entry.limits }; if (e.target.value === '') delete limits[l]; else limits[l] = Number(e.target.value); setPerm(p.key, { limits }); }} />
                          </label>
                        ))}
                        {p.approvalCapable && (
                          <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={entry.needsApproval} onChange={(e) => setPerm(p.key, { needsApproval: e.target.checked })} />
                            {t('roles.needsApproval')}
                          </label>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ))}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={async () => {
              try {
                if (s.id) await patch(`/api/admin/roles/${s.id}`, body());
                else await post('/api/admin/roles', { key: s.key, ...body() });
                onClose();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('lobby.save')}
          </Button>
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}
