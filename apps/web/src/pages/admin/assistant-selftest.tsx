import { useCallback, useRef, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../../api';
import { Badge, Button, Notice } from '../../ui';

interface SelfTestResult {
  id: string;
  title: string;
  prompt: string;
  as: string;
  verdict: 'ok' | 'fail' | 'info';
  note: string;
  tools: string[];
  proposals: string[];
  reply: string;
  tokens: number;
  ms: number;
}
interface SelfTestJob {
  id: string;
  status: 'running' | 'done' | 'error';
  total: number;
  results: SelfTestResult[];
  tokens: number;
  error?: string;
}

const tone = (v: SelfTestResult['verdict']) => (v === 'ok' ? 'success' : v === 'fail' ? 'danger' : 'warning');
const verdictLabel = (v: SelfTestResult['verdict']) => t(v === 'ok' ? 'assistantAdmin.selftestOk' : v === 'fail' ? 'assistantAdmin.selftestFail' : 'assistantAdmin.selftestInfo');

/** Zkouška schopností: sada krátkých zadání proběhne v pískovišti se skutečným poskytovatelem a každé se vyhodnotí (nástroje, návrhy, bezpečnost). */
export function SelfTestTab() {
  const [job, setJob] = useState<SelfTestJob | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const jobId = useRef<string | null>(null);

  const poll = useCallback(async () => {
    if (!jobId.current) return;
    try {
      const j = await get<SelfTestJob>(`/api/assistant/selftest/${jobId.current}`);
      setJob(j);
      if (j.status === 'running') window.setTimeout(() => void poll(), 2000);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  const start = async () => {
    setError('');
    setCopied(false);
    try {
      const r = await post<{ id: string; total: number }>('/api/assistant/selftest');
      jobId.current = r.id;
      setJob({ id: r.id, status: 'running', total: r.total, results: [], tokens: 0 });
      window.setTimeout(() => void poll(), 1500);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const results = job?.results ?? [];
  const report = results
    .map((r) => `${r.verdict.toUpperCase()}  ${r.title} (${r.as}): ${r.note}\n  zadání: ${r.prompt}\n  nástroje: ${r.tools.join(', ') || '-'}; návrhy: ${r.proposals.join(' | ') || '-'}\n  odpověď: ${r.reply}`)
    .join('\n\n');
  const counts = { ok: 0, fail: 0, info: 0 };
  for (const r of results) counts[r.verdict]++;

  return (
    <div className="flex flex-col gap-3">
      <Notice>{t('assistantAdmin.selftestHelp')}</Notice>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void start()} disabled={job?.status === 'running'}>
          {job?.status === 'running' ? `${t('assistant.thinking')} (${results.length}/${job.total})` : t('assistantAdmin.selftestRun')}
        </Button>
        {results.length > 0 && (
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(report).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? t('share.copied') : t('diag.copy')}
          </Button>
        )}
        {job && (
          <span className="text-sm text-muted">
            ✔ {counts.ok} · ✖ {counts.fail} · ℹ {counts.info} · {t('assistantAdmin.selftestTokens', { n: job.tokens })}
          </span>
        )}
      </div>
      {job?.status === 'error' && <Notice kind="error">{t('assistantAdmin.selftestAborted', { code: job.error ?? '' })}</Notice>}
      <ul className="flex flex-col gap-2">
        {results.map((r) => (
          <li key={r.id} className="flex flex-col gap-1 rounded-md border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tone(r.verdict)}>{verdictLabel(r.verdict)}</Badge>
              <strong>{r.title}</strong>
              <span className="text-xs text-muted">
                {r.as === 'player' ? t('assistantAdmin.selftestAsPlayer') : t('assistantAdmin.selftestAsAdmin')} · {Math.round(r.ms / 100) / 10} s · {r.tokens} tok.
              </span>
            </div>
            <div className="text-sm">{r.note}</div>
            <div className="text-xs text-muted">
              {t('assistantAdmin.selftestPrompt')}: {r.prompt}
            </div>
            <div className="text-xs">
              {t('assistantAdmin.selftestTools')}: <span className="font-mono">{r.tools.join(', ') || '–'}</span>
              {r.proposals.length > 0 && ` · ${t('assistantAdmin.selftestProposals')}: ${r.proposals.join(' | ')}`}
            </div>
            {r.reply && <div className="rounded-md bg-raised px-2 py-1 text-sm">{r.reply}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
