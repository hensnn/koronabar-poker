/**
 * Veřejné REST API (/api/v1) a osobní přístupové tokeny. Rozsah tokenu je podmnožina těchto scope; navíc token
 * nikdy nesmí víc než jeho majitel: každý scope má oprávnění, které majitel musí mít i při každém volání.
 */
export const API_SCOPES = {
  'tournaments:read': { permission: 'stul.zobrazit' },
  'tournaments:register': { permission: 'turnaj.hrat' },
  'stats:read': { permission: 'stul.zobrazit' },
  'wallet:read': { permission: null },
  'evenings:read': { permission: 'stul.zobrazit' },
  'chat:write': { permission: 'chat.psat' },
  mcp: { permission: 'asistent.mcp' },
} as const satisfies Record<string, { permission: string | null }>;
export type ApiScope = keyof typeof API_SCOPES;
export const API_SCOPE_LIST = Object.keys(API_SCOPES) as ApiScope[];
export const isApiScope = (s: string): s is ApiScope => s in API_SCOPES;

export const TOKEN_PREFIX = 'kbp_';

export interface ApiRouteDef {
  method: 'get' | 'post';
  path: string;
  /** Scope, který token musí mít (prázdné = stačí platný token). */
  scope: ApiScope | null;
  /** Klíč překladu s popisem. */
  summary: string;
  query?: { name: string; description: string }[];
  pathParams?: string[];
  body?: { name: string; description: string }[];
}

export const API_ROUTES: ApiRouteDef[] = [
  { method: 'get', path: '/api/v1/me', scope: null, summary: 'api.route.me' },
  { method: 'get', path: '/api/v1/tournaments', scope: 'tournaments:read', summary: 'api.route.tournaments' },
  { method: 'get', path: '/api/v1/tournaments/{id}', scope: 'tournaments:read', summary: 'api.route.tournament', pathParams: ['id'] },
  { method: 'post', path: '/api/v1/tournaments/{id}/register', scope: 'tournaments:register', summary: 'api.route.register', pathParams: ['id'] },
  { method: 'get', path: '/api/v1/seasons', scope: 'stats:read', summary: 'api.route.seasons' },
  { method: 'get', path: '/api/v1/leaderboard', scope: 'stats:read', summary: 'api.route.leaderboard', query: [{ name: 'season', description: 'api.param.season' }] },
  { method: 'get', path: '/api/v1/stats/me', scope: 'stats:read', summary: 'api.route.statsMe', query: [{ name: 'season', description: 'api.param.season' }] },
  { method: 'get', path: '/api/v1/wallet', scope: 'wallet:read', summary: 'api.route.wallet' },
  { method: 'get', path: '/api/v1/evenings', scope: 'evenings:read', summary: 'api.route.evenings' },
  { method: 'post', path: '/api/v1/chat/messages', scope: 'chat:write', summary: 'api.route.chat', body: [{ name: 'text', description: 'api.param.text' }] },
];
