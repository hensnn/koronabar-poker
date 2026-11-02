import { get, post } from './api';

/** Web push v prohlížeči: podpora, stav oprávnění a přihlášení/odhlášení tohoto zařízení. */
export const pushSupported = (): boolean => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/**
 * Nová verze aplikace: `waiting` = nový service worker je nainstalovaný a čeká na pokyn, `activated` = stránku už řídí
 * nový worker (převzal ji jiná záložka). Stránka se nikdy nepřepne sama; hráč dostane nabídku obnovit, až se mu to hodí.
 */
export type UpdateState = 'none' | 'waiting' | 'activated';
let updateState: UpdateState = 'none';
let waitingWorker: ServiceWorker | null = null;
// Obnovení jsme si vyžádali tlačítkem: po převzetí novým workerem se stránka načte znovu.
let applying = false;
let watched = false;
const updateListeners = new Set<() => void>();

const setUpdate = (next: UpdateState, worker: ServiceWorker | null) => {
  updateState = next;
  waitingWorker = worker;
  updateListeners.forEach((l) => l());
};

export function onUpdateChange(l: () => void): () => void {
  updateListeners.add(l);
  return () => void updateListeners.delete(l);
}

export const getUpdateState = (): UpdateState => updateState;

/** Hráč chce novou verzi hned: čekající worker převezme stránku a ta se načte znovu. */
export function applyUpdate(): void {
  if (updateState === 'waiting' && waitingWorker) {
    applying = true;
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    return;
  }
  window.location.reload();
}

function watchUpdates(reg: ServiceWorkerRegistration): void {
  if (watched) return;
  watched = true;
  const controlled = () => !!navigator.serviceWorker.controller;
  const track = (w: ServiceWorker | null) => {
    if (!w) return;
    w.addEventListener('statechange', () => {
      // Nainstalovaný worker při už řízené stránce = nová verze; při první návštěvě jde o první instalaci, ne o aktualizaci.
      if (w.state === 'installed' && controlled()) setUpdate('waiting', w);
    });
  };
  if (reg.waiting && controlled()) setUpdate('waiting', reg.waiting);
  track(reg.installing);
  reg.addEventListener('updatefound', () => track(reg.installing));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (applying) {
      window.location.reload();
      return;
    }
    // Převzetí bez naší žádosti (jiná záložka): staré soubory už nemusí být k dispozici, nabídne se obnovení.
    if (controlled()) setUpdate('activated', null);
  });
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    watchUpdates(reg);
    return reg;
  } catch {
    return null;
  }
}

const toKey = (b64: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '='));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registerServiceWorker();
  return reg ? await (await navigator.serviceWorker.ready).pushManager.getSubscription() : null;
}

/** Vyžádá oprávnění, přihlásí zařízení u push služby a odběr uloží na server. Vrací false, když uživatel oprávnění odmítl. */
export async function enablePush(): Promise<boolean> {
  if (!pushSupported()) return false;
  if ((await Notification.requestPermission()) !== 'granted') return false;
  await registerServiceWorker();
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await get<{ publicKey: string }>('/api/push/key');
  // Vždy čerstvý odběr: starý mohl push služba mezitím zrušit (410) nebo patřit k jinému klíči serveru.
  await (await reg.pushManager.getSubscription())?.unsubscribe().catch(() => undefined);
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
  await post('/api/push/subscribe', sub.toJSON());
  return true;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}
