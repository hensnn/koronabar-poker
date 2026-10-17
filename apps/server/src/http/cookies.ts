export const SESSION_COOKIE = 'kb_session';

/** Rozparsuje hlavičku Cookie (pro Socket.IO handshake). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* poškozená hodnota se ignoruje */
    }
  }
  return out;
}
