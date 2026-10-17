import { useCallback, useEffect, useState } from 'react';
import { renderTemplate, t, type SettingValue } from '@kb/shared';
import { AnnouncerPlayer, pickVoice } from '../../announcer/engine';
import { errorText, get, post, put } from '../../api';
import { useSettings } from '../../settings';
import { Badge, Button, Card, Notice, Spinner, TextInput } from '../../ui';

interface EventCfg {
  key: string;
  vars: string[];
  enabled: boolean;
  variants: string[];
  defaults: string[];
}
interface Config {
  events: EventCfg[];
  status: { failing: { source: string; error: string; since: number } | null };
  cache: { files: number; bytes: number };
}

const SOURCES = ['browser', 'piper', 'google'] as const;
const preview = new AnnouncerPlayer();

const sampleVars = (vars: string[]) => Object.fromEntries(vars.map((v) => [v, t(`announce.sample.${v}`)]));

async function saveGlobal(key: string, value: SettingValue): Promise<void> {
  await put('/api/settings/global', { key, value });
}

/** Zkouška hlasu: serverový zdroj se stáhne a přehraje, hlas prohlížeče přečte zařízení. */
async function playSample(source: (typeof SOURCES)[number], text: string, voiceName: string): Promise<void> {
  if (source === 'browser') {
    if (!pickVoice(voiceName)) throw new Error(t('announcer.noCzechVoice'));
    preview.unlock();
    preview.enqueue({ id: `s${Date.now()}`, text, audio: false }, { enabled: true, browserOnly: true, volume: 1, rate: 1, voiceName, audioUrl: () => '' });
    return;
  }
  const res = await fetch('/api/announcer/sample', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, text }), credentials: 'include' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; params?: Record<string, unknown> };
    throw new Error(t(`error.${body.error ?? 'ANNOUNCER_SOURCE_FAILED'}`, body.params));
  }
  const url = URL.createObjectURL(await res.blob());
  const a = new Audio(url);
  a.onended = () => URL.revokeObjectURL(url);
  await a.play();
}

/** Správa hlasatele: zdroj hlasu, připojení Piperu a Google, šablony hlášek, mezipaměť. */
export function AnnouncerAdminPage() {
  const settings = useSettings();
  const v = settings.values;
  const [cfg, setCfg] = useState<Config | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { enabled: boolean; text: string }>>({});
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [voices, setVoices] = useState<{ source: string; list: string[] } | null>(null);

  const load = useCallback(() => {
    get<Config>('/api/announcer/config')
      .then((c) => {
        setCfg(c);
        setDrafts(Object.fromEntries(c.events.map((e) => [e.key, { enabled: e.enabled, text: e.variants.join('\n') }])));
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>, ok = '') => {
    try {
      await fn();
      setError('');
      setInfo(ok);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : errorText(e));
    }
  };

  if (!cfg) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;

  const source = String(v['announcer.source']) as (typeof SOURCES)[number];
  const tvSource = String(v['announcer.tvSource']);
  const text = (key: keyof typeof v, label: string, extra?: { type?: string }) => (
    <TextInput
      label={label}
      type={extra?.type}
      defaultValue={String(v[key as string] ?? '')}
      key={`${key}-${String(v[key as string])}`}
      onBlur={(e) => {
        const raw = e.target.value;
        const val = extra?.type === 'number' ? Number(raw) : raw;
        if (String(val) !== String(v[key as string])) void run(() => saveGlobal(key as string, val as SettingValue));
      }}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-heading text-2xl font-bold">{t('announcer.title')}</h1>
      <p className="text-muted">{t('announcer.help')}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {info && <Notice>{info}</Notice>}
      {cfg.status.failing ? <Notice kind="error">{t('announcer.status.failed', { error: cfg.status.failing.error })}</Notice> : <p className="text-sm text-muted">{t('announcer.status.ok')}</p>}

      <Card title={t('announcer.source')}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {SOURCES.map((s) => (
              <div key={s} className="flex items-center gap-1">
                <Button variant={source === s ? 'primary' : 'secondary'} aria-pressed={source === s} onClick={() => void run(() => saveGlobal('announcer.source', s))}>
                  {t(`announcer.source.${s}`)}
                </Button>
                <Button onClick={() => void run(() => playSample(s, t('announcer.sampleText'), String(v['announcer.userVoice'] ?? '')))}>{t('announcer.sample')}</Button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span>{t('announcer.tvSource')}:</span>
            {(['same', ...SOURCES] as const).map((s) => (
              <Button key={s} variant={tvSource === s ? 'primary' : 'secondary'} aria-pressed={tvSource === s} onClick={() => void run(() => saveGlobal('announcer.tvSource', s))}>
                {t(`announcer.source.${s}`)}
              </Button>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={v['announcer.allowUserChoice'] !== false} onChange={(e) => void run(() => saveGlobal('announcer.allowUserChoice', e.target.checked))} />
            {t('settings.announcer.allowUserChoice.label')}
          </label>
          <div className="flex flex-wrap gap-3">
            {text('announcer.ratePercent', t('settings.announcer.ratePercent.label'), { type: 'number' })}
            {text('announcer.volumePercent', t('settings.announcer.volumePercent.label'), { type: 'number' })}
            {text('announcer.countdownSeconds', t('settings.announcer.countdownSeconds.label'))}
          </div>
        </div>
      </Card>

      <Card title={t('announcer.source.piper')}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            {text('announcer.piperHost', t('announcer.piperHost'))}
            {text('announcer.piperPort', t('announcer.piperPort'), { type: 'number' })}
            {text('announcer.piperVoice', t('announcer.piperVoice'))}
            <Button
              onClick={() =>
                void run(async () => {
                  const r = await post<{ voices: string[] }>('/api/announcer/connection', { source: 'piper' });
                  setVoices({ source: 'piper', list: r.voices });
                }).catch(() => undefined)
              }
            >
              {t('announcer.testConnection')}
            </Button>
          </div>
          {voices?.source === 'piper' && <p className="text-sm">{t('announcer.connectionOk', { voices: voices.list.join(', ') || '–' })}</p>}
        </div>
      </Card>

      <Card title={t('announcer.source.google')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t('announcer.googleWarning')}</p>
          <div className="flex flex-wrap items-end gap-3">
            {text('announcer.googleVoice', t('announcer.googleVoice'))}
            <Button
              onClick={() =>
                void run(async () => {
                  const r = await post<{ voices: string[] }>('/api/announcer/connection', { source: 'google' });
                  setVoices({ source: 'google', list: r.voices });
                })
              }
            >
              {t('announcer.testConnection')}
            </Button>
          </div>
          {voices?.source === 'google' && <p className="text-sm">{t('announcer.connectionOk', { voices: voices.list.join(', ') || '–' })}</p>}
        </div>
      </Card>

      <Card title={t('announcer.cacheTitle')}>
        <div className="flex flex-wrap items-center gap-3">
          <span>{t('announcer.cache', { files: cfg.cache.files, mb: (cfg.cache.bytes / 1024 / 1024).toFixed(1) })}</span>
          <Button onClick={() => void run(async () => setInfo(t('announcer.pregenerated', { n: (await post<{ count: number }>('/api/announcer/pregenerate')).count })))}>{t('announcer.pregenerate')}</Button>
          <Button onClick={() => void run(() => post('/api/announcer/cache/clear'))}>{t('announcer.clearCache')}</Button>
        </div>
      </Card>

      <Card title={t('announcer.templates')}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t('announcer.templatesHelp')}</p>
          {cfg.events.map((e) => {
            const d = drafts[e.key] ?? { enabled: e.enabled, text: '' };
            const lines = d.text.split('\n').filter((l) => l.trim());
            const shown = lines.length > 0 ? lines : e.defaults;
            return (
              <fieldset key={e.key} className="flex flex-col gap-2 rounded-md border border-line p-3">
                <legend className="px-1 font-medium">{t(`announce.event.${e.key}`)}</legend>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={d.enabled} onChange={(ev) => setDrafts({ ...drafts, [e.key]: { ...d, enabled: ev.target.checked } })} />
                  {t('announcer.enabledEvent')}
                </label>
                <textarea
                  aria-label={t(`announce.event.${e.key}`)}
                  className="min-h-20 w-full rounded-sm border border-line bg-surface px-2 py-1 text-text"
                  value={d.text}
                  placeholder={e.defaults.join('\n')}
                  onChange={(ev) => setDrafts({ ...drafts, [e.key]: { ...d, text: ev.target.value } })}
                />
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                  {e.vars.length > 0 && <span>{t('announcer.variables')}:</span>}
                  {e.vars.map((x) => (
                    <Badge key={x}>{`{${x}} ${t(`announce.var.${x}`)}`}</Badge>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => void run(() => playSample(source, renderTemplate(shown[0]!, sampleVars(e.vars)), String(v['announcer.userVoice'] ?? '')))}>{t('announcer.sample')}</Button>
                  <Button onClick={() => setDrafts({ ...drafts, [e.key]: { ...d, text: '' } })}>{t('announcer.reset')}</Button>
                </div>
              </fieldset>
            );
          })}
          <div>
            <Button
              variant="primary"
              onClick={() =>
                void run(
                  () => put('/api/announcer/templates', { templates: Object.fromEntries(Object.entries(drafts).map(([k, d]) => [k, { enabled: d.enabled, variants: d.text.split('\n').map((l) => l.trim()).filter(Boolean) }])) }),
                  t('announcer.saved'),
                )
              }
            >
              {t('announcer.saveTemplates')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
