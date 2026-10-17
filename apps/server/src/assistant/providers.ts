import type { AiProviderId, JsonSchema } from '@kb/shared';

/** Neutrální tvar konverzace; každý adaptér ho převede na formát svého poskytovatele. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Data poskytovatele, která se musí poslat zpět (Gemini: thoughtSignature). */
  meta?: Record<string, unknown>;
}

export type ChatMsg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface CompletionRequest {
  model: string;
  system: string;
  messages: ChatMsg[];
  tools: ToolSpec[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  tokens: number;
}

export interface AiProvider {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class ProviderError extends Error {
  constructor(
    public detail: string,
    public status: number | null = null,
  ) {
    super(detail);
  }
}

interface Options {
  apiKey: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

async function post(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new ProviderError('BAD_RESPONSE', res.status);
    }
    if (res.status < 200 || res.status >= 300) throw new ProviderError(String(json?.error?.message ?? json?.error ?? `HTTP ${res.status}`).slice(0, 200), res.status);
    return json;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (e instanceof Error && e.name === 'AbortError') throw new ProviderError('TIMEOUT');
    throw new ProviderError(e instanceof Error ? e.message.slice(0, 200) : 'ERROR');
  } finally {
    clearTimeout(timer);
  }
}

/** Gemini vyžaduje typy velkými písmeny. */
function geminiSchema(s: JsonSchema): unknown {
  return {
    type: s.type.toUpperCase(),
    ...(s.description ? { description: s.description } : {}),
    ...(s.enum ? { enum: [...s.enum] } : {}),
    ...(s.properties ? { properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, geminiSchema(v)])) } : {}),
    ...(s.required?.length ? { required: s.required } : {}),
    ...(s.items ? { items: geminiSchema(s.items) } : {}),
  };
}

function gemini(o: Options): AiProvider {
  const f = o.fetcher ?? fetch;
  return {
    async complete(r) {
      const contents: unknown[] = [];
      for (const m of r.messages) {
        if (m.role === 'user') contents.push({ role: 'user', parts: [{ text: m.content }] });
        else if (m.role === 'assistant')
          contents.push({
            role: 'model',
            parts: [
              ...(m.content ? [{ text: m.content }] : []),
              // Gemini 3 vyžaduje vrátit thoughtSignature u každého functionCall, jinak volání nástrojů odmítne.
              ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.args }, ...(c.meta?.thoughtSignature ? { thoughtSignature: c.meta.thoughtSignature } : {}) })),
            ],
          });
        else contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name, response: { result: m.content } } }] });
      }
      const body = {
        systemInstruction: { parts: [{ text: r.system }] },
        contents,
        ...(r.tools.length ? { tools: [{ functionDeclarations: r.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }] } : {}),
        generationConfig: { temperature: r.temperature, maxOutputTokens: r.maxTokens },
      };
      const j = await post(f, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(r.model)}:generateContent`, { 'x-goog-api-key': o.apiKey }, body, r.timeoutMs);
      const parts: any[] = j.candidates?.[0]?.content?.parts ?? [];
      return {
        // části označené jako „thought“ jsou interní uvažování modelu, uživateli se neukazují
        text: parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join(''),
        toolCalls: parts
          .filter((p) => p.functionCall)
          .map((p, i) => ({ id: `g${i}-${p.functionCall.name}`, name: String(p.functionCall.name), args: (p.functionCall.args ?? {}) as Record<string, unknown>, ...(p.thoughtSignature ? { meta: { thoughtSignature: p.thoughtSignature } } : {}) })),
        tokens: Number(j.usageMetadata?.totalTokenCount ?? 0),
      };
    },
  };
}

function anthropic(o: Options): AiProvider {
  const f = o.fetcher ?? fetch;
  return {
    async complete(r) {
      const messages: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
      const push = (role: 'user' | 'assistant', block: unknown) => {
        const last = messages[messages.length - 1];
        if (last && last.role === role) last.content.push(block);
        else messages.push({ role, content: [block] });
      };
      for (const m of r.messages) {
        if (m.role === 'user') push('user', { type: 'text', text: m.content });
        else if (m.role === 'assistant') {
          if (m.content) push('assistant', { type: 'text', text: m.content });
          for (const c of m.toolCalls ?? []) push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.args });
        } else push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
      }
      const body = {
        model: r.model,
        max_tokens: r.maxTokens,
        temperature: r.temperature,
        system: r.system,
        messages,
        ...(r.tools.length ? { tools: r.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
      };
      const j = await post(f, 'https://api.anthropic.com/v1/messages', { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' }, body, r.timeoutMs);
      const blocks: any[] = j.content ?? [];
      return {
        text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
        toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), args: (b.input ?? {}) as Record<string, unknown> })),
        tokens: Number(j.usage?.input_tokens ?? 0) + Number(j.usage?.output_tokens ?? 0),
      };
    },
  };
}

function openai(o: Options, base: string): AiProvider {
  const f = o.fetcher ?? fetch;
  return {
    async complete(r) {
      const messages: unknown[] = [{ role: 'system', content: r.system }];
      for (const m of r.messages) {
        if (m.role === 'user') messages.push({ role: 'user', content: m.content });
        else if (m.role === 'assistant') {
          messages.push({
            role: 'assistant',
            content: m.content || null,
            ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
          });
        } else messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      }
      const body = {
        model: r.model,
        messages,
        temperature: r.temperature,
        max_tokens: r.maxTokens,
        ...(r.tools.length ? { tools: r.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
      };
      const headers: Record<string, string> = o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {};
      const j = await post(f, `${base.replace(/\/+$/, '')}/chat/completions`, headers, body, r.timeoutMs);
      const msg = j.choices?.[0]?.message ?? {};
      return {
        text: typeof msg.content === 'string' ? msg.content : '',
        toolCalls: (msg.tool_calls ?? []).map((c: any) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(c.function?.arguments || '{}');
          } catch {
            args = {};
          }
          return { id: String(c.id), name: String(c.function?.name), args };
        }),
        tokens: Number(j.usage?.total_tokens ?? 0),
      };
    },
  };
}

export function createProvider(id: AiProviderId, o: Options): AiProvider {
  switch (id) {
    case 'gemini':
      return gemini(o);
    case 'anthropic':
      return anthropic(o);
    case 'openai':
      return openai(o, 'https://api.openai.com/v1');
    case 'compatible':
      if (!o.baseUrl) throw new ProviderError('NO_BASE_URL');
      return openai(o, o.baseUrl);
  }
}
