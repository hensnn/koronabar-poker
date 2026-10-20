import { useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, post, put } from '../../api';
import { Link } from '../../router';
import { Badge, Button, Card, Notice, TextInput } from '../../ui';

export interface DiscordChannel {
  slot: number;
  name: string;
  enabled: boolean;
  events: string[];
  configured: boolean;
}

/** Zaškrtávací seznam událostí (stejný vzhled jako u ostatních kanálů). */
function Events({ all, value, onChange }: { all: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="grid gap-1 sm:grid-cols-2">
      {all.map((e) => (
        <label key={e} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.includes(e)} onChange={(x) => onChange(x.target.checked ? [...value, e] : value.filter((v) => v !== e))} />
          {t(`integration.event.${e}`)} <span className="font-mono text-xs text-muted">{e}</span>
        </label>
      ))}
    </div>
  );
}

function ChannelCard({ ch, events, reload }: { ch: DiscordChannel; events: string[]; reload: () => void }) {
  const [name, setName] = useState(ch.name);
  const [enabled, setEnabled] = useState(ch.enabled);
  const [picked, setPicked] = useState(ch.events);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    setName(ch.name);
    setEnabled(ch.enabled);
    setPicked(ch.events);
  }, [ch.name, ch.enabled, ch.events]);
  return (
    <Card title={`${t('integrations.discord')}: ${ch.name}`}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {ch.configured ? <Badge tone="success">{t('integrations.discordUrlSet')}</Badge> : <Badge tone="warning">{t('integrations.discordUrlMissing')}</Badge>}
          <Link to="/admin/tajne-udaje" className="text-sm underline">
            {t('integrations.discordSetUrl', { n: ch.slot })}
          </Link>
        </div>
        <TextInput label={t('integrations.discordChannelName')} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" role="switch" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('integrations.discordChannelOn')}
        </label>
        <Events all={events} value={picked} onChange={setPicked} />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              try {
                await put(`/api/integrations/discord/${ch.slot}`, { name, enabled, events: picked });
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
            disabled={!ch.configured}
            onClick={async () => {
              try {
                const r = await post<{ ok: boolean; error?: string }>(`/api/integrations/discord/${ch.slot}/test`);
                setMsg(r.ok ? { kind: 'success', text: t('integrations.discordOk') } : { kind: 'error', text: r.error ?? '' });
              } catch (e) {
                setMsg({ kind: 'error', text: errorText(e) });
              }
            }}
          >
            {t('integrations.discordTest')}
          </Button>
        </div>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      </div>
    </Card>
  );
}

/** Správa → Napojení ven: čtyři Discord kanály, každý s vlastním webhookem, názvem a událostmi. */
export function DiscordChannels({ channels, events, reload }: { channels: DiscordChannel[]; events: string[]; reload: () => void }) {
  return (
    <>
      <Notice>{t('integrations.discordMulti')}</Notice>
      {channels.map((c) => (
        <ChannelCard key={c.slot} ch={c} events={events} reload={reload} />
      ))}
    </>
  );
}
