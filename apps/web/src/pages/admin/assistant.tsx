import { useCallback, useEffect, useRef, useState } from 'react';
import { ASSISTANT_CONTEXTS, renderPrompt, t, unknownVariables } from '@kb/shared';
import { errorText, get, post, put } from '../../api';
import { Badge, Button, Card, DataTable, Notice, Select, Spinner, Tabs, Td } from '../../ui';

interface Prompt {
  key: string;
  text: string;
  defaultText: string;
  custom: boolean;
  version: number;
  variables: string[];
}
interface Version {
  version: number;
  text: string;
  isDefault: boolean;
  at: number;
  author: string | null;
}
interface DiffRow {
  key: string;
  label: string;
  before: string;
  after: string;
  timing: string;
}

const fmt = (ms: number) => new Date(ms).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' });
const promptLabel = (key: string) => (key.startsWith('tool.') ? `${t('assistantAdmin.tools')}: ${key.slice(5)}` : t(`prompt.key.${key}`));

function PromptsTab() {
  const [prompts, setPrompts] = useState<Prompt[] | null>(null);
  const [key, setKey] = useState('system');
  const [text, setText] = useState('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const load = useCallback(
    (select?: string) => {
      get<{ prompts: Prompt[] }>('/api/assistant/prompts')
        .then((d) => {
          setPrompts(d.prompts);
          const k = select ?? key;
          setText(d.prompts.find((p) => p.key === k)?.text ?? '');
        })
        .catch((e) => setMsg({ kind: 'error', text: errorText(e) }));
      get<{ versions: Version[] }>(`/api/assistant/prompts/${select ?? key}/versions`)
        .then((d) => setVersions(d.versions))
        .catch(() => setVersions([]));
    },
    [key],
  );
  useEffect(() => load(), [load]);
  if (!prompts) return <Spinner label={t('app.loading')} />;
  const cur = prompts.find((p) => p.key === key)!;
  const unknown = unknownVariables(text, cur.variables);
  const preview = renderPrompt(text, Object.fromEntries(cur.variables.map((v) => [v, `[${t(`assistant.var.${v}`)}]`])));
  const insert = (v: string) => {
    const el = area.current;
    const at = el?.selectionStart ?? text.length;
    setText(text.slice(0, at) + `{${v}}` + text.slice(el?.selectionEnd ?? at));
  };
  const run = async (fn: () => Promise<unknown>, after?: string) => {
    try {
      await fn();
      setMsg({ kind: 'success', text: t('integrations.saved') });
      load(after);
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Select label={t('assistantAdmin.prompts')} value={key} onChange={(e) => (setKey(e.target.value), setText(prompts.find((p) => p.key === e.target.value)?.text ?? ''))}>
        {prompts.map((p) => (
          <option key={p.key} value={p.key}>
            {promptLabel(p.key)} {p.custom ? '•' : ''}
          </option>
        ))}
      </Select>
      <div className="flex items-center gap-2">
        <Badge tone={cur.custom ? 'warning' : 'muted'}>{cur.custom ? `${t('assistantAdmin.promptCustom')} (v${cur.version})` : t('assistantAdmin.promptDefault')}</Badge>
      </div>
      <textarea ref={area} aria-label={promptLabel(key)} className="min-h-48 w-full rounded-sm border border-line bg-surface px-2 py-1 font-mono text-sm text-text" value={text} onChange={(e) => setText(e.target.value)} />
      {cur.variables.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <span className="text-muted">{t('assistantAdmin.variables')}:</span>
          {cur.variables.map((v) => (
            <button key={v} title={t(`assistant.var.${v}`)} className="rounded-sm border border-line bg-raised px-2 font-mono" onClick={() => insert(v)}>
              {`{${v}}`}
            </button>
          ))}
        </div>
      )}
      {unknown.length > 0 && <Notice kind="error">{t('assistantAdmin.unknownVar', { names: unknown.map((u) => `{${u}}`).join(', ') })}</Notice>}
      <div>
        <h3 className="text-sm font-bold">{t('assistantAdmin.preview')}</h3>
        <p className="whitespace-pre-wrap rounded-md border border-line bg-raised p-2 text-sm">{preview}</p>
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={unknown.length > 0 || text.trim() === '' || text === cur.text} onClick={() => void run(() => put(`/api/assistant/prompts/${key}`, { text }))}>
          {t('assistantAdmin.promptSave')}
        </Button>
        <Button disabled={!cur.custom} onClick={() => void run(() => post('/api/assistant/prompts/reset', { key }))}>
          {t('assistantAdmin.promptReset')}
        </Button>
      </div>
      <h3 className="text-sm font-bold">{t('assistantAdmin.versions')}</h3>
      {versions.length === 0 && <p className="text-sm text-muted">{t('assistantAdmin.promptDefault')}</p>}
      {versions.map((v) => (
        <div key={v.version} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2 text-sm">
          <strong>v{v.version}</strong>
          <span className="text-muted">
            {fmt(v.at)} · {v.author ?? '?'}
          </span>
          {v.isDefault && <Badge>{t('assistantAdmin.promptDefault')}</Badge>}
          <span className="min-w-0 flex-1 truncate text-muted">{v.text}</span>
          <Button onClick={() => void run(() => post(`/api/assistant/prompts/${key}/revert`, { version: v.version }))}>{t('assistantAdmin.revert')}</Button>
        </div>
      ))}
    </div>
  );
}

function SandboxTab() {
  const [context, setContext] = useState('lobby');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ system: string; reply: string; proposals: { summary: string; diff: DiffRow[] }[] } | null>(null);
  const [error, setError] = useState('');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{t('assistantAdmin.sandboxHelp')}</p>
      <Select label={t('assistantAdmin.sandboxContext')} value={context} onChange={(e) => setContext(e.target.value)}>
        {ASSISTANT_CONTEXTS.map((c) => (
          <option key={c} value={c}>
            {t(`assistant.ctxName.${c}`)}
          </option>
        ))}
      </Select>
      <textarea aria-label={t('assistant.placeholder')} placeholder={t('assistant.placeholder')} className="min-h-24 w-full rounded-sm border border-line bg-surface px-2 py-1 text-text" value={text} onChange={(e) => setText(e.target.value)} />
      <div>
        <Button
          variant="primary"
          disabled={busy || !text.trim()}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              setOut(await post('/api/assistant/sandbox', { text, context }));
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('assistant.thinking') : t('assistantAdmin.sandboxRun')}
        </Button>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {out && (
        <>
          <Card title={t('assistantAdmin.sandboxPrompt')}>
            <pre className="whitespace-pre-wrap text-sm">{out.system}</pre>
          </Card>
          <Card title={t('assistantAdmin.sandboxReply')}>
            <p className="whitespace-pre-wrap">{out.reply}</p>
          </Card>
          {out.proposals.length > 0 && (
            <Card title={t('assistantAdmin.sandboxProposals')}>
              {out.proposals.map((p, i) => (
                <div key={i} className="mb-2">
                  <p className="text-sm">{p.summary}</p>
                  <ul className="text-sm text-muted">
                    {p.diff.map((r, j) => (
                      <li key={j}>{r.key ? `${r.label}: ${r.before} → ${r.after} (${t(`assistant.diff.timing.${r.timing}`)})` : r.label}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function UsageTab() {
  const [u, setU] = useState<{ day: string; rows: { userId: string; nickname: string; requests: number; tokens: number; localAnswers: number }[]; totalRequests: number; totalTokens: number; totalLocal: number; warnPercent: number; maxPerUser: number; maxGlobal: number } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    get<NonNullable<typeof u>>('/api/assistant/usage')
      .then(setU)
      .catch((e) => setMsg({ kind: 'error', text: errorText(e) }));
  }, []);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          onClick={async () => {
            try {
              const r = await post<{ ok: boolean; error?: string }>('/api/assistant/test');
              setMsg(r.ok ? { kind: 'success', text: t('assistantAdmin.testOk') } : { kind: 'error', text: r.error ?? '' });
            } catch (e) {
              setMsg({ kind: 'error', text: errorText(e) });
            }
          }}
        >
          {t('assistantAdmin.test')}
        </Button>
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {u && u.maxGlobal > 0 && u.totalRequests * 100 >= u.maxGlobal * u.warnPercent && <Notice kind="error">{t('assistantAdmin.usageWarn', { percent: Math.round((u.totalRequests * 100) / u.maxGlobal) })}</Notice>}
      {u && (
        <Card title={`${t('assistantAdmin.usage')}: ${t('assistantAdmin.usageToday')}`}>
          <p className="mb-2 text-sm text-muted">
            {u.totalRequests} / {u.maxGlobal > 0 ? u.maxGlobal : t('assistant.unlimited')} · {u.totalTokens} tokenů · {t('assistantAdmin.usageLocal')}: {u.totalLocal}
          </p>
          <DataTable head={[t('assistantAdmin.usageUser'), t('assistantAdmin.usageRequests'), t('assistantAdmin.usageTokens')]}>
            {u.rows.map((r) => (
              <tr key={r.userId}>
                <Td>{r.nickname}</Td>
                <Td className="font-mono">{r.requests}</Td>
                <Td className="font-mono">{r.tokens}</Td>
              </tr>
            ))}
          </DataTable>
        </Card>
      )}
    </div>
  );
}

function ToolsTab() {
  const [tools, setTools] = useState<{ name: string; description: string; enabled: boolean }[]>([]);
  const [layer, setLayer] = useState<Record<string, unknown>>({});
  const [log, setLog] = useState<{ id: string; tool: string; ok: boolean; detail: string | null; at: number; nickname: string | null }[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    get<{ tools: typeof tools }>('/api/mcp/tools').then((d) => setTools(d.tools)).catch((e) => setError(errorText(e)));
    get<{ values: Record<string, unknown> }>('/api/settings/global').then((d) => setLayer(d.values)).catch(() => undefined);
    get<{ calls: typeof log }>('/api/mcp/log').then((d) => setLog(d.calls)).catch(() => undefined);
  }, []);
  useEffect(() => load(), [load]);
  const off = (key: string) => String(layer[key] ?? '').split(/[\s,;]+/).filter(Boolean);
  const toggle = async (key: string, tool: string) => {
    const cur = off(key);
    const next = cur.includes(tool) ? cur.filter((x) => x !== tool) : [...cur, tool];
    try {
      await put('/api/settings/global', { key, value: next.join(', ') });
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{t('assistantAdmin.mcpHow')}</p>
      {error && <Notice kind="error">{error}</Notice>}
      <DataTable head={[t('assistantAdmin.tools'), t('assistant.title'), 'MCP']}>
        {tools.map((x) => (
          <tr key={x.name}>
            <Td>
              <strong className="font-mono text-sm">{x.name}</strong>
              <div className="text-xs text-muted">{x.description}</div>
            </Td>
            <Td>
              {!x.name.includes('proposal') && (
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={!off('assistant.disabledTools').includes(x.name)} onChange={() => void toggle('assistant.disabledTools', x.name)} /> {t('assistantAdmin.toolEnabled')}
                </label>
              )}
            </Td>
            <Td>
              <label className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={x.enabled} onChange={() => void toggle('mcp.disabledTools', x.name)} /> {t('assistantAdmin.toolEnabled')}
              </label>
            </Td>
          </tr>
        ))}
      </DataTable>
      <Card title={t('assistantAdmin.mcpLog')}>
        <DataTable head={['', 'Nástroj', '', 'Kdo']}>
          {log.map((l) => (
            <tr key={l.id}>
              <Td className="text-xs">{fmt(l.at)}</Td>
              <Td className="font-mono text-sm">{l.tool}</Td>
              <Td>
                <Badge tone={l.ok ? 'success' : 'danger'}>{l.ok ? 'OK' : (l.detail ?? 'chyba')}</Badge>
              </Td>
              <Td>{l.nickname}</Td>
            </tr>
          ))}
        </DataTable>
      </Card>
    </div>
  );
}

export function AssistantAdminPage() {
  const [tab, setTab] = useState<'prompts' | 'sandbox' | 'usage' | 'tools'>('prompts');
  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-heading text-2xl font-bold">{t('assistantAdmin.title')}</h1>
      <p className="text-sm text-muted">{t('assistantAdmin.intro')}</p>
      <Tabs
        tabs={[
          { id: 'prompts' as const, label: t('assistantAdmin.prompts') },
          { id: 'sandbox' as const, label: t('assistantAdmin.sandbox') },
          { id: 'usage' as const, label: t('assistantAdmin.usage') },
          { id: 'tools' as const, label: t('assistantAdmin.tools') },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'prompts' && <PromptsTab />}
      {tab === 'sandbox' && <SandboxTab />}
      {tab === 'usage' && <UsageTab />}
      {tab === 'tools' && <ToolsTab />}
    </div>
  );
}
