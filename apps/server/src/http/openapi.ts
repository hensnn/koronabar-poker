import { API_ROUTES, API_SCOPES, t } from '@kb/shared';

/** Popis veřejného API ve formátu OpenAPI 3.0, sestavený z jediné tabulky tras (stejná slouží i k hlídání rozsahu). */
export function buildOpenApi(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of API_ROUTES) {
    const parameters = [
      ...(r.pathParams ?? []).map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      ...(r.query ?? []).map((q) => ({ name: q.name, in: 'query', required: false, description: t(q.description), schema: { type: 'string' } })),
    ];
    (paths[r.path] ??= {})[r.method] = {
      summary: t(r.summary),
      ...(r.scope ? { description: `${t(`api.scope.${r.scope}`)} (scope ${r.scope})`, 'x-required-scope': r.scope } : {}),
      security: [{ bearerAuth: [] }],
      ...(parameters.length ? { parameters } : {}),
      ...(r.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { type: 'object', required: r.body.map((b) => b.name), properties: Object.fromEntries(r.body.map((b) => [b.name, { type: 'string', description: t(b.description) }])) } } },
            },
          }
        : {}),
      responses: {
        '200': { description: 'OK' },
        '401': { description: t('error.API_UNAUTHORIZED') },
        '403': { description: t('error.API_SCOPE', { scope: r.scope ?? '' }) },
        '429': { description: t('error.API_RATE_LIMIT', { seconds: 60 }) },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: t('api.doc.title'), description: t('api.doc.description'), version: '1.0.0' },
    servers: [{ url: serverUrl }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: Object.keys(API_SCOPES).join(', ') } } },
    paths,
  };
}
