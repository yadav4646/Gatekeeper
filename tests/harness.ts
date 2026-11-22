import { createDemoHandler } from '@gatekeeper/demo-servers';
import {
  createGateway,
  parseConfig,
  type CallEvent,
  type Gateway,
  type GatewayHooks,
} from '@gatekeeper/gateway';

/**
 * In-process test harness: real demo upstreams and a real gateway, wired together with
 * a fetch shim instead of sockets. Everything on the wire is real MCP over HTTP.
 */

export const MODERN = '2026-07-28';
export const GATEWAY_URL = 'http://localhost/mcp';

export interface RecordedUpstreamRequest {
  upstream: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Harness {
  gateway: Gateway;
  events: CallEvent[];
  upstreamRequests: RecordedUpstreamRequest[];
  /** Send a raw HTTP request to the gateway's /mcp endpoint. */
  send(init: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  }): Promise<Response>;
  close(): Promise<void>;
}

export function createHarness(opts: { hooks?: Partial<GatewayHooks>; failing?: string[] } = {}): Harness {
  const upstreamHandlers = { crm: createDemoHandler('crm'), files: createDemoHandler('files') };
  const events: CallEvent[] = [];
  const upstreamRequests: RecordedUpstreamRequest[] = [];
  const failing = new Set(opts.failing ?? []);

  const upstreamFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const host = new URL(request.url).hostname.replace(/\.test$/, '') as keyof typeof upstreamHandlers;
    if (failing.has(host)) throw new TypeError('fetch failed: connect ECONNREFUSED');
    const handler = upstreamHandlers[host];
    if (!handler) throw new TypeError(`fetch failed: unknown host ${host}`);
    const text = request.method === 'POST' ? await request.clone().text() : '';
    upstreamRequests.push({
      upstream: host,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: text ? JSON.parse(text) : undefined,
    });
    return handler.fetch(request);
  };

  const config = parseConfig({
    allowInsecureUpstreams: true,
    upstreams: [
      { slug: 'crm', url: 'http://crm.test/mcp' },
      { slug: 'files', url: 'http://files.test/mcp' },
    ],
  });

  const hooks: GatewayHooks = {
    canSeeTool: () => true,
    canCallTool: () => true,
    ...opts.hooks,
    onCall: (e) => {
      events.push(e);
      opts.hooks?.onCall?.(e);
    },
  };

  const gateway = createGateway({ config, hooks, upstreamFetch });

  return {
    gateway,
    events,
    upstreamRequests,
    send: ({ method = 'POST', headers = {}, body, rawBody }) =>
      gateway.http.fetch(
        new Request(GATEWAY_URL, {
          method,
          headers: { host: 'localhost', ...headers },
          ...(method === 'POST' ? { body: rawBody ?? JSON.stringify(body) } : {}),
        }),
      ),
    close: async () => {
      await gateway.close();
      await Promise.all(Object.values(upstreamHandlers).map((h) => h.close()));
    },
  };
}

let nextId = 1;

/** A well-formed 2026-07-28 request: body `_meta` envelope plus mirrored headers. */
export function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  { version = MODERN, name }: { version?: string; name?: string } = {},
): { headers: Record<string, string>; body: Record<string, unknown> } {
  const body = {
    jsonrpc: '2.0',
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'contract-tests', version: '0.0.0' },
      },
    },
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': version,
    'mcp-method': method,
  };
  const mirrored = name ?? (typeof params.name === 'string' ? params.name : undefined);
  if (mirrored !== undefined) headers['mcp-name'] = mirrored;
  return { headers, body };
}

export interface JsonRpcReply {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** Read a JSON-RPC response from either a JSON body or an SSE stream. */
export async function readRpc(response: Response): Promise<JsonRpcReply | undefined> {
  const text = await response.text();
  if (!text) return undefined;
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const messages = text
      .split(/\n\n/)
      .map((frame) =>
        frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n'),
      )
      .filter(Boolean)
      .map((d) => JSON.parse(d) as JsonRpcReply);
    return messages.find((m) => 'result' in m || 'error' in m);
  }
  return JSON.parse(text) as JsonRpcReply;
}

/**
 * fetch for SDK clients pointed at the in-process gateway. A real HTTP client always
 * sends Host; an in-process Request does not, and the gateway's DNS-rebinding check
 * requires it.
 */
export function gatewayFetch(h: Harness) {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    headers.set('host', new URL(req.url).host);
    return h.gateway.http.fetch(new Request(req, { headers }));
  };
}

/** Upstream tools/call requests seen so far. */
export function upstreamCalls(h: Harness): RecordedUpstreamRequest[] {
  return h.upstreamRequests.filter(
    (r) => (r.body as { method?: string } | undefined)?.method === 'tools/call',
  );
}
