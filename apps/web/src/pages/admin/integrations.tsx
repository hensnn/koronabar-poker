import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get, patch, post, put } from '../../api';
import { Badge, Button, Card, DataTable, Modal, Notice, Spinner, Td, TextInput } from '../../ui';
import { DiscordChannels, type DiscordChannel } from './discord';

interface Overview {
  events: string[];
  defaultEvents: string;
  discordEvents: string[];
  mqttEvents: string[];
  discordConfigured: boolean;
  discord: DiscordChannel[];
  mqttConfigured: boolean;
}
interface Endpoint {
  id: string;
  name: string;
  host: string;
  events: string[];
  enabled: boolean;
}
interface Delivery {
  id: string;
  target: string;
  event: string;
  status: 'pending' | 'ok' | 'failed';
  attempts: number;
  responseCode: number | null;
  error: string | null;
  at: number;
}

const fmt = (ms: number) => new Date(ms).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'medium' });

/** Zaškrtávací seznam událostí. */
function EventPicker({ all, value, onChange }: { all: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="grid gap-1 sm:grid-cols-2">
      {all.map((e) => (
        <label key={e} className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={value.includes(e)} onChange={(x) => onChange(x.target.checked ? [...value, e] : value.filter((v) => v !== e))} />
          <span className="min-w-0">
            {t(`integration.event.${e}`)} <span className="break-all font-mono text-xs text-muted">{e}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function ChannelCard({ title, channel, ov, selected, testLabel, okText, missing, reload }: { title: string; channel: 'mqtt' | 'discord'; ov: Overview; selected: string[]; testLabel: string; okText: string; missing: boolean; reload: () => void }) {
  const [events, setEvents] = useState(selected);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => setEvents(selected), [selected]);
  return (
    <Card title={title}>
      <div className="flex flex-col gap-3">
        {missing && <Notice>{channel === 'discord' ? t('integrations.discordMissing') : t('integrations.switchesHelp')}</Notice>}
        <EventPicker all={ov.events} value={events} onChange={setEvents} />
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={async () => {
              try {
                await put(`/api/integrations/events/${channel}`, { events });
                setMsg({ kind: 'success', text: t('integrations.saved') });
                reload();
              } catch (e) {
                setMsg({ kind: 'error', text: errorText(e) });
              }
            }}
          >
            {t('integrations.saveEvents')}
          </Button>
          <Button
            onClick={async () => {
              try {
                const r = await post<{ ok: boolean; error?: string }>(`/api/integrations/${channel}/test`);
                setMsg(r.ok ? { kind: 'success', text: okText } : { kind: 'error', text: r.error ?? '' });
              } catch (e) {
                setMsg({ kind: 'error', text: errorText(e) });
              }
            }}
          >
            {testLabel}
          </Button>
        </div>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      </div>
    </Card>
  );
}

function WebhookDialog({ ov, onClose, onSaved }: { ov: Overview; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState('');
  return (
    <Modal title={t('integrations.webhookAdd')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <Notice kind="error">{error}</Notice>}
        <TextInput label={t('integrations.webhookName')} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <TextInput label={t('integrations.webhookUrl')} value={url} maxLength={500} onChange={(e) => setUrl(e.target.value)} />
        <p className="text-sm text-muted">{t('integrations.webhookEvents')}</p>
        <EventPicker all={ov.events} value={events} onChange={setEvents} />
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={name.trim().length < 2 || !url}
            onClick={async () => {
              try {
                await post('/api/integrations/webhooks', { name, url, events });
                onSaved();
                onClose();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('integrations.webhookAdd')}
          </Button>
          <Button onClick={onClose}>{t('table.cancel')}</Button>
        </div>
      </div>
    </Modal>
  );
}

export function IntegrationsAdminPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [eps, setEps] = useState<Endpoint[]>([]);
  const [log, setLog] = useState<Delivery[]>([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    Promise.all([get<Overview>('/api/integrations'), get<{ endpoints: Endpoint[] }>('/api/integrations/webhooks'), get<{ deliveries: Delivery[] }>('/api/integrations/deliveries')])
      .then(([o, e, l]) => {
        setOv(o);
        setEps(e.endpoints);
        setLog(l.deliveries);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  if (!ov) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t('app.loading')} />;
  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-heading text-2xl font-bold">{t('integrations.title')}</h1>
      <p className="text-sm text-muted">{t('integrations.intro')}</p>
      <Notice>{t('integrations.switchesHelp')}</Notice>
      {error && <Notice kind="error">{error}</Notice>}

      <ChannelCard title={t('integrations.mqtt')} channel="mqtt" ov={ov} selected={ov.mqttEvents} testLabel={t('integrations.mqttTest')} okText={t('integrations.mqttOk')} missing={!ov.mqttConfigured} reload={load} />
      <DiscordChannels channels={ov.discord} events={ov.events} reload={load} />

      <Card
        title={t('integrations.webhooks')}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            {t('integrations.webhookAdd')}
          </Button>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">{t('integrations.signHelp')}</p>
          {eps.length === 0 && <p className="text-muted">{t('integrations.webhookNone')}</p>}
          {eps.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2">
              <strong>{e.name}</strong>
              <span className="font-mono text-sm text-muted">{e.host}</span>
              <Badge tone={e.enabled ? 'success' : 'muted'}>{e.enabled ? t('integrations.webhookEnabled') : t('cosmetic.hidden')}</Badge>
              <span className="text-xs text-muted">{e.events.length === 0 ? '' : e.events.join(', ')}</span>
              <span className="ml-auto flex gap-2">
                <Button onClick={() => void run(() => patch(`/api/integrations/webhooks/${e.id}`, { enabled: !e.enabled }))}>{e.enabled ? t('cosmetic.unequip') : t('cosmetic.equip')}</Button>
                <Button onClick={() => void run(() => post(`/api/integrations/webhooks/${e.id}/test`))}>{t('integrations.webhookTest')}</Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (confirm(t('integrations.webhookConfirmDelete'))) void run(() => del(`/api/integrations/webhooks/${e.id}`));
                  }}
                >
                  {t('integrations.webhookDelete')}
                </Button>
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card title={t('integrations.log')}>
        {log.length === 0 ? (
          <p className="text-muted">{t('integrations.logEmpty')}</p>
        ) : (
          <DataTable head={[t('integrations.logTime'), t('integrations.logTarget'), t('integrations.logEvent'), t('integrations.logStatus'), t('integrations.logAttempts'), '']}>
            {log.map((d) => (
              <tr key={d.id}>
                <Td>{fmt(d.at)}</Td>
                <Td>{d.target.startsWith('discord') ? `Discord: ${ov.discord.find((c) => (c.slot === 1 ? 'discord' : `discord${c.slot}`) === d.target)?.name ?? d.target}` : eps.find((e) => d.target === `endpoint:${e.id}`)?.name ?? '?'}</Td>
                <Td className="font-mono text-xs">{d.event}</Td>
                <Td>
                  <Badge tone={d.status === 'ok' ? 'success' : d.status === 'failed' ? 'danger' : 'warning'}>{t(`integrations.status.${d.status}`)}</Badge>
                  {d.error && <span className="ml-1 text-xs text-muted">{d.error}</span>}
                </Td>
                <Td className="font-mono">{d.attempts}</Td>
                <Td>{d.status === 'failed' && <Button onClick={() => void run(() => post(`/api/integrations/deliveries/${d.id}/retry`))}>{t('integrations.logRetry')}</Button>}</Td>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>
      {adding && <WebhookDialog ov={ov} onClose={() => setAdding(false)} onSaved={load} />}
    </div>
  );
}
