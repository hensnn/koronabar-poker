import { useCallback, useEffect, useMemo, useState } from 'react';
import { EMAIL_TEMPLATES, SECRETS, SMTP_PRESETS, parseList, scopeAllowed, t, validateValues, type SettingValue, type SettingValues } from '@kb/shared';
import { errorText, get, post, put, del } from '../../api';
import { can, useSession } from '../../session';
import { loadSettings, registry, saveGlobalSetting, useSettings } from '../../settings';
import { blockingIssues, SettingsForm, UnsavedBar } from '../../settings/SettingsForm';
import { Badge, Button, Card, DataTable, Notice, Select, Tabs, Td, TextArea, TextInput } from '../../ui';

// ---------- globální nastavení ----------

/** Osobní nastavení hráčů (vzhled, zvuky, panely…): správce k nim ve druhé stránce volí výchozí hodnoty. */
const isPersonal = (d: { key: string; scopes?: readonly string[] }) => !!d.scopes?.includes('user') && d.key !== 'ui.themeId';

/** `personal`: stránka Výchozí osobní nastavení (hodnoty bez osobních voleb správce); jinak Globální nastavení. */
export function GlobalSettingsPage({ personal = false }: { personal?: boolean }) {
  const settings = useSettings();
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [pending, setPending] = useState<Record<string, SettingValue>>({});
  // Výchozí osobní nastavení se zobrazuje bez osobních voleb správce: vestavěné hodnoty + globální výchozí.
  const base: SettingValues = personal ? ({ ...registry.defaults(), ...settings.global } as SettingValues) : settings.values;
  const values = { ...base, ...pending };
  const issues = useMemo(() => validateValues(registry, values), [values]);
  const problems = blockingIssues(issues, Object.keys(pending));
  const save = async () => {
    try {
      for (const [k, v] of Object.entries(pending)) await saveGlobalSetting(k, v);
      setPending({});
      setMsg({ kind: 'success', text: t('lobby.saved') });
      void loadSettings().catch(() => undefined);
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Notice>{t(personal ? 'admin.personalDefaults.info' : 'admin.globalSettings.info')}</Notice>
      {!personal && <Notice>{t('admin.globalSettings.tournamentNote')}</Notice>}
      {personal && (
        <Card title={t('admin.personalDefaults.takeTitle')}>
          <p className="mb-2 text-sm text-muted">{t('admin.personalDefaults.takeHelp')}</p>
          <Button
            onClick={() => {
              const mine = Object.entries(settings.user).filter(([k, v]) => v !== undefined && registry.get(k) && isPersonal(registry.get(k)!) && base[k] !== v);
              setPending({ ...pending, ...Object.fromEntries(mine as [string, SettingValue][]) });
              setMsg({ kind: 'success', text: t('admin.personalDefaults.taken', { n: mine.length }) });
            }}
          >
            {t('admin.personalDefaults.take')}
          </Button>
        </Card>
      )}
      <SettingsForm
        registry={registry}
        values={values}
        origins={Object.fromEntries(registry.all().map((d) => [d.key, d.key in pending || d.key in settings.global ? 'global' : 'default']))}
        editScope="global"
        onChange={(k, v) => setPending({ ...pending, [k]: v })}
        onReset={(k) => setPending(Object.fromEntries(Object.entries(pending).filter(([x]) => x !== k)))}
        issues={issues}
        allowedKeys={(d) => (personal ? isPersonal(d) : d.scopes !== undefined && scopeAllowed(d.scopes, 'global') && !isPersonal(d))}
        pendingKeys={Object.keys(pending)}
      />
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <UnsavedBar count={Object.keys(pending).length} disabled={problems.length > 0} onSave={() => void save()} onDiscard={() => setPending({})} problems={problems} />
    </div>
  );
}

// ---------- tajné údaje a SMTP ----------

interface SecretStatus {
  key: string;
  set: boolean;
  last4?: string;
  updatedAt?: string;
}

export function SecretsPage() {
  const { me } = useSession();
  const [rows, setRows] = useState<SecretStatus[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [edit, setEdit] = useState<{ key: string; value: string; password: string } | null>(null);
  const reload = useCallback(() => {
    get<SecretStatus[]>('/api/admin/secrets').then(setRows).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(reload, [reload]);

  return (
    <div className="flex flex-col gap-3">
      <Notice>{t('secrets.info')}</Notice>
      {error && <Notice kind="error">{error}</Notice>}
      {msg && <Notice kind="success">{msg}</Notice>}
      <DataTable head={[t('secrets.name'), t('admin.status'), t('secrets.updated'), '']}>
        {rows.map((r) => (
          <tr key={r.key}>
            <Td>{t(`secret.${r.key}`)}</Td>
            <Td>{r.set ? <Badge tone="success">{t('secrets.set', { last4: r.last4 })}</Badge> : <Badge>{t('secrets.notSet')}</Badge>}</Td>
            <Td>{r.updatedAt ? new Date(r.updatedAt).toLocaleString('cs-CZ') : ''}</Td>
            <Td>
              <div className="flex gap-1">
                <Button onClick={() => setEdit({ key: r.key, value: '', password: '' })}>{r.set ? t('secrets.replace') : t('secrets.add')}</Button>
                {r.set && (
                  <Button
                    onClick={async () => {
                      const password = prompt(t('secrets.reauth'));
                      if (!password) return;
                      await post(`/api/admin/secrets/${r.key}/delete`, { password }).then(reload).catch((e) => setError(errorText(e)));
                    }}
                  >
                    {t('admin.revoke')}
                  </Button>
                )}
              </div>
            </Td>
          </tr>
        ))}
      </DataTable>
      {r_gemini_hint(rows)}
      {edit && (
        <Card title={t('secrets.edit', { name: t(`secret.${edit.key}`) })}>
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await put(`/api/admin/secrets/${edit.key}`, { value: edit.value, password: edit.password });
                setEdit(null);
                setMsg(t('secrets.saved'));
                setError('');
                reload();
              } catch (er) {
                setError(errorText(er));
              }
            }}
          >
            <TextInput label={t('secrets.value')} type="password" autoComplete="off" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} required autoFocus />
            <TextInput label={t('secrets.reauth')} type="password" autoComplete="current-password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} required />
            <div className="flex gap-2">
              <Button variant="primary" type="submit">
                {t('lobby.save')}
              </Button>
              <Button type="button" onClick={() => setEdit(null)}>
                {t('table.cancel')}
              </Button>
            </div>
          </form>
        </Card>
      )}
      {can(me, 'system.kryptovani_klic') && <RotateKey />}
      {can(me, 'email.spravovat_smtp') && <SmtpCard />}
    </div>
  );
}

const r_gemini_hint = (rows: SecretStatus[]) => (rows.some((r) => r.key.startsWith('ai.gemini')) ? <Notice>{t('secrets.geminiHint')}</Notice> : null);

function RotateKey() {
  const [out, setOut] = useState<{ newKeyHex: string; version: number; savedToFile: boolean } | null>(null);
  const [error, setError] = useState('');
  return (
    <Card title={t('secrets.rotate.title')}>
      <p className="mb-2 text-sm text-muted">{t('secrets.rotate.info')}</p>
      <Button
        onClick={async () => {
          const password = prompt(t('secrets.reauth'));
          if (!password) return;
          try {
            setOut(await post('/api/admin/secrets/rotate', { password }));
            setError('');
          } catch (e) {
            setError(errorText(e));
          }
        }}
      >
        {t('secrets.rotate.button')}
      </Button>
      {error && <Notice kind="error">{error}</Notice>}
      {out && <Notice kind="success">{out.savedToFile ? t('secrets.rotate.file', { v: out.version }) : t('secrets.rotate.env', { v: out.version, key: out.newKeyHex })}</Notice>}
    </Card>
  );
}

function SmtpCard() {
  const settings = useSettings();
  const [pending, setPending] = useState<Record<string, SettingValue>>({});
  const [to, setTo] = useState('');
  const [result, setResult] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const values = { ...settings.values, ...pending };
  const keys = registry.all().filter((d) => d.category === 'email');
  const save = async () => {
    for (const [k, v] of Object.entries(pending)) await saveGlobalSetting(k, v);
    setPending({});
    void loadSettings().catch(() => undefined);
  };
  return (
    <Card title={t('smtp.title')}>
      <div className="flex flex-col gap-3">
        <Notice>{t('smtp.gmailHelp')}</Notice>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('smtp.presets')}>
          {SMTP_PRESETS.map((p) => (
            <Button key={p.id} onClick={() => setPending({ ...pending, 'email.smtpHost': p.host, 'email.smtpPort': p.port, 'email.smtpSecurity': p.security })}>
              {t(`smtp.preset.${p.id}`)}
            </Button>
          ))}
        </div>
        <SettingsForm
          registry={registry}
          values={values}
          origins={Object.fromEntries(keys.map((d) => [d.key, d.key in pending || d.key in settings.global ? 'global' : 'default']))}
          editScope="global"
          onChange={(k, v) => setPending({ ...pending, [k]: v })}
          onReset={(k) => setPending(Object.fromEntries(Object.entries(pending).filter(([x]) => x !== k)))}
          issues={[]}
          allowedKeys={(d) => d.category === 'email'}
          pendingKeys={Object.keys(pending)}
        />
        <UnsavedBar count={Object.keys(pending).length} onSave={() => void save().catch((e) => setResult({ kind: 'error', text: errorText(e) }))} onDiscard={() => setPending({})} />
        <div className="flex flex-wrap items-end gap-3">
          <TextInput label={t('smtp.testTo')} type="email" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button
            onClick={async () => {
              try {
                const r = await post<{ ok: boolean; error?: { key: string; params?: Record<string, unknown>; detail: string } }>('/api/admin/email/test', { to });
                setResult(r.ok ? { kind: 'success', text: t('smtp.testOk') } : { kind: 'error', text: t(r.error!.key, r.error!.params) });
              } catch (e) {
                setResult({ kind: 'error', text: errorText(e) });
              }
            }}
          >
            {t('smtp.test')}
          </Button>
        </div>
        {result && <Notice kind={result.kind}>{result.text}</Notice>}
      </div>
    </Card>
  );
}

void SECRETS;

// ---------- e-mail: šablony a fronta ----------

interface Template {
  key: string;
  variables: string[];
  security: boolean;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  custom: boolean;
}
interface QueueRow {
  id: number;
  toAddress: string;
  kind: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export function EmailPage() {
  const { me } = useSession();
  const tabs = [
    ...(can(me, 'email.sablony') ? [{ id: 'templates' as const, label: t('email.templates') }] : []),
    ...(can(me, 'email.spravovat_smtp') ? [{ id: 'rules' as const, label: t('email.rules') }] : []),
    ...(can(me, 'email.fronta') ? [{ id: 'queue' as const, label: t('email.queue') }] : []),
  ];
  const [tab, setTab] = useState<'templates' | 'queue' | 'rules'>(tabs[0]?.id ?? 'templates');
  return (
    <div className="flex flex-col gap-3">
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'templates' ? <Templates /> : tab === 'rules' ? <SendingRules /> : <Queue />}
    </div>
  );
}

/** Pravidla odesílání: zda se e-maily posílají, které druhy a komu. Každá změna se uloží hned. */
export function SendingRules() {
  const settings = useSettings();
  const v = settings.values;
  const [roles, setRoles] = useState<{ key: string; name: string }[]>([]);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [lists, setLists] = useState<{ allow: string; block: string } | null>(null);
  useEffect(() => {
    void get<{ key: string; name: string }[]>('/api/admin/roles').then(setRoles).catch(() => undefined);
  }, []);
  useEffect(() => {
    setLists((l) => l ?? { allow: String(v['email.recipientList'] ?? ''), block: String(v['email.blockList'] ?? '') });
  }, [v]);
  const save = async (key: string, value: SettingValue) => {
    try {
      await saveGlobalSetting(key, value);
      setMsg({ kind: 'success', text: t('lobby.saved') });
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    }
  };
  const disabled = new Set(parseList(v['email.disabledKinds']));
  const mode = String(v['email.recipientMode'] ?? 'all');
  const allowedRoles = new Set(parseList(v['email.recipientRoles']));
  const toggleKind = (key: string, on: boolean) => {
    const next = new Set(disabled);
    if (on) next.delete(key);
    else next.add(key);
    void save('email.disabledKinds', [...next].join(', '));
  };
  const toggleRole = (key: string, on: boolean) => {
    const next = new Set(allowedRoles);
    if (on) next.add(key);
    else next.delete(key);
    void save('email.recipientRoles', [...next].join(', '));
  };
  return (
    <div className="flex flex-col gap-3">
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <Card title={t('emailRules.sending')}>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={v['email.enabled'] !== false} onChange={(e) => void save('email.enabled', e.target.checked)} />
          {t('emailRules.enabled')}
        </label>
        <p className="text-sm text-muted">{t('emailRules.enabledHelp')}</p>
      </Card>
      <Card title={t('emailRules.kinds')}>
        <p className="text-sm text-muted">{t('emailRules.kindsHelp')}</p>
        <ul className="flex flex-col gap-1">
          {EMAIL_TEMPLATES.map((tpl) => (
            <li key={tpl.key}>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={tpl.security || !disabled.has(tpl.key)} disabled={tpl.security} onChange={(e) => toggleKind(tpl.key, e.target.checked)} />
                {t(`email.tpl.${tpl.key}`)}
                {tpl.security && <Badge tone="muted">{t('emailRules.security')}</Badge>}
              </label>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t('emailRules.recipients')}>
        <Select label={t('settings.email.recipientMode.label')} value={mode} onChange={(e) => void save('email.recipientMode', e.target.value)}>
          {['all', 'verified', 'roles', 'list'].map((m) => (
            <option key={m} value={m}>
              {t(`settings.email.recipientMode.option.${m}`)}
            </option>
          ))}
        </Select>
        <p className="text-sm text-muted">{t('settings.email.recipientMode.help')}</p>
        {mode === 'roles' && (
          <ul className="flex flex-wrap gap-3">
            {roles.map((r) => (
              <li key={r.key}>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={allowedRoles.has(r.key.toLowerCase())} onChange={(e) => toggleRole(r.key.toLowerCase(), e.target.checked)} />
                  {r.name}
                </label>
              </li>
            ))}
          </ul>
        )}
        {mode === 'list' && lists && (
          <TextArea label={t('settings.email.recipientList.label')} hint={t('settings.email.recipientList.help')} value={lists.allow} onChange={(e) => setLists({ ...lists, allow: e.target.value })} onBlur={() => void save('email.recipientList', lists.allow)} />
        )}
        {lists && <TextArea label={t('settings.email.blockList.label')} hint={t('settings.email.blockList.help')} value={lists.block} onChange={(e) => setLists({ ...lists, block: e.target.value })} onBlur={() => void save('email.blockList', lists.block)} />}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={v['email.allowUserOptOut'] !== false} onChange={(e) => void save('email.allowUserOptOut', e.target.checked)} />
          {t('settings.email.allowUserOptOut.label')}
        </label>
        <p className="text-sm text-muted">{t('settings.email.allowUserOptOut.help')}</p>
      </Card>
    </div>
  );
}

function Templates() {
  const [list, setList] = useState<Template[]>([]);
  const [sel, setSel] = useState('');
  const [draft, setDraft] = useState<Template | null>(null);
  const [preview, setPreview] = useState<{ subject: string; text: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const reload = useCallback(() => {
    get<Template[]>('/api/admin/email/templates').then((l) => {
      setList(l);
      setSel((s) => s || l[0]?.key || '');
    });
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => {
    setDraft(list.find((x) => x.key === sel) ?? null);
    setPreview(null);
  }, [sel, list]);
  if (!draft) return null;
  const sample = Object.fromEntries(draft.variables.map((v) => [v, `{${v}}`.toUpperCase()]));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {list.map((x) => (
          <Button key={x.key} variant={x.key === sel ? 'primary' : 'secondary'} onClick={() => setSel(x.key)}>
            {t(`email.tpl.${x.key}`)} {x.custom && '✎'}
          </Button>
        ))}
      </div>
      <p className="text-sm text-muted">
        {t('email.variables')}: {draft.variables.map((v) => `{${v}}`).join(', ')} {draft.security && `· ${t('email.securityNote')}`}
      </p>
      <TextInput label={t('email.subject')} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
      <TextArea label={t('email.bodyText')} value={draft.bodyText} onChange={(e) => setDraft({ ...draft, bodyText: e.target.value })} rows={10} />
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={async () => {
            const r = await post<{ subject: string; text: string }>(`/api/admin/email/templates/${draft.key}/preview`, { subject: draft.subject, bodyText: draft.bodyText, vars: sample });
            setPreview(r);
          }}
        >
          {t('email.preview')}
        </Button>
        <Button
          variant="primary"
          onClick={async () => {
            try {
              await put(`/api/admin/email/templates/${draft.key}`, { subject: draft.subject, bodyText: draft.bodyText });
              setMsg({ kind: 'success', text: t('lobby.saved') });
              reload();
            } catch (e) {
              setMsg({ kind: 'error', text: errorText(e) });
            }
          }}
        >
          {t('lobby.save')}
        </Button>
        {draft.custom && (
          <Button
            onClick={async () => {
              await del(`/api/admin/email/templates/${draft.key}`);
              reload();
            }}
          >
            {t('email.resetDefault')}
          </Button>
        )}
      </div>
      {preview && (
        <Card title={t('email.preview')}>
          <p className="font-medium">{preview.subject}</p>
          <pre className="whitespace-pre-wrap font-sans">{preview.text}</pre>
        </Card>
      )}
    </div>
  );
}

function Queue() {
  const [data, setData] = useState<{ items: QueueRow[]; stats: Record<string, number> } | null>(null);
  useEffect(() => {
    void get<{ items: QueueRow[]; stats: Record<string, number> }>('/api/admin/email/queue').then(setData);
  }, []);
  if (!data) return null;
  return (
    <div className="flex flex-col gap-3">
      <p>
        {['pending', 'sent', 'failed', 'skipped'].map((s) => (
          <span key={s} className="mr-3">
            {t(`email.status.${s}`)}: <strong>{data.stats[s] ?? 0}</strong>
          </span>
        ))}
      </p>
      <DataTable head={['#', t('email.to'), t('email.kind'), t('admin.status'), t('email.attempts'), t('email.error')]}>
        {data.items.map((m) => (
          <tr key={m.id}>
            <Td>{m.id}</Td>
            <Td>{m.toAddress}</Td>
            <Td>{t(`email.tpl.${m.kind}`)}</Td>
            <Td>
              <Badge tone={m.status === 'sent' ? 'success' : m.status === 'failed' ? 'danger' : m.status === 'skipped' ? 'warning' : 'muted'}>{t(`email.status.${m.status}`)}</Badge>
            </Td>
            <Td>{m.attempts}</Td>
            <Td className="text-sm">{m.lastError ? t(m.lastError.split('|')[0]!) : ''}</Td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

// ---------- audit ----------

interface AuditRow {
  id: number;
  at: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  source: string;
  reason: string | null;
}

export function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [action, setAction] = useState('');
  const [users, setUsers] = useState<Record<string, string>>({});
  useEffect(() => {
    void get<{ id: string; nickname: string }[]>('/api/directory').then((u) => setUsers(Object.fromEntries(u.map((x) => [x.id, x.nickname]))));
  }, []);
  useEffect(() => {
    void get<AuditRow[]>(`/api/admin/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`).then(setRows);
  }, [action]);
  return (
    <div className="flex flex-col gap-3">
      <TextInput label={t('audit.action')} value={action} onChange={(e) => setAction(e.target.value)} hint={t('audit.actionHint')} />
      <DataTable head={[t('wallet.when'), t('audit.actor'), t('audit.action'), t('audit.target'), t('audit.change'), t('audit.reason')]}>
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="whitespace-nowrap text-sm">{new Date(r.at).toLocaleString('cs-CZ')}</Td>
            <Td>{r.actorId ? (users[r.actorId] ?? r.actorId) : r.source}</Td>
            <Td className="font-mono text-sm">{r.action}</Td>
            <Td className="text-sm">{r.targetType}{r.targetId ? `: ${users[r.targetId] ?? r.targetId}` : ''}</Td>
            <Td className="font-mono text-xs">{r.after ? JSON.stringify(r.after).slice(0, 200) : ''}</Td>
            <Td className="text-sm">{r.reason}</Td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

// ---------- schvalování (čtyři oči) ----------

interface Approval {
  id: string;
  action: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  status: string;
  createdAt: string;
  decisionNote: string | null;
}

export function ApprovalsPage() {
  const { me } = useSession();
  const [rows, setRows] = useState<Approval[]>([]);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    get<Approval[]>('/api/approvals').then(setRows).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(reload, [reload]);
  const decide = (id: string, approve: boolean) => post(`/api/approvals/${id}/decide`, { approve, note: approve ? null : (prompt(t('cashier.rejectReason')) ?? '') }).then(reload).catch((e) => setError(errorText(e)));
  return (
    <div className="flex flex-col gap-3">
      <Notice>{t('approvals.info')}</Notice>
      {error && <Notice kind="error">{error}</Notice>}
      <DataTable head={[t('approvals.action'), t('approvals.payload'), t('admin.status'), '']}>
        {rows.map((r) => (
          <tr key={r.id}>
            <Td>{t(`perm.${r.action}.name`)}</Td>
            <Td className="font-mono text-xs">{JSON.stringify(r.payload)}</Td>
            <Td>
              <Badge tone={r.status === 'executed' ? 'success' : r.status === 'rejected' || r.status === 'failed' ? 'danger' : 'muted'}>{t(`approvals.status.${r.status}`)}</Badge>
            </Td>
            <Td>
              {r.status === 'pending' && r.requestedBy !== me?.user.id && can(me, 'schvalovani.rozhodovat') && (
                <div className="flex gap-1">
                  <Button variant="primary" onClick={() => void decide(r.id, true)}>
                    {t('cashier.approve')}
                  </Button>
                  <Button onClick={() => void decide(r.id, false)}>{t('cashier.reject')}</Button>
                </div>
              )}
              {r.status === 'pending' && r.requestedBy === me?.user.id && <span className="text-sm text-muted">{t('approvals.waiting')}</span>}
            </Td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
