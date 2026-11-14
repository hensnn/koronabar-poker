import { useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, post, put } from '../../api';
import { Link } from '../../router';
import { Badge, Button, Card, Notice, TextInput } from '../../ui';

export interface DiscordChannel {
  slot: number;
  name: string;
  enabled: boolean;
  /** Summaries (tournament end, evening) go out as a picture instead of text. */
  pictures: boolean;
  events: string[];
  configured: boolean;
}

/** Zaškrtávací seznam událostí (stejný vzhled jako u ostatních kanálů). */
function Events({ all, value, onChange }: { all: string[]; value: string[]; onChange: (v: string[]) => void }) {
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

function ChannelCard({ ch, events, reload }: { ch: DiscordChannel; events: string[]; reload: () => void }) {
  const [name, setName] = useState(ch.name);
  const [enabled, setEnabled] = useState(ch.enabled);
  const [pictures, setPictures] = useState(ch.pictures);
  const [picked, setPicked] = useState(ch.events);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    setName(ch.name);
    setEnabled(ch.enabled);
    setPictures(ch.pictures);
    setPicked(ch.events);
  }, [ch.name, ch.enabled, ch.pictures, ch.events]);
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
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" role="switch" checked={pictures} onChange={(e) => setPictures(e.target.checked)} />
            {t('integrations.discordPictures')}
          </label>
          <p className="text-sm text-muted">{t('integrations.discordPicturesHelp')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              try {
                await put(`/api/integrations/discord/${ch.slot}`, { name, enabled, pictures, events: picked });
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

/** Preview of the summary pictures with made-up data, drawn by the server exactly as Discord will get them. */
function PicturePreview() {
  const [kind, setKind] = useState<'tournament' | 'evening' | null>(null);
  // A fresh address on every click, so the picture reflects the settings as they are now.
  const [stamp, setStamp] = useState(0);
  const show = (k: 'tournament' | 'evening') => {
    setKind(k);
    setStamp((n) => n + 1);
  };
  return (
    <Card title={t('integrations.picturePreview')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('integrations.picturePreviewHelp')}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => show('tournament')}>{t('integrations.picturePreviewTournament')}</Button>
          <Button onClick={() => show('evening')}>{t('integrations.picturePreviewEvening')}</Button>
        </div>
        {kind && <img key={`${kind}-${stamp}`} className="h-auto max-w-full rounded-md border border-line" src={`/api/integrations/picture-preview/${kind}?v=${stamp}`} alt={t(kind === 'tournament' ? 'integrations.picturePreviewTournament' : 'integrations.picturePreviewEvening')} />}
      </div>
    </Card>
  );
}

/** Správa → Napojení ven: čtyři Discord kanály, každý s vlastním webhookem, názvem a událostmi. */
export function DiscordChannels({ channels, events, reload }: { channels: DiscordChannel[]; events: string[]; reload: () => void }) {
  return (
    <>
      <Notice>{t('integrations.discordMulti')}</Notice>
      <PicturePreview />
      {channels.map((c) => (
        <ChannelCard key={c.slot} ch={c} events={events} reload={reload} />
      ))}
    </>
  );
}
