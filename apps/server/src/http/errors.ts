import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { LedgerError, LedgerGuardError } from '@kb/ledger';
import { AccountError } from '../auth/accounts.js';
import { PermissionError } from '../auth/permissions.js';
import { SecretError } from '../secrets/store.js';
import { SettingsError } from '../settings-store.js';
import { TournamentError } from '@kb/game-core';
import { TableError } from '../tables.js';
import { TemplateError } from '../templates.js';

const STATUS: Record<string, number> = {
  INVALID_CREDENTIALS: 401,
  LOCKED: 429,
  RATE_LIMITED: 429,
  FORBIDDEN: 403,
  HIERARCHY: 403,
  LOCKED_ROLE: 403,
  EXCEEDS_OWN_PERMISSIONS: 403,
  LIMIT_EXCEEDED: 403,
  NOT_FOUND: 404,
  INVALID_TOKEN: 400,
  NICKNAME_TAKEN: 409,
  EMAIL_TAKEN: 409,
  DUPLICATE_KEY: 409,
  ROLE_IN_USE: 409,
  LAST_MAIN_ADMIN: 409,
};

/** Převede doménovou chybu na odpověď `{ code, params }`; text se překládá až v klientovi. */
export function sendError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof ZodError) return reply.status(400).send({ code: 'INVALID_INPUT', params: { issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  if (e instanceof AccountError || e instanceof PermissionError) return reply.status(STATUS[e.code] ?? 400).send({ code: e.code, params: e.params });
  if (e instanceof SettingsError) return reply.status(e.code === 'FORBIDDEN' ? 403 : 400).send({ code: `SETTINGS_${e.code}`, params: { issues: e.issues, reasonKey: e.reasonKey } });
  if (e instanceof SecretError) return reply.status(e.code === 'FORBIDDEN' ? 403 : 400).send({ code: 'SECRET_' + e.code });
  if (e instanceof Error && e.message === 'FORBIDDEN') return reply.status(403).send({ code: 'FORBIDDEN' });
  if (e instanceof TableError) return reply.status(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400).send({ code: 'TABLE_' + e.code, params: { issues: e.issues, ...e.params } });
  if (e instanceof TemplateError) return reply.status(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : e.code === 'IN_USE' || e.code === 'BUILTIN' ? 409 : 400).send({ code: 'TEMPLATE_' + e.code, params: { issues: e.issues } });
  if (e instanceof TournamentError) return reply.status(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : e.code === 'LIMIT_EXCEEDED' ? 403 : e.code === 'INSUFFICIENT_FUNDS' ? 409 : 400).send({ code: 'TOURNAMENT_' + e.code, params: e.context });
  if (e instanceof LedgerError) return reply.status(409).send({ code: e.code, ...(e instanceof LedgerGuardError ? { params: e.params } : {}) });
  reply.log.error(e);
  return reply.status(500).send({ code: 'UNKNOWN' });
}
