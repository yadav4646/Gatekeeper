import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import type { Catalog } from './catalog.js';
import type { GatewayConfig } from './config.js';
import type { GatewayHooks } from './hooks/index.js';
import { createGatewayServer } from './mcp/server.js';

export interface GatewayHttp {
  /** Web-standard handler for the MCP endpoint. Mount it at /mcp. */
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/**
 * The MCP endpoint as a web-standard fetch function:
 *
 *   Host/Origin checks  →  SDK entry (era classification, header/body validation,
 *   protocol-version checks, JSON-RPC dispatch)  →  gateway server (catalogue, hooks,
 *   upstream routing)
 *
 * The SDK entry is deliberately validation-free for Host/Origin, so those run first.
 * Header/body validation (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, base64
 * sentinel decoding, -32020/-32022 errors) is done by the SDK before any gateway code
 * sees the request, so policy always runs on the validated body.
 */
export function createGatewayHttp(
  config: Pick<GatewayConfig, 'allowedHosts' | 'allowedOrigins'>,
  catalog: Catalog,
  hooks: GatewayHooks,
  onerror?: (error: Error) => void,
): GatewayHttp {
  const handler: McpHttpHandler = createMcpHandler(
    (ctx) =>
      createGatewayServer({
        catalog,
        hooks,
        era: ctx.era,
        caller: {
          ...(ctx.authInfo ? { authInfo: ctx.authInfo } : {}),
          ...(ctx.requestInfo ? { request: ctx.requestInfo } : {}),
        },
      }),
    {
      // 2025-era clients are served statelessly by the same factory; they cannot receive
      // server-initiated requests, which the gateway never sends anyway.
      legacy: 'stateless',
      ...(onerror ? { onerror } : {}),
    },
  );

  return {
    async fetch(request) {
      const rejected =
        hostHeaderValidationResponse(request, config.allowedHosts) ??
        originValidationResponse(request, config.allowedOrigins);
      if (rejected) return rejected;
      return handler.fetch(request);
    },
    close: () => handler.close(),
  };
}
