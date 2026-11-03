import { useKeepInView } from './keep-in-view';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from './api';
import { onSocket } from './net';
import { disablePush, currentSubscription, enablePush, pushSupported } from './push';
import { Link } from './router';
import { popoverClass, popoverPlace, type PopoverPlace } from './sound-menu';

interface Item {
  id: number;
  kind: string;
  link: string | null;
  createdAt: number;
  read: boolean;
  text: string;
}

/** Přepínač push upozornění pro toto zařízení (prohlížeč se zeptá na oprávnění). */
function PushToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (pushSupported()) void currentSubscription().then((s) => setOn(!!s && Notification.permission === 'granted'));
  }, []);
  if (!pushSupported()) return <p className="text-xs text-muted">{t('push.unsupported')}</p>;
  if (on === null) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-2 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={on}
          onChange={async (e) => {
            setMsg('');
            try {
              if (e.target.checked) {
                const ok = await enablePush();
                setOn(ok);
                if (!ok) setMsg(t('push.denied'));
              } else {
                await disablePush();
                setOn(false);
              }
            } catch (err) {
              setMsg(errorText(err));
            }
          }}
        />
        {t('push.enable')}
      </label>
      {on && (
        <button
          type="button"
          className="self-start text-accent underline"
          onClick={async () => {
            setMsg('');
            try {
              const r = await post<{ devices: number; sent: number; errors: { status: number | null; message: string }[] }>('/api/push/test', {});
              if (r.devices === 0 || r.errors.some((x) => x.status === 404 || x.status === 410)) {
                // odběr zanikl: přihlásit zařízení znovu a nechat uživatele zkusit ještě jednou
                setMsg((await enablePush().catch(() => false)) ? t('push.testResubscribed') : t('push.denied'));
              } else if (r.errors.length) setMsg(t('push.testFail', { error: r.errors.map((x) => `${x.status ?? ''} ${x.message}`.trim()).join('; ') }));
              else setMsg(t('push.testOk', { sent: r.sent, devices: r.devices }));
            } catch (err) {
              setMsg(errorText(err));
            }
          }}
        >
          {t('push.test')}
        </button>
      )}
      {msg && <p className="text-muted">{msg}</p>}
    </div>
  );
}

/** Zvonek s upozorněními (turnaje…): počet nepřečtených, seznam a označení za přečtené. Nové chodí živě přes Socket.IO. */
export function NotificationBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const popRef = useKeepInView<HTMLDivElement>(open);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<PopoverPlace>({ up: false });
  const load = useCallback(() => {
    get<{ items: Item[]; unread: number }>('/api/notifications')
      .then((d) => {
        setItems(d.items);
        setUnread(d.unread);
        setError('');
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    load();
    return onSocket<Item>('notification', (n) => {
      setItems((cur) => [n, ...cur].slice(0, 50));
      setUnread((u) => u + 1);
    });
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="relative" ref={box}>
      <button className="rounded-md border border-line bg-surface px-3 py-1" aria-label={unread > 0 ? t('notifications.unread', { n: unread }) : t('notifications.title')} aria-expanded={open}
        onClick={() => {
          setPlace(popoverPlace(box.current));
          setOpen(!open);
        }}
      >
        🔔
        {unread > 0 && <span className="ml-1 rounded-full bg-danger px-1 text-xs text-on-primary">{unread}</span>}
      </button>
      {open && (
        <div ref={popRef} role="dialog" aria-label={t('notifications.title')} style={place.style} className={`${popoverClass(place.up)} z-50 flex max-h-[70vh] flex-col gap-2 overflow-hidden rounded-md border border-line bg-surface p-2 shadow-lg sm:max-h-96 sm:w-80`}>
          <div className="flex items-center justify-between">
            <strong>{t('notifications.title')}</strong>
            {unread > 0 && (
              <button
                className="text-sm underline"
                onClick={async () => {
                  await post('/api/notifications/read').catch(() => undefined);
                  setUnread(0);
                  setItems((cur) => cur.map((i) => ({ ...i, read: true })));
                }}
              >
                {t('notifications.markRead')}
              </button>
            )}
          </div>
          {error && <p className="text-danger">{error}</p>}
          {items.length === 0 && <p className="text-muted">{t('notifications.empty')}</p>}
          <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto">
            {items.map((i) => (
              <li key={i.id} className={`rounded-sm p-1 text-sm ${i.read ? 'opacity-70' : 'bg-raised'}`}>
                {i.link ? (
                  <Link to={i.link} onClick={() => setOpen(false)} className="underline">
                    {i.text}
                  </Link>
                ) : (
                  i.text
                )}
                <div className="text-xs text-muted">{new Date(i.createdAt).toLocaleString('cs-CZ')}</div>
              </li>
            ))}
          </ul>
          <PushToggle />
        </div>
      )}
    </div>
  );
}
