import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CalendarEvent {
  id: string;
  name: string;
  startAt: number;
  durationMin: number;
  description: string;
  url: string;
  registered: boolean;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Řádky ICS se zalamují po 75 bajtech (RFC 5545). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

/** Kalendář turnajů ve formátu iCalendar (jde přidat do Google Kalendáře přes odkaz). */
export function buildIcs(events: CalendarEvent[], calendarName: string): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//KoronaBar Poker//Turnaje//CS', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(calendarName)}`, 'X-WR-TIMEZONE:Europe/Prague'];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.id}@koronabar-poker`,
      `DTSTAMP:${stamp(Date.now())}`,
      `DTSTART:${stamp(e.startAt)}`,
      `DTEND:${stamp(e.startAt + e.durationMin * 60_000)}`,
      `SUMMARY:${esc((e.registered ? '✔ ' : '') + e.name)}`,
      `DESCRIPTION:${esc(e.description)}`,
      `URL:${e.url}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Odkaz na kalendář je chráněný podpisem, aby šel přidat do cizího kalendáře bez přihlášení. */
export function calendarToken(secret: Buffer, userId: string): string {
  return createHmac('sha256', secret).update('ics:' + userId).digest('hex').slice(0, 32);
}

export function checkCalendarToken(secret: Buffer, userId: string, token: string): boolean {
  const good = Buffer.from(calendarToken(secret, userId));
  const given = Buffer.from(token);
  return good.length === given.length && timingSafeEqual(good, given);
}
