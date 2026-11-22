import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, FetchLike, ListToolsResult, Tool } from '@modelcontextprotocol/client';
import type { UpstreamConfig } from '../config.js';

export const GATEWAY_INFO = { name: 'gatekeeper', version: '0.1.0' } as const;
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

export interface UpstreamToolList {
  tools: Tool[];
  /** ttlMs advertised by the upstream, if any. */
  ttlMs: number | undefined;
}

export class UpstreamError extends Error {
  constructor(
    readonly slug: string,
    readonly kind: 'unavailable' | 'timeout',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'UpstreamError';
  }
}

/**
 * One logical connection to an upstream MCP server.
 *
 * On the 2026-07-28 revision an SDK `Client` holds no protocol session: each call is an
 * independent HTTP POST. Keeping one `Client` per upstream only retains the era verdict
 * and the discovered capabilities, so the gateway stays horizontally scalable.
 *
 * M1 pins the modern revision. Legacy (2025-era) upstreams are added in M5 via
 * `versionNegotiation: { mode: 'auto' }` plus an internal session pool.
 */
export class UpstreamConnection {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;

  constructor(
    readonly config: UpstreamConfig,
    private readonly fetchImpl?: FetchLike,
  ) {}

  get slug(): string {
    return this.config.slug;
  }

  private headers(): Record<string, string> {
    const auth = this.config.auth;
    if (auth.type === 'bearer') {
      const token = process.env[auth.tokenEnv];
      if (!token) throw new UpstreamError(this.slug, 'unavailable', `env ${auth.tokenEnv} is not set`);
      return { authorization: `Bearer ${token}` };
    }
    return {};
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const client = new Client(
        { ...GATEWAY_INFO },
        { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: { headers: this.headers() },
        // Never let an upstream redirect the gateway to another origin (SSRF).
        redirectPolicy: 'same-origin',
        ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      });
      try {
        await client.connect(transport, { timeout: this.config.timeoutMs });
      } catch (err) {
        throw this.wrap(err, 'connect');
      }
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async listTools(): Promise<UpstreamToolList> {
    const client = await this.getClient();
    let result: ListToolsResult;
    try {
      // The gateway owns caching of the merged catalogue, so always fetch fresh here.
      result = await client.listTools(undefined, { cacheMode: 'refresh', timeout: this.config.timeoutMs });
    } catch (err) {
      throw this.wrap(err, 'tools/list');
    }
    const ttl = (result as { ttlMs?: unknown }).ttlMs;
    return { tools: result.tools, ttlMs: typeof ttl === 'number' && ttl >= 0 ? ttl : undefined };
  }

  /**
   * Forward a tool call. The SDK client mirrors `Mcp-Method`, `Mcp-Name` and any
   * `x-mcp-header` parameters from the upstream's own tool definition, so header/body
   * consistency on the upstream leg comes from the same code that validates it.
   */
  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const client = await this.getClient();
    try {
      return await client.callTool(
        { name, ...(args ? { arguments: args } : {}) },
        { timeout: this.config.timeoutMs },
      );
    } catch (err) {
      throw this.wrap(err, 'tools/call');
    }
  }

  /** Errors that are already JSON-RPC errors from the upstream pass through unchanged. */
  private wrap(err: unknown, op: string): unknown {
    if (err instanceof ProtocolError) return err;
    const message = err instanceof Error ? err.message : String(err);
    const kind = /timed? ?out|timeout/i.test(message) ? 'timeout' : 'unavailable';
    return new UpstreamError(this.slug, kind, `upstream ${this.slug} ${op} failed: ${message}`, {
      cause: err,
    });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close();
  }
}
