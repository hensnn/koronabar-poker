import { useEffect, useRef, useState } from 'react';
import { t } from '@kb/shared';
import { onSocket, announceRoom } from '../net';
import { useSettings, saveUserSetting } from '../settings';
import { AnnouncerPlayer, type AnnounceItem, type PlayerNotice, type PlayerPrefs } from './engine';

let noticeSink: (n: PlayerNotice) => void = () => undefined;
const player = new AnnouncerPlayer((n) => noticeSink(n));

/** Osobní nastavení hlasatele z hodnot nastavení (společné i hráčovy). */
export function usePrefs(): PlayerPrefs {
  const { values } = useSettings();
  const global = String(values['announcer.source'] ?? 'browser');
  const allowUser = values['announcer.allowUserChoice'] !== false;
  return {
    enabled: values['announcer.enabled'] !== false && values['announcer.mute'] !== true,
    browserOnly: global === 'browser' || (allowUser && values['announcer.userBrowserOnly'] === true),
    volume: (Number(values['announcer.volumePercent'] ?? 80) / 100) * (Number(values['announcer.userVolumePercent'] ?? 100) / 100),
    rate: Number(values['announcer.ratePercent'] ?? 100) / 100,
    voiceName: String(values['announcer.userVoice'] ?? ''),
    audioUrl: (id) => `/api/announcer/audio/${id}`,
  };
}

/** Přijímá hlášky hlasatele ze serveru a čte je; nabízí rychlé ztlumení a upozornění, že zařízení nemá český hlas. */
export function AnnouncerHost() {
  const prefs = usePrefs();
  const ref = useRef(prefs);
  ref.current = prefs;
  const settings = useSettings();
  const [notice, setNotice] = useState<PlayerNotice>(null);

  useEffect(() => {
    noticeSink = setNotice;
    const unlock = () => player.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    const off = onSocket<AnnounceItem>('announce', (item) => player.enqueue(item, ref.current));
    return () => {
      off();
      noticeSink = () => undefined;
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    if (!prefs.enabled) player.stop();
  }, [prefs.enabled]);

  if (settings.values['announcer.enabled'] === false) return null;
  const muted = settings.values['announcer.mute'] === true;
  return (
    <>
      <button
        type="button"
        className="rounded-md border border-line bg-surface px-3 py-1"
        aria-pressed={muted}
        title={t(muted ? 'announcer.muteOn' : 'announcer.muteOff')}
        onClick={() => void saveUserSetting('announcer.mute', !muted).catch(() => undefined)}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      {notice === 'noVoice' && !muted && (
        <button type="button" className="fixed bottom-3 right-3 z-30 max-w-sm rounded-md border border-line bg-surface px-3 py-2 text-left shadow-lg" onClick={() => setNotice(null)}>
          {t('announcer.noCzechVoice')}
        </button>
      )}
    </>
  );
}

/** Stránka, která chce hlášky konkrétního stolu nebo turnaje, se přihlásí do jeho místnosti. */
export function useAnnounceRoom(id: string | null): void {
  useEffect(() => {
    if (!id) return;
    announceRoom.join(id);
    return () => announceRoom.leave(id);
  }, [id]);
}

