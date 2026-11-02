import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { t } from '@kb/shared';
import { useNetSelector } from './net';
import { applyUpdate, getUpdateState, onUpdateChange } from './push';
import { Button, Notice } from './ui';

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

const isStandalone = () => typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true);
const isIos = () => typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);

/** Stav instalace aplikace: nainstalovaná, jde nainstalovat tlačítkem, nebo se na iOS instaluje ručně. */
export function useInstall(): { state: 'installed' | 'available' | 'ios' | 'unsupported'; install: () => Promise<void> } {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const state = isStandalone() ? 'installed' : deferred ? 'available' : isIos() ? 'ios' : 'unsupported';
  return {
    state,
    install: async () => {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      listeners.forEach((l) => l());
    },
  };
}

/** Karta „Nainstalovat aplikaci“ (v profilu). */
export function InstallCard() {
  const { state, install } = useInstall();
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-3">
      <h3 className="font-bold">{t('pwa.install')}</h3>
      {state === 'installed' && <p className="text-sm text-muted">{t('pwa.installed')}</p>}
      {state === 'unsupported' && <p className="text-sm text-muted">{t('pwa.installManual')}</p>}
      {state === 'available' && (
        <>
          <p className="text-sm text-muted">{t('pwa.installHelp')}</p>
          <div>
            <Button variant="primary" onClick={() => void install()}>
              {t('pwa.installButton')}
            </Button>
          </div>
        </>
      )}
      {state === 'ios' && <p className="text-sm text-muted">{t('pwa.installIos')}</p>}
      <p className="text-sm text-muted">{t('pwa.otherDevices')}</p>
    </div>
  );
}

/**
 * Pruhy o stavu spojení a verze: offline podle prohlížeče, „obnovuji spojení“ po výpadku spojení se serverem
 * a nabídka obnovit stránku, když je připravená nová verze aplikace (nepřepíná se sama, hráč si vybere kdy).
 */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const status = useNetSelector((n) => n.status);
  // „Obnovuji spojení“ jen po ztrátě už navázaného spojení, ne při prvním připojování po načtení stránky.
  const wasOnline = useRef(false);
  useEffect(() => {
    if (status === 'online') wasOnline.current = true;
  }, [status]);
  const update = useSyncExternalStore(onUpdateChange, getUpdateState);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (!online) return <Notice kind="error">{t('pwa.offline')}</Notice>;
  return (
    <>
      {status === 'connecting' && wasOnline.current && <Notice kind="warning">{t('pwa.reconnecting')}</Notice>}
      {update !== 'none' && (
        <Notice kind="warning">
          {t('pwa.updateAvailable')}{' '}
          <Button variant="primary" className="px-3" onClick={applyUpdate}>
            {t('pwa.updateReload')}
          </Button>
        </Notice>
      )}
    </>
  );
}
