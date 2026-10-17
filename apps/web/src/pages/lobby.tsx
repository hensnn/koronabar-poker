import { useCallback, useEffect, useMemo, useState } from 'react';
import { PollsPanel } from './polls';
import { RulesDialog } from './rules';
import { decideChange, resolveSettings, scopeAllowed, t, validateValues, type SettingValue, type SettingValues } from '@kb/shared';
import { del, errorText, get, patch, post } from '../api';
import { Link, navigate } from '../router';
import { can, useSession } from '../session';
import { registry } from '../settings';
import { SettingsForm, UnsavedBar } from '../settings/SettingsForm';
import { Badge, Button, Card, Modal, Notice, Spinner, TextInput } from '../ui';

interface LobbyTable {
  id: string;
  name: string;
  templateId: string | null;
  owner: string | null;
  ownerId: string | null;
  seats: number;
  seated: number;
  smallBlind: number;
  bigBlind: number;
  minBuyInBb: number;
  maxBuyInBb: number;
  straddle: 'off' | 'mandatory' | 'optional';
  bbAnte: boolean;
  ante: number;
  turnSeconds: number;
  rakePercent: number;
  rakeCap: number;
  jackpot: number | null;
  playing: boolean;
}
interface Template {
  id: string;
  name: string;
  description: string;
  tags: string[];
  values: Record<string, SettingValue>;
}

export function LobbyPage() {
  const { me } = useSession();
  const [data, setData] = useState<{ tables: LobbyTable[]; templates: Template[] } | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [dialog, setDialog] = useState<'create' | { edit: string } | { rules: string } | null>(null);

  const reload = useCallback(() => {
    get<{ tables: LobbyTable[]; templates: Template[] }>('/api/lobby')
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    reload();
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [reload]);

  const tables = useMemo(() => (data?.tables ?? []).filter((x) => x.name.toLowerCase().includes(query.toLowerCase()) && (!freeOnly || x.seated < x.seats)), [data, query, freeOnly]);
  const canCreate = can(me, 'cash.vytvorit_vlastni');

  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;
  return (
    <div className="flex flex-col gap-3">
      <PollsPanel />
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="font-heading text-2xl font-bold">{t('lobby.title')}</h1>
        <div className="ml-auto flex flex-wrap items-end gap-3">
          <TextInput label={t('lobby.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          <label className="flex items-center gap-2 pb-1">
            <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} />
            {t('lobby.freeOnly')}
          </label>
          {canCreate && (
            <Button variant="primary" onClick={() => setDialog('create')}>
              {t('lobby.create')}
            </Button>
          )}
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {tables.length === 0 && <Notice>{t('lobby.empty')}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        {tables.map((x) => (
          <Card key={x.id} title={x.name}>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Badge tone="primary">
                  {x.seated}/{x.seats} {t('lobby.players')}
                </Badge>
                {x.playing && <Badge tone="success">{t('lobby.playing')}</Badge>}
                {x.straddle !== 'off' && <Badge>{t(`lobby.straddle.${x.straddle}`)}</Badge>}
                {x.bbAnte && <Badge>{t('lobby.bbAnte')}</Badge>}
                {x.ante > 0 && !x.bbAnte && <Badge>{t('lobby.ante', { n: x.ante })}</Badge>}
                {x.rakePercent > 0 && <Badge>{x.rakeCap > 0 ? t('table.rakeInfo', { percent: x.rakePercent, cap: x.rakeCap }) : t('table.rakeInfoNoCap', { percent: x.rakePercent })}</Badge>}
                {x.jackpot !== null && <Badge tone="warning">{t('table.jackpot')}: {x.jackpot}</Badge>}
              </div>
              <p>
                {t('lobby.blinds')}: <span className="font-mono">{x.smallBlind}/{x.bigBlind}</span> · {t('lobby.buyIn')}: <span className="font-mono">{x.minBuyInBb}–{x.maxBuyInBb} BB</span> · {t('lobby.turn')}: {x.turnSeconds} s
              </p>
              {x.owner && <p className="text-sm text-muted">{t('lobby.owner', { nick: x.owner })}</p>}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => navigate(`/stul/${x.id}`)}>
                  {x.seated < x.seats ? t('lobby.join') : t('lobby.watch')}
                </Button>
                <Button onClick={() => setDialog({ rules: x.id })}>{t('lobby.rules')}</Button>
                <Button onClick={() => void navigator.clipboard?.writeText(`${window.location.origin}/stul/${x.id}`)}>{t('lobby.copyLink')}</Button>
                {(x.ownerId === me?.user.id ? can(me, 'cash.upravit_vlastni') : can(me, 'cash.upravit_vse')) && <Button onClick={() => setDialog({ edit: x.id })}>{t('lobby.edit')}</Button>}
                {(x.ownerId === me?.user.id ? can(me, 'cash.zrusit_vlastni') : can(me, 'cash.zrusit_vse')) && (
                  <Button
                    variant="danger"
                    onClick={async () => {
                      if (!confirm(t('lobby.closeConfirm', { name: x.name }))) return;
                      await del(`/api/lobby/tables/${x.id}`).catch((e) => setError(errorText(e)));
                      reload();
                    }}
                  >
                    {t('lobby.close')}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      {dialog === 'create' && <CreateDialog templates={data.templates} onClose={() => setDialog(null)} onCreated={(id) => navigate(`/stul/${id}`)} />}
      {dialog && typeof dialog === 'object' && 'edit' in dialog && <EditDialog tableId={dialog.edit} onClose={() => { setDialog(null); reload(); }} />}
      {dialog && typeof dialog === 'object' && 'rules' in dialog && <RulesDialog detailsPath={`/api/lobby/tables/${dialog.rules}`} kind="cash" onClose={() => setDialog(null)} />}
      <p className="text-sm text-muted">
        <Link to="/penezenka" className="underline">
          {t('lobby.walletLink')}
        </Link>
      </p>
    </div>
  );
}

const tableScoped = (d: { scopes?: readonly string[] }) => scopeAllowed(d.scopes as never, 'table');

export interface CreateProps {
  templates: Template[];
  onClose: () => void;
  onCreated: (id: string) => void;
  kind?: 'cash' | 'tournament';
  postPath?: string;
  title?: string;
  nameLabel?: string;
  /** Další pole odeslaná spolu s názvem, šablonou a nastavením (např. čas startu plánovaného turnaje). */
  bodyExtra?: Record<string, unknown>;
  /** Doplňující editory (struktura blindů, vlastní výplaty) pod formulářem nastavení. */
  extras?: (v: { values: SettingValues; set: (k: string, v: SettingValue) => void }) => React.ReactNode;
}

export type { Template };

export function CreateDialog({ templates, onClose, onCreated, kind = 'cash', postPath = '/api/lobby/tables', title, nameLabel, extras, bodyExtra }: CreateProps) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [name, setName] = useState('');
  const [overrides, setOverrides] = useState<Record<string, SettingValue>>({});
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState('');
  const tpl = templates.find((x) => x.id === templateId);
  const resolved = useMemo(() => resolveSettings(registry, [{ scope: 'template', values: tpl?.values ?? {} }, { scope: 'table', values: overrides }]), [tpl, overrides]);
  const issues = useMemo(() => validateValues(registry, { ...(tpl?.values ?? {}), ...overrides }), [tpl, overrides]);

  return (
    <Modal title={title ?? t('lobby.create')} onClose={onClose} dirty={name.trim().length > 0 || Object.keys(overrides).length > 0}>
      <div className="flex flex-col gap-3">
        <TextInput label={nameLabel ?? t('lobby.tableName')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">{t('lobby.template')}</legend>
          {templates.map((x) => (
            <label key={x.id} className={`flex cursor-pointer flex-col rounded-md border p-2 ${x.id === templateId ? 'border-primary' : 'border-line'}`}>
              <span className="flex items-center gap-2">
                <input type="radio" name="tpl" checked={x.id === templateId} onChange={() => { setTemplateId(x.id); setOverrides({}); }} />
                <strong>{t(x.name)}</strong>
              </span>
              <span className="text-sm text-muted">{t(x.description)}</span>
            </label>
          ))}
        </fieldset>
        <Button onClick={() => setAdvanced(!advanced)}>{advanced ? t('lobby.hideAdvanced') : t('lobby.showAdvanced')}</Button>
        {advanced && (
          <SettingsForm
            registry={registry}
            values={resolved.values}
            origins={resolved.origins}
            editScope="table"
            onChange={(k, v) => setOverrides({ ...overrides, [k]: v })}
            onReset={(k) => setOverrides(Object.fromEntries(Object.entries(overrides).filter(([x]) => x !== k)))}
            issues={issues}
            allowedKeys={tableScoped}
            gameKind={kind}
          />
        )}
        {extras?.({ values: resolved.values, set: (k, v) => setOverrides((o) => ({ ...o, [k]: v })) })}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={issues.length > 0 || name.trim().length < 2}
            onClick={async () => {
              try {
                const r = await post<{ id: string }>(postPath, { name, templateId, settings: overrides, ...bodyExtra });
                onCreated(r.id);
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('lobby.createSubmit')}
          </Button>
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}

interface Details {
  id: string;
  name: string;
  templateId: string | null;
  values: SettingValues;
  overrides: Record<string, SettingValue>;
  pending: Record<string, SettingValue>;
  started: boolean;
  handInProgress: boolean;
  isAdmin: boolean;
}

export function EditDialog({ tableId, onClose, kind = 'cash', basePath = '/api/lobby/tables', extras }: { tableId: string; onClose: () => void; kind?: 'cash' | 'tournament'; basePath?: string; extras?: CreateProps['extras'] }) {
  const detailsPath = kind === 'tournament' ? `${basePath}/${tableId}/details` : `${basePath}/${tableId}`;
  const [d, setD] = useState<Details | null>(null);
  const [changes, setChanges] = useState<Record<string, SettingValue>>({});
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  useEffect(() => {
    get<Details>(detailsPath).then(setD).catch((e) => setError(errorText(e)));
  }, [detailsPath]);
  const values = useMemo(() => ({ ...(d?.values ?? {}), ...changes }), [d, changes]);
  const issues = useMemo(() => (d ? validateValues(registry, { ...d.values, ...changes }) : []), [d, changes]);
  if (!d) return <Modal title={t('lobby.edit')} onClose={onClose}>{error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />}</Modal>;
  const ctx = { gameStarted: d.started, handInProgress: d.handInProgress, isAdmin: d.isAdmin };
  const dirty = Object.keys(changes).length > 0;
  const save = async () => {
    try {
      const r = await patch<{ applied: string[]; pending: string[] }>(`${basePath}/${tableId}`, { settings: changes });
      setInfo(r.pending.length ? t('lobby.savedPending') : t('lobby.saved'));
      setChanges({});
      setError('');
      setD(await get<Details>(detailsPath));
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal title={`${t('lobby.edit')}: ${d.name}`} onClose={onClose} dirty={dirty}>
      <div className="flex flex-col gap-3">
        <SettingsForm
          registry={registry}
          values={values}
          origins={Object.fromEntries(registry.all().map((x) => [x.key, x.key in changes || x.key in d.overrides ? 'table' : 'template']))}
          editScope="table"
          onChange={(k, v) => setChanges({ ...changes, [k]: v })}
          onReset={(k) => setChanges(Object.fromEntries(Object.entries(changes).filter(([x]) => x !== k)))}
          issues={issues}
          allowedKeys={(def) => tableScoped(def) && decideChange(registry, def.key, ctx).result !== 'denied'}
          gameKind={kind}
          pendingKeys={Object.keys(changes)}
        />
        {extras?.({ values, set: (k, v) => setChanges((c) => ({ ...c, [k]: v })) })}
        {Object.keys(d.pending).length > 0 && <Notice>{t('lobby.pending', { keys: Object.keys(d.pending).join(', ') })}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        {info && <Notice kind="success">{info}</Notice>}
        <div className="flex gap-2">
          <Button variant="primary" disabled={issues.length > 0 || !dirty} onClick={() => void save()}>
            {t('lobby.save')}
          </Button>
          <Button onClick={() => (!dirty || confirm(t('modal.discardConfirm'))) && onClose()}>{t('table.close')}</Button>
        </div>
        <UnsavedBar count={Object.keys(changes).length} disabled={issues.length > 0} onSave={() => void save()} onDiscard={() => setChanges({})} />
      </div>
    </Modal>
  );
}
