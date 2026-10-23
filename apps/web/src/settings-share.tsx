import { useEffect, useState } from 'react';
import { decodeSettingsCode, encodeSettingsCode, labelKey, optionKey, t, type SettingsProfileData, type SettingValue } from '@kb/shared';
import { del, errorText, get, post } from './api';
import { applyProfile, currentProfile, deviceId, previewProfile, registry, resetUserSetting, useSettings } from './settings';
import { Button, Card, Notice, TextArea, TextInput } from './ui';

interface PublicProfile {
  id: string;
  name: string;
  description: string;
  deviceKind: 'phone' | 'desktop' | null;
  author: string;
  count: number;
  createdAt: number;
  mine: boolean;
  canDelete: boolean;
}

/** Hodnota nastavení čitelně: volby podle popisků, zapnuto/vypnuto, jinak text. */
function valueText(key: string, v: SettingValue | undefined): string {
  if (v === undefined) return '–';
  const def = registry.get(key);
  if (def?.type === 'enum') return t(optionKey(key, String(v)));
  if (typeof v === 'boolean') return v ? t('share.on') : t('share.off');
  return String(v);
}

/** Karta „Sdílení nastavení“: kód ke zkopírování, převzetí kódu nebo veřejného profilu s náhledem změn a seznam veřejných profilů. */
export function SettingsShare() {
  const settings = useSettings();
  const [code, setCode] = useState('');
  const [incoming, setIncoming] = useState<{ title: string; data: SettingsProfileData } | null>(null);
  const [includeDevice, setIncludeDevice] = useState(true);
  const [replace, setReplace] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [profiles, setProfiles] = useState<PublicProfile[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const reload = () => void get<{ profiles: PublicProfile[] }>('/api/settings-profiles').then((r) => setProfiles(r.profiles)).catch(() => undefined);
  useEffect(reload, []);
  const fail = (e: unknown) => setMsg({ kind: 'error', text: e instanceof Error && e.message === 'INVALID_CODE' ? t('share.invalidCode') : errorText(e) });

  const mine = (): SettingsProfileData => {
    const data = currentProfile();
    return { ...data, device: includeDevice ? data.device : {} };
  };
  const copy = async () => {
    const text = encodeSettingsCode(currentProfile());
    setCode(text);
    try {
      await navigator.clipboard.writeText(text);
      setMsg({ kind: 'success', text: t('share.copied') });
    } catch {
      setMsg({ kind: 'success', text: t('share.copyManual') });
    }
  };
  const readCode = () => {
    try {
      setIncoming({ title: t('share.fromCode'), data: decodeSettingsCode(code) });
      setMsg(null);
    } catch (e) {
      fail(e);
    }
  };
  const take = async (p: PublicProfile) => {
    try {
      const r = await get<{ name: string; data: SettingsProfileData }>(`/api/settings-profiles/${p.id}`);
      setIncoming({ title: t('share.fromProfile', { name: r.name, author: p.author }), data: r.data });
      setMsg(null);
    } catch (e) {
      fail(e);
    }
  };
  const publish = async () => {
    try {
      await post('/api/settings-profiles', { name, description, data: mine() });
      setName('');
      setDescription('');
      setMsg({ kind: 'success', text: t('share.published') });
      reload();
    } catch (e) {
      fail(e);
    }
  };

  const preview = incoming ? previewProfile(incoming.data, { includeDevice, replace }) : null;
  const hasDevice = !!incoming && Object.keys(incoming.data.device).length > 0;
  return (
    <Card title={t('share.title')}>
      <div className="flex flex-col gap-4">
        <Notice>{t('share.intro')}</Notice>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">{t('share.codeTitle')}</h3>
          <TextArea label={t('share.code')} value={code} onChange={(e) => setCode(e.target.value)} hint={t('share.codeHint')} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void copy()}>{t('share.copy')}</Button>
            <Button onClick={readCode} disabled={code.trim() === ''}>
              {t('share.read')}
            </Button>
          </div>
        </section>

        {incoming && preview && (
          <section className="flex flex-col gap-2 rounded-md border-2 border-primary p-3" aria-live="polite">
            <h3 className="font-semibold">{incoming.title}</h3>
            {hasDevice && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" role="switch" checked={includeDevice} onChange={(e) => setIncludeDevice(e.target.checked)} />
                {t('share.includeDevice', { kind: t(`settings.personal.kind.${incoming.data.deviceKind ?? deviceId()}`) })}
              </label>
            )}
            <label className="flex items-center gap-2 text-sm" title={t('share.replaceHelp')}>
              <input type="checkbox" role="switch" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              {t('share.replace')}
            </label>
            {preview.changes.length === 0 && preview.removed.length === 0 ? (
              <p className="text-sm text-muted">{t('share.nothingToChange')}</p>
            ) : (
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
                {preview.changes.map((c) => (
                  <li key={`${c.layer}:${c.key}`}>
                    <span className="font-medium">{t(labelKey(c.key))}</span>: <span className="text-muted">{valueText(c.key, c.from)}</span> → <span className="font-semibold">{valueText(c.key, c.to)}</span>
                    {c.layer === 'device' && <span className="ml-1 text-xs text-muted">({t('share.deviceOnly')})</span>}
                  </li>
                ))}
                {preview.removed.map((k) => (
                  <li key={`rm:${k}`}>
                    <span className="font-medium">{t(labelKey(k))}</span>: <span className="text-muted">{t('share.backToDefault')}</span>
                  </li>
                ))}
              </ul>
            )}
            {preview.dropped.length > 0 && <p className="text-xs text-muted">{t('share.dropped', { n: preview.dropped.length })}</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={preview.changes.length === 0 && preview.removed.length === 0}
                onClick={async () => {
                  try {
                    const r = await applyProfile(incoming.data, { includeDevice, replace });
                    setMsg({ kind: 'success', text: t('share.applied', { n: r.applied, removed: r.removed }) });
                    setIncoming(null);
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                {t('share.apply')}
              </Button>
              <Button onClick={() => setIncoming(null)}>{t('table.cancel')}</Button>
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">{t('share.publicTitle')}</h3>
          {profiles.length === 0 ? (
            <p className="text-sm text-muted">{t('share.publicNone')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {profiles.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface p-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{p.name}</div>
                    <div className="text-xs text-muted">
                      {t('share.by', { author: p.author })} · {t('share.count', { n: p.count })}
                      {p.deviceKind && ` · ${t(`settings.personal.kind.${p.deviceKind}`)}`}
                    </div>
                    {p.description && <div className="text-sm">{p.description}</div>}
                  </div>
                  <Button onClick={() => void take(p)}>{t('share.take')}</Button>
                  {p.canDelete && (
                    <Button
                      variant="danger"
                      onClick={async () => {
                        if (!confirm(t('share.deleteConfirm', { name: p.name }))) return;
                        await del(`/api/settings-profiles/${p.id}`).catch(fail);
                        reload();
                      }}
                    >
                      {t('share.delete')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col gap-2 border-t border-line pt-2">
            <h4 className="text-sm font-semibold">{t('share.publishTitle')}</h4>
            <TextInput label={t('share.name')} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <TextInput label={t('share.description')} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" role="switch" checked={includeDevice} onChange={(e) => setIncludeDevice(e.target.checked)} />
              {t('share.includeDevice', { kind: t(`settings.personal.kind.${deviceId()}`) })}
            </label>
            <div>
              <Button variant="primary" disabled={name.trim() === ''} onClick={() => void publish()}>
                {t('share.publish')}
              </Button>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-2 border-t border-line pt-2">
          <h3 className="font-semibold">{t('share.resetTitle')}</h3>
          <p className="text-sm text-muted">{t('share.resetHelp')}</p>
          <div>
            <Button
              onClick={async () => {
                if (!confirm(t('share.resetConfirm'))) return;
                for (const k of Object.keys(settings.user)) await resetUserSetting(k).catch(() => undefined);
                for (const k of Object.keys(settings.device)) await resetUserSetting(k, true).catch(() => undefined);
                setMsg({ kind: 'success', text: t('share.resetDone') });
              }}
            >
              {t('share.reset')}
            </Button>
          </div>
        </section>
      </div>
    </Card>
  );
}
