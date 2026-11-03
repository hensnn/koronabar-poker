import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Náhodný token pro cookie a odkazy (256 bitů, URL-safe). V DB se ukládá jen jeho hash. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Abeceda pozvánkového kódu bez zaměnitelných znaků (bez 0, O, 1, I, L). */
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Čitelný pozvánkový kód; `randomInt` dává rovnoměrné rozdělení znaků (zbytek po dělení by některé znaky zvýhodnil). */
export function inviteCode(length = 10): string {
  return Array.from({ length }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]).join('');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
