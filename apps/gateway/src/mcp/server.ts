import { ErrorCode, unknownToolMessage } from '@gatekeeper/protocol';
import { ProtocolError, Server } from '@modelcontextprotocol/server';
import type { CallToolResult, ListToolsResult, Tool } from '@modelcontextprotocol/server';
import type { Catalog } from '../catalog.js';
import type { CallOutcome, CallerContext, GatewayHooks } from '../hooks/index.js';
import { GATEWAY_INFO, UpstreamError } from '../upstream/connection.js';

export interface GatewayServerDeps {
  catalog: Catalog;
  hooks: GatewayHooks;
  caller: CallerContext;
  now?: () => number;
}

const INSTRUCTIONS =
  'Gatekeeper fronts several MCP servers. Tool names are namespaced as <upstream>__<tool>; ' +
  'call them exactly as listed.';

/**
 * Build the per-request MCP server the gateway exposes on /mcp.
 *
 * The low-level `Server` is used (not `McpServer`) because the tool table is dynamic:
 * it is the merged, filtered upstream catalogue, not tools registered in code.
 */
export function createGatewayServer({ catalog, hooks, caller, now = Date.now }: GatewayServerDeps): Server {
  const server = new Server(
    { ...GATEWAY_INFO },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler('tools/list', async (request): Promise<ListToolsResult> => {
    if (request.params?.cursor !== undefined) {
      // The merged list is returned in one page; any cursor is one we never issued.
      throw new ProtocolError(ErrorCode.InvalidParams, 'Invalid cursor');
    }
    const snap = await catalog.current();
    const tools: Tool[] = [];
    for (const entry of snap.table.list()) {
      if (await hooks.canSeeTool(caller, entry)) {
        tools.push({ ...entry.value.tool, name: entry.exposedName });
      }
    }
    return {
      tools,
      ttlMs: catalog.remainingTtl(snap),
      // The list is filtered per caller (from M2), so shared caches must not reuse it
      // across authorization contexts.
      cacheScope: 'private',
    };
  });

  server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
    const started = now();
    const requestedName = request.params.name;
    const args = request.params.arguments;
    let outcome: CallOutcome = 'protocol_error';
    let upstream: string | undefined;
    let upstreamTool: string | undefined;
    let errorCode: number | undefined;

    try {
      const snap = await catalog.current();
      const entry = snap.table.resolve(requestedName);
      if (!entry) {
        outcome = 'unknown_tool';
        throw new ProtocolError(ErrorCode.InvalidParams, unknownToolMessage(requestedName));
      }
      upstream = entry.slug;
      upstreamTool = entry.upstreamToolName;
      // A tool the caller may not see is reported exactly like an unknown tool.
      if (!(await hooks.canSeeTool(caller, entry)) || !(await hooks.canCallTool(caller, entry, args))) {
        outcome = 'denied';
        throw new ProtocolError(ErrorCode.InvalidParams, unknownToolMessage(requestedName));
      }

      const result = await entry.value.upstream.callTool(entry.upstreamToolName, args);
      outcome = result.isError ? 'tool_error' : 'ok';
      return stripHopMeta(result);
    } catch (err) {
      const mapped = toClientError(err);
      errorCode = mapped.code;
      if (outcome === 'protocol_error' && err instanceof UpstreamError) outcome = 'upstream_error';
      throw mapped;
    } finally {
      hooks.onCall({
        at: new Date(started).toISOString(),
        requestedName,
        ...(upstream ? { upstream } : {}),
        ...(upstreamTool ? { upstreamTool } : {}),
        outcome,
        latencyMs: now() - started,
        ...(errorCode !== undefined ? { errorCode } : {}),
      });
    }
  });

  return server;
}

/**
 * Protocol-reserved `_meta` keys (`io.modelcontextprotocol/*`, e.g. `serverInfo`) describe
 * the upstream hop. On the client hop the gateway is the server, so they are dropped:
 * otherwise the client is told the wrong server identity and learns what runs behind
 * the gateway. Other `_meta` keys are application data and pass through.
 */
export function stripHopMeta<T extends { _meta?: Record<string, unknown> }>(result: T): T {
  if (!result._meta) return result;
  const kept = Object.entries(result._meta).filter(([k]) => !k.startsWith('io.modelcontextprotocol/'));
  const { _meta: _dropped, ...rest } = result;
  return (kept.length ? { ...rest, _meta: Object.fromEntries(kept) } : rest) as T;
}

/**
 * Map internal failures to client-facing JSON-RPC errors without leaking upstream URLs
 * or stack traces. JSON-RPC errors raised by the upstream itself pass through.
 */
function toClientError(err: unknown): ProtocolError {
  if (err instanceof ProtocolError) return err;
  if (err instanceof UpstreamError) {
    return err.kind === 'timeout'
      ? new ProtocolError(ErrorCode.UpstreamTimeout, `Upstream ${err.slug} timed out`)
      : new ProtocolError(ErrorCode.UpstreamUnavailable, `Upstream ${err.slug} is unavailable`);
  }
  return new ProtocolError(ErrorCode.InternalError, 'Internal gateway error');
}
