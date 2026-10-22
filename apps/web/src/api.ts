import { t } from '@kb/shared';
import { viewAs } from './view-as';

/** Chyba z API: kód a parametry; text se překládá až při zobrazení. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly params?: Record<string, unknown>,
  ) {
    super(code);
  }
}

/** Srozumitelná česká hláška k chybě (chybí-li překlad, vrátí obecnou). */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    // Osobní limit: zpráva podle toho, který limit hráče zastavil, včetně času uvolnění.
    if (e.code === 'LIMIT_REACHED' && e.params?.kind) {
      const reset = typeof e.params.resetsAt === 'number' ? new Date(e.params.resetsAt).toLocaleString() : '';
      const p = { ...e.params, until: e.params.kind === 'break' ? reset : reset ? ` ${t('limits.resets', { time: reset })}` : '' };
      return t(`error.LIMIT_REACHED.${String(e.params.kind)}`, p);
    }
    const key = `error.${e.code}`;
    const msg = t(key, e.params);
    if (msg !== key) return msg;
    // kód s předponou (SETTINGS_INVALID, TABLE_INVALID…): nabídne první konkrétní problém
    const issues = (e.params?.issues as { messageKey: string; params?: Record<string, unknown> }[] | undefined) ?? [];
    if (issues[0]) return t(issues[0].messageKey, issues[0].params);
    return t('error.UNKNOWN');
  }
  return t('error.NETWORK');
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const as = viewAs();
  // V zobrazení jako jiný uživatel se nic neukládá; server to navíc hlídá sám.
  if (as && method !== 'GET') throw new ApiError(403, 'VIEW_AS_READONLY');
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(as ? { 'x-view-as': as.id } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as { code?: string; error?: string; params?: Record<string, unknown> }) : undefined;
  if (!res.ok) throw new ApiError(res.status, json?.code ?? json?.error ?? 'UNKNOWN', json?.params);
  return json as T;
}

export const get = <T = unknown>(url: string) => api<T>('GET', url);
export const post = <T = unknown>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const put = <T = unknown>(url: string, body?: unknown) => api<T>('PUT', url, body ?? {});
export const patch = <T = unknown>(url: string, body?: unknown) => api<T>('PATCH', url, body ?? {});
export const del = <T = unknown>(url: string) => api<T>('DELETE', url);
