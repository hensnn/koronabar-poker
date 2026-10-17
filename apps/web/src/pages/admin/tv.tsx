import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get, patch, post, put } from '../../api';
import { Badge, Button, Card, Modal, Notice, Select, Spinner, TextInput } from '../../ui';

const SCREEN_TYPES = ['clock', 'payouts', 'players', 'leaderboard', 'table', 'polls', 'upcoming', 'evening'] as const;

interface Device {
  id: string;
  name: string;
  layoutId: string | null;
  paired: boolean;
  codePending: boolean;
  lastSeenAt: number | null;
}
interface Screen {
  type: (typeof SCREEN_TYPES)[number];
  seconds?: number;
  tableId?: string;
  tournamentId?: string;
}
interface Layout {
  id: string;
  name: string;
  screens: Screen[];
  fontScalePercent?: number;
  strip?: boolean;
}

const tvUrl = () => `${window.location.origin}/tv`;

/** Správa televizí (párování kódem, odvolání) a rozvržení střídaných obrazovek. */
export function TvAdminPage() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [name, setName] = useState('');
  const [layoutId, setLayoutId] = useState('');
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);

  const load = useCallback(() => {
    get<{ devices: Device[]; layouts: Layout[] }>('/api/tv/devices')
      .then((d) => {
        setDevices(d.devices);
        setLayouts(d.layouts);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError('');
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!devices) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;

  const setLayout = (i: number, patchL: Partial<Layout>) => setLayouts(layouts.map((l, j) => (j === i ? { ...l, ...patchL } : l)));
  const setScreen = (i: number, k: number, p: Partial<Screen>) => setLayout(i, { screens: layouts[i]!.screens.map((s, j) => (j === k ? { ...s, ...p } : s)) });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-heading text-2xl font-bold">{t('tvAdmin.title')}</h1>
      <p className="text-muted">{t('tvAdmin.help', { url: tvUrl() })}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {info && <Notice>{info}</Notice>}

      <Card title={t('tvAdmin.add')}>
        <div className="flex flex-wrap items-end gap-2">
          <TextInput label={t('tvAdmin.name')} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <Select label={t('tvAdmin.layout')} value={layoutId} onChange={(e) => setLayoutId(e.target.value)}>
            <option value="">{t('tvAdmin.defaultLayout')}</option>
            {layouts.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            disabled={name.trim().length < 2}
            onClick={() =>
              void run(async () => {
                setCode(await post<{ code: string; expiresAt: number }>('/api/tv/devices', { name, layoutId: layoutId || null }));
                setName('');
              })
            }
          >
            {t('tvAdmin.create')}
          </Button>
        </div>
      </Card>

      <Card>
        {devices.length === 0 ? (
          <p className="text-muted">{t('tvAdmin.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2">
                <strong className="flex-1">{d.name}</strong>
                {d.paired ? <Badge tone="success">{t('tvAdmin.paired')}</Badge> : <Badge tone={d.codePending ? 'warning' : 'danger'}>{t(d.codePending ? 'tvAdmin.waiting' : 'tvAdmin.codeExpired')}</Badge>}
                <span className="text-sm text-muted">{d.lastSeenAt ? t('tvAdmin.lastSeen', { time: new Date(d.lastSeenAt).toLocaleString() }) : t('tvAdmin.never')}</span>
                <Select label={t('tvAdmin.layout')} value={d.layoutId ?? ''} onChange={(e) => void run(() => patch(`/api/tv/devices/${d.id}`, { layoutId: e.target.value || null }))}>
                  <option value="">{t('tvAdmin.defaultLayout')}</option>
                  {layouts.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
                <Button title={t('tvAdmin.newCodeHelp')} onClick={() => void run(async () => setCode(await post<{ code: string; expiresAt: number }>(`/api/tv/devices/${d.id}/code`)))}>
                  {t('tvAdmin.newCode')}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (confirm(t('tvAdmin.confirmRemove'))) void run(() => del(`/api/tv/devices/${d.id}`));
                  }}
                >
                  {t('tvAdmin.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('tvAdmin.layouts')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t('tvAdmin.layoutHelp')}</p>
          {layouts.map((l, i) => (
            <fieldset key={i} className="flex flex-col gap-2 rounded-md border border-line p-3">
              <div className="flex flex-wrap items-end gap-2">
                <TextInput label={t('tvAdmin.layoutId')} value={l.id} maxLength={30} onChange={(e) => setLayout(i, { id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
                <TextInput label={t('tvAdmin.layoutName')} value={l.name} maxLength={40} onChange={(e) => setLayout(i, { name: e.target.value })} />
                <TextInput label={t('tvAdmin.fontScale')} type="number" min={50} max={300} value={l.fontScalePercent ?? ''} onChange={(e) => setLayout(i, { fontScalePercent: e.target.value === '' ? undefined : Number(e.target.value) })} />
                <label className="flex items-center gap-2 pb-1">
                  <input type="checkbox" checked={l.strip ?? true} onChange={(e) => setLayout(i, { strip: e.target.checked })} />
                  {t('tvAdmin.strip')}
                </label>
                <Button variant="danger" onClick={() => setLayouts(layouts.filter((_, j) => j !== i))}>
                  {t('tvAdmin.removeLayout')}
                </Button>
              </div>
              <ol className="flex flex-col gap-1">
                {l.screens.map((sc, k) => (
                  <li key={k} className="flex flex-wrap items-end gap-2">
                    <Select label={t('tvAdmin.addScreen')} value={sc.type} onChange={(e) => setScreen(i, k, { type: e.target.value as Screen['type'] })}>
                      {SCREEN_TYPES.map((x) => (
                        <option key={x} value={x}>
                          {t(`tvAdmin.screen.${x}`)}
                        </option>
                      ))}
                    </Select>
                    <TextInput label={t('tvAdmin.seconds')} type="number" min={3} max={600} value={sc.seconds ?? ''} onChange={(e) => setScreen(i, k, { seconds: e.target.value === '' ? undefined : Number(e.target.value) })} />
                    <Button disabled={k === 0} onClick={() => setLayout(i, { screens: swap(l.screens, k, k - 1) })}>
                      ↑
                    </Button>
                    <Button disabled={k === l.screens.length - 1} onClick={() => setLayout(i, { screens: swap(l.screens, k, k + 1) })}>
                      ↓
                    </Button>
                    <Button onClick={() => setLayout(i, { screens: l.screens.filter((_, j) => j !== k) })}>×</Button>
                  </li>
                ))}
              </ol>
              <div>
                <Button onClick={() => setLayout(i, { screens: [...l.screens, { type: 'clock' }] })}>{t('tvAdmin.addScreen')}</Button>
              </div>
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setLayouts([...layouts, { id: `rozvrzeni-${layouts.length + 1}`, name: t('tvAdmin.addLayout'), screens: [{ type: 'clock' }] }])}>{t('tvAdmin.addLayout')}</Button>
            <Button
              variant="primary"
              onClick={() =>
                void run(async () => {
                  await put('/api/tv/layouts', { layouts });
                  setInfo(t('tvAdmin.saved'));
                })
              }
            >
              {t('tvAdmin.save')}
            </Button>
          </div>
        </div>
      </Card>

      {code && (
        <Modal title={t('tvAdmin.code')} onClose={() => setCode(null)}>
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="font-mono text-5xl font-bold tracking-widest">{code.code}</p>
            <p className="text-sm text-muted">{t('tvAdmin.codeHint', { time: new Date(code.expiresAt).toLocaleTimeString(), url: tvUrl() })}</p>
            <Button variant="primary" onClick={() => setCode(null)}>
              OK
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function swap<T>(list: T[], a: number, b: number): T[] {
  const out = [...list];
  [out[a], out[b]] = [out[b]!, out[a]!];
  return out;
}
