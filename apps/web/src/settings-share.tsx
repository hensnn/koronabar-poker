import { useEffect, useState } from 'react';
import { decodeSettingsCode, encodeSettingsCode, labelKey, optionKey, SETTING_SETS, t, type SettingsProfileData, type SettingValue } from '@kb/shared';
import { del, errorText, get, post } from './api';
import { applySet, exportSet, previewSet, registry, resetSet, type SetChange } from './settings';
import { Button, Card, Notice, TextArea, TextInput } from './ui';

interface PublicProfile {
  id: string;
  name: string;
  description: string;
  deviceKind: 'phone' | 'desktop' | null;
  set: string | null;
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

type Panel = { set: string; mode: 'share' | 'take' } | null;
type Incoming = { title: string; data: SettingsProfileData; changes: SetChange[]; toDefault: string[]; dropped: number };

/**
 * Správa osobního nastavení po sadách (stůl na počítači, stůl na telefonu, zvuky, vzhled, upozornění):
 * u každé sady jde obnovit výchozí hodnoty, sdílet ji (kód nebo veřejný profil) a převzít sdílenou od jiného hráče, vždy s náhledem změn.
 */
export function SettingsShare() {
  const [panel, setPanel] = useState<Panel>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [profiles, setProfiles] = useState<PublicProfile[]>([]);
  const [code, setCode] = useState('');
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = () => void get<{ profiles: PublicProfile[] }>('/api/settings-profiles').then((r) => setProfiles(r.profiles)).catch(() => undefined);
  useEffect(reload, []);
  const fail = (e: unknown) => setMsg({ kind: 'error', text: e instanceof Error && e.message === 'INVALID_CODE' ? t('share.invalidCode') : errorText(e) });
  const open = (set: string, mode: 'share' | 'take') => {
    setPanel(panel?.set === set && panel.mode === mode ? null : { set, mode });
    setCode('');
    setIncoming(null);
    setMsg(null);
  };
  const show = async (title: string, data: SettingsProfileData, set: string) => {
    try {
      if (data.set !== set) throw new Error('INVALID_CODE');
      setIncoming({ title, data, ...(await previewSet(data)) });
      setMsg(null);
    } catch (e) {
      fail(e);
    }
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('share.title')}>
      <div className="flex flex-col gap-3">
        <Notice>{t('share.intro')}</Notice>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        <ul className="flex flex-col gap-3">
          {SETTING_SETS.map((s) => {
            const mine = panel?.set === s.id ? panel : null;
            const list = profiles.filter((p) => p.set === s.id);
            return (
              <li key={s.id} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold">{t(`sets.${s.id}`)}</h3>
                    <p className="text-sm text-muted">{t(`sets.${s.id}.help`)}</p>
                  </div>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (!confirm(t('share.resetConfirm', { name: t(`sets.${s.id}`) }))) return;
                        await resetSet(s.id);
                        setMsg({ kind: 'success', text: t('share.resetDone', { name: t(`sets.${s.id}`) }) });
                      })
                    }
                  >
                    {t('share.reset')}
                  </Button>
                  <Button aria-pressed={mine?.mode === 'take'} onClick={() => open(s.id, 'take')}>
                    {t('share.takeShared', { n: list.length })}
                  </Button>
                  <Button aria-pressed={mine?.mode === 'share'} onClick={() => open(s.id, 'share')}>
                    {t('share.share')}
                  </Button>
                </div>

                {mine?.mode === 'share' && (
                  <div className="flex flex-col gap-2 border-t border-line pt-2">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        onClick={() =>
                          void run(async () => {
                            const text = encodeSettingsCode(await exportSet(s.id));
                            setCode(text);
                            try {
                              await navigator.clipboard.writeText(text);
                              setMsg({ kind: 'success', text: t('share.copied') });
                            } catch {
                              setMsg({ kind: 'success', text: t('share.copyManual') });
                            }
                          })
                        }
                      >
                        {t('share.copy')}
                      </Button>
                    </div>
                    {code && <TextArea label={t('share.code')} value={code} readOnly onFocus={(e) => e.currentTarget.select()} />}
                    <TextInput label={t('share.name')} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                    <TextInput label={t('share.description')} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
                    <div>
                      <Button
                        variant="primary"
                        disabled={busy || name.trim() === ''}
                        onClick={() =>
                          void run(async () => {
                            await post('/api/settings-profiles', { name, description, data: await exportSet(s.id) });
                            setName('');
                            setDescription('');
                            setMsg({ kind: 'success', text: t('share.published') });
                            reload();
                          })
                        }
                      >
                        {t('share.publish')}
                      </Button>
                    </div>
                  </div>
                )}

                {mine?.mode === 'take' && (
                  <div className="flex flex-col gap-3 border-t border-line pt-2">
                    {list.length === 0 ? (
                      <p className="text-sm text-muted">{t('share.publicNone')}</p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {list.map((p) => (
                          <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2">
                            <div className="min-w-0 flex-1">
                              <div className="font-semibold">{p.name}</div>
                              <div className="text-xs text-muted">
                                {t('share.by', { author: p.author })} · {t('share.count', { n: p.count })}
                              </div>
                              {p.description && <div className="text-sm">{p.description}</div>}
                            </div>
                            <Button
                              onClick={() =>
                                void run(async () => {
                                  const r = await get<{ name: string; data: SettingsProfileData }>(`/api/settings-profiles/${p.id}`);
                                  await show(t('share.fromProfile', { name: r.name, author: p.author }), r.data, s.id);
                                })
                              }
                            >
                              {t('share.take')}
                            </Button>
                            {p.canDelete && (
                              <Button
                                variant="danger"
                                onClick={() =>
                                  void run(async () => {
                                    if (!confirm(t('share.deleteConfirm', { name: p.name }))) return;
                                    await del(`/api/settings-profiles/${p.id}`);
                                    reload();
                                  })
                                }
                              >
                                {t('share.delete')}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex flex-col gap-2">
                      <TextArea label={t('share.pasteCode')} value={code} onChange={(e) => setCode(e.target.value)} hint={t('share.codeHint')} />
                      <div>
                        <Button
                          disabled={busy || code.trim() === ''}
                          onClick={() =>
                            void run(async () => {
                              await show(t('share.fromCode'), decodeSettingsCode(code), s.id);
                            })
                          }
                        >
                          {t('share.read')}
                        </Button>
                      </div>
                    </div>
                    {incoming && (
                      <section className="flex flex-col gap-2 rounded-md border-2 border-primary p-3" aria-live="polite">
                        <h4 className="font-semibold">{incoming.title}</h4>
                        {incoming.changes.length === 0 && incoming.toDefault.length === 0 ? (
                          <p className="text-sm text-muted">{t('share.nothingToChange')}</p>
                        ) : (
                          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
                            {incoming.changes.map((c) => (
                              <li key={c.key}>
                                <span className="font-medium">{t(labelKey(c.key))}</span>: <span className="text-muted">{valueText(c.key, c.from)}</span> → <span className="font-semibold">{valueText(c.key, c.to)}</span>
                              </li>
                            ))}
                            {incoming.toDefault.map((k) => (
                              <li key={`d:${k}`}>
                                <span className="font-medium">{t(labelKey(k))}</span>: <span className="text-muted">{t('share.backToDefault')}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {incoming.dropped > 0 && <p className="text-xs text-muted">{t('share.dropped', { n: incoming.dropped })}</p>}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="primary"
                            disabled={busy || (incoming.changes.length === 0 && incoming.toDefault.length === 0)}
                            onClick={() =>
                              void run(async () => {
                                const r = await applySet(incoming.data);
                                setMsg({ kind: 'success', text: t('share.applied', { n: r.applied, name: t(`sets.${s.id}`) }) });
                                setIncoming(null);
                                setCode('');
                              })
                            }
                          >
                            {t('share.apply')}
                          </Button>
                          <Button onClick={() => setIncoming(null)}>{t('table.cancel')}</Button>
                        </div>
                      </section>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
