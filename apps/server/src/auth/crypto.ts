import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Náhodný token pro cookie a odkazy (256 bitů, URL-safe). V DB se ukládá jen jeho hash. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Čitelný pozvánkový kód bez zaměnitelných znaků (bez 0, O, 1, I, L). */
export function inviteCode(length = 10): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
