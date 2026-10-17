import { desc, eq } from 'drizzle-orm';
import { t, type PermissionChecker, type SettingValues } from '@kb/shared';
import { schema, type Db } from '../db/index.js';
import { AssistantError, type AssistantService } from './service.js';
import type { TokenAuth } from '../api-tokens.js';

interface Deps {
  db: Db;
  perms: PermissionChecker;
  settings: () => SettingValues;
  assistant: () => AssistantService;
}

const PROTOCOL = '2025-03-26';

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type RpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

/** Nástroje navíc: návrh se potvrzuje druhým voláním (externí klient nemá okno s tlačítky). */
const EXTRA_TOOLS = [
  { name: 'confirm_proposal', description: 'mcp.tool.confirm', schema: { type: 'object', properties: { proposalId: { type: 'string' }, edits: { type: 'object', description: 'mcp.schema.edits' } }, required: ['proposalId'] } },
  { name: 'reject_proposal', description: 'mcp.tool.reject', schema: { type: 'object', properties: { proposalId: { type: 'string' } }, required: ['proposalId'] } },
  { name: 'list_proposals', description: 'mcp.tool.list', schema: { type: 'object', properties: {} } },
] as const;

/**
 * MCP server (Model Context Protocol, JSON-RPC přes HTTP): stejné nástroje jako asistent, přihlášení osobním tokenem
 * s rozsahem `mcp`. Návrhy změn se potvrzují druhým voláním; oprávnění, pravidla „kdy lze měnit“ a audit platí stejně.
 */
export class McpService {
  constructor(private deps: Deps) {}

  private disabled(): string[] {
    return String(this.deps.settings()['mcp.disabledTools']).split(/[\s,;]+/).filter(Boolean);
  }

  /** Nástroje, které by uživatel dostal (správa je ukazuje včetně vypnutých). */
  async tools(userId: string, includeDisabled = false) {
    const base = await this.deps.assistant().toolSpecs(userId);
    const all = [
      ...base.map((s) => ({ name: s.name, description: s.description, inputSchema: s.parameters as unknown })),
      ...EXTRA_TOOLS.map((x) => ({ name: x.name, description: t(x.description), inputSchema: translateEdits(x.schema) })),
    ];
    return includeDisabled ? all.map((x) => ({ ...x, enabled: !this.disabled().includes(x.name) })) : all.filter((x) => !this.disabled().includes(x.name));
  }

  async log(limit = 50) {
    const rows = await this.deps.db
      .select({ id: schema.mcpCalls.id, tool: schema.mcpCalls.tool, ok: schema.mcpCalls.ok, detail: schema.mcpCalls.detail, at: schema.mcpCalls.createdAt, nickname: schema.users.nickname })
      .from(schema.mcpCalls)
      .leftJoin(schema.users, eq(schema.users.id, schema.mcpCalls.userId))
      .orderBy(desc(schema.mcpCalls.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map((r) => ({ ...r, at: r.at.getTime() }));
  }

  private async record(auth: TokenAuth, tool: string, ok: boolean, detail?: string): Promise<void> {
    await this.deps.db.insert(schema.mcpCalls).values({ userId: auth.user.id, tokenId: auth.tokenId, tool, ok, detail: detail?.slice(0, 300) ?? null });
  }

  /** Zpracuje jednu zprávu JSON-RPC. Oznámení (bez id) nevrací nic. */
  async handle(auth: TokenAuth, msg: RpcRequest): Promise<RpcResponse | null> {
    const id = msg.id ?? null;
    const ok = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
    if (msg.id === undefined) return null;
    switch (msg.method) {
      case 'initialize':
        return ok({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: t('app.name'), version: '1.0.0' }, instructions: t('mcp.instructions') });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: await this.tools(auth.user.id) });
      case 'tools/call':
        return ok(await this.call(auth, String(msg.params?.name ?? ''), (msg.params?.arguments ?? {}) as Record<string, unknown>));
      default:
        return fail(-32601, 'Method not found');
    }
  }

  private async call(auth: TokenAuth, name: string, args: Record<string, unknown>) {
    const text = (s: string, isError = false) => ({ content: [{ type: 'text', text: s }], isError });
    const userId = auth.user.id;
    const available = (await this.tools(userId)).map((x) => x.name);
    if (!available.includes(name)) {
      await this.record(auth, name, false, 'NOT_AVAILABLE');
      return text(JSON.stringify({ ok: false, error: t('assistant.denied.tool', { tool: name }) }), true);
    }
    const assistant = this.deps.assistant();
    try {
      let out: string;
      if (name === 'confirm_proposal') {
        const dto = await assistant.apply(userId, String(args.proposalId ?? ''), (args.edits ?? undefined) as Record<string, string | number | boolean> | undefined, 'mcp');
        out = JSON.stringify({ ok: dto.status === 'applied', status: dto.status, summary: dto.summary, result: dto.result });
      } else if (name === 'reject_proposal') {
        out = JSON.stringify({ ok: true, status: (await assistant.reject(userId, String(args.proposalId ?? ''))).status });
      } else if (name === 'list_proposals') {
        out = JSON.stringify({ proposals: (await assistant.proposals(userId, 'pending')).map((p) => ({ id: p.id, summary: p.summary, diff: p.diff, expiresAt: p.expiresAt })) });
      } else {
        const r = await assistant.callToolExternal(userId, name, args, `${t('mcp.requestText')} ${name}`);
        out = r.text;
        if (r.proposals.length) out = JSON.stringify({ ...JSON.parse(r.text), instruction: t('mcp.confirmHint'), proposals: r.proposals.map((p) => ({ id: p.id, status: p.status, summary: p.summary, diff: p.diff })) });
      }
      await this.record(auth, name, true);
      return text(out);
    } catch (e) {
      const detail = e instanceof AssistantError ? t(`error.ASSISTANT_${e.code}`, e.params as Record<string, string>) : e instanceof Error ? e.message : 'ERROR';
      await this.record(auth, name, false, detail);
      return text(JSON.stringify({ ok: false, error: detail }), true);
    }
  }
}

function translateEdits(s: Record<string, unknown>): unknown {
  const props = (s.properties ?? {}) as Record<string, { description?: string }>;
  return { ...s, properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.description ? { ...v, description: t(v.description) } : v])) };
}
